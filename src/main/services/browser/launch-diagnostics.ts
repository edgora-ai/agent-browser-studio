import * as fs from "node:fs";
import * as path from "node:path";

export interface ChromiumDiagnosticNetLogRequest {
  appDataDir?: string;
  filePath?: string;
  /** Only fixed 20s/90s direct-FD diagnostics are supported; omission retains bounded logging. */
  mode?: string;
}

function invalid(reason: string): Error {
  return new Error(`Invalid Chromium diagnostic NetLog: ${reason}`);
}

function absolutePath(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) {
    throw invalid(`${name} must be an explicit absolute filesystem path`);
  }
  return path.resolve(value);
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("diagnostic directory must not be a link or file");
  if (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
    throw invalid("diagnostic directories must be owned by this user and not writable by others");
  }
}

function assertTrustedAncestry(directory: string): void {
  if (!process.getuid) return; // POSIX mode/owner checks do not certify platform ACLs.
  const uid = process.getuid();
  const trusted = (owner: number) => owner === uid || owner === 0;
  let entry = directory;
  let entryStat = fs.lstatSync(entry);
  for (;;) {
    const parent = path.dirname(entry);
    if (parent === entry) return;
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trusted(stat.uid)) {
      throw invalid("diagnostic ancestry is not owned by a trusted user");
    }
    const stickyProtectsEntry = (stat.mode & 0o1000) !== 0 && trusted(entryStat.uid);
    if ((stat.mode & 0o022) !== 0 && !stickyProtectsEntry) throw invalid("unsafe writable ancestor");
    entry = parent;
    entryStat = stat;
  }
}

/** Explicit diagnostics only; Chromium's logging warning must remain visible. */
export function prepareChromiumDiagnosticNetLogArgs(
  appDataDir: string,
  request: ChromiumDiagnosticNetLogRequest,
): string[] {
  if (request.mode !== undefined && request.mode !== "direct-fd-20s" && request.mode !== "direct-fd-90s") throw invalid("mode must be direct-fd-20s, direct-fd-90s or omitted");
  if (request.appDataDir === undefined && request.filePath === undefined && request.mode === undefined) return [];
  const scope = absolutePath(request.appDataDir, "appDataDir");
  const requested = absolutePath(request.filePath, "filePath");
  const currentRoot = fs.realpathSync(appDataDir);
  if (fs.realpathSync(scope) !== currentRoot) throw invalid("scope does not match this application's userData");
  assertPrivateDirectory(currentRoot);
  assertTrustedAncestry(currentRoot);
  if (path.dirname(requested) !== path.join(scope, "diagnostics")) {
    throw invalid("output must be directly inside the scoped userData diagnostics directory");
  }
  const basename = path.basename(requested);
  if (!/^[a-z0-9][a-z0-9._-]{0,95}\.netlog\.json$/.test(basename)) {
    throw invalid("output must have a bounded diagnostic .netlog.json filename");
  }
  const directory = path.join(currentRoot, "diagnostics");
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(directory);
  const output = path.join(directory, basename);
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1) throw invalid("new output is not an empty regular file");
    if (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()))) {
      throw invalid("new output must be owned by this user with mode 0600");
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return [
    `--log-net-log=${output}`,
    "--net-log-capture-mode=Default",
    "--net-log-file-format=json",
    // Direct-FD avoids NetworkService's bounded-log scratch directory. It has
    // NO native size cap; the explicit diagnostic caller must supervise size.
    ...(request.mode !== undefined ? [request.mode === "direct-fd-20s" ? "--net-log-duration=20" : "--net-log-duration=90"] : [
      "--net-log-max-size-mb=64",
      "--net-log-duration=180",
    ]),
  ];
}
