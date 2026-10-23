// CI-only observations from newly created synthetic files, never app/user data.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP || !process.env.TMPDIR) {
  throw new Error("This diagnostic requires the owned CI temporary directory");
}
const runner = fs.realpathSync(process.env.RUNNER_TEMP);
const primaryStat = fs.lstatSync(process.env.TMPDIR);
if (!primaryStat.isDirectory() || primaryStat.isSymbolicLink()) throw new Error("Unsafe CI temporary directory");
const primary = fs.realpathSync(process.env.TMPDIR), relative = path.relative(runner, primary);
if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("CI temporary directory escaped its runner root");
const roots = [{ label: "runner-temp", directory: primary }];
if (process.platform === "win32" && process.env.LOCALAPPDATA) {
  const directory = path.join(process.env.LOCALAPPDATA, "Temp");
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat?.isDirectory() && !stat.isSymbolicLink()) roots.push({ label: "local-app-temp", directory });
}
const fields = stat => Object.fromEntries(["dev", "ino", "size", "mode", "nlink", "uid", "gid", "mtimeMs", "ctimeMs", "birthtimeMs"].map(key => [key, stat[key]]));
const identity = stat => Object.fromEntries(["dev", "ino", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));
const incompatible = [];
function inspectTarClient(root) {
  const source = path.join(root, "tar-source"), output = path.join(root, "tar-output");
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 });
  const payload = Buffer.from("owned native tar fixture\n");
  fs.writeFileSync(path.join(source, "owned.txt"), payload, { flag: "wx", mode: 0o600 });
  const options = { cwd: output, timeout: 5000, maxBuffer: 16 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const version = spawnSync("tar", ["--version"], options);
  const variants = [true, false].map((noXattrs) => {
    const archive = noXattrs ? "with-no-xattrs.tgz" : "without-no-xattrs.tgz";
    // A relative archive argument cannot be parsed as a remote host/drive.
    // Only the invented source directory is read; no app files or links exist.
    const result = spawnSync("tar", [...(noXattrs ? ["--no-xattrs"] : []), "--format", "ustar", "-czf", archive, "-C", source, "--exclude", "LOCK", "."], options);
    let payloadReadbackFound = false, verificationError = null;
    if (result.status === 0) {
      try {
        const file = path.join(output, archive), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("Invalid owned tar output");
        const bytes = gunzipSync(fs.readFileSync(file), { maxOutputLength: 64 * 1024 });
        payloadReadbackFound = bytes.includes(payload) && bytes.includes(Buffer.from("owned.txt"));
      } catch (error) { verificationError = error.code || "INVALID_OUTPUT"; }
    }
    return { noXattrs, archiveArgument: "relative", status: result.status, signal: result.signal,
      errorCode: result.error?.code || null, optionRejected: /unknown option|unrecognized option|unsupported option|option.*not supported/i.test(result.stderr || ""), payloadReadbackFound, verificationError };
  });
  console.log("::notice title=Owned tar client::" + JSON.stringify({ probe: "owned-tar-client", node: process.version,
    versionStatus: version.status, versionErrorCode: version.error?.code || null,
    version: (version.stdout || "").split(/\r?\n/)[0].slice(0, 160), variants }));
}
for (const { label, directory } of roots) {
  const root = fs.mkdtempSync(path.join(directory, "metadata-probe-"));
  const owner = fs.lstatSync(root), file = path.join(root, "owned.bin");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, "owned metadata fixture"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const before = fields(fs.lstatSync(file));
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fields(fs.fstatSync(fd));
    const beforeBig = identity(fs.lstatSync(file, { bigint: true })), openedBig = identity(fs.fstatSync(fd, { bigint: true }));
    if (fs.readFileSync(fd).toString("utf8") !== "owned metadata fixture") throw new Error("Owned fixture readback changed");
    let readOnlyFileSync;
    try { fs.fsyncSync(fd); readOnlyFileSync = { confirmed: true }; }
    catch (error) { readOnlyFileSync = { confirmed: false, code: error.code, syscall: error.syscall }; }
    const after = fields(fs.fstatSync(fd));
    fs.closeSync(fd); fd = undefined;
    const created = path.join(root, "created", "profile"), first = fs.mkdirSync(created, { recursive: true });
    let directorySync;
    try {
      fd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      fs.fsyncSync(fd); directorySync = { confirmed: true };
    } catch (error) { directorySync = { confirmed: false, code: error.code, syscall: error.syscall }; }
    finally { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } }
    const facts = { probe: "owned-filesystem", node: process.version, label, before, opened, after,
      pathAfter: fields(fs.lstatSync(file)), beforeBig, openedBig, directorySync, readOnlyFileSync,
      firstCreated: typeof first === "string" ? path.relative(root, first) : null,
      expectedFirstCreated: path.relative(root, path.dirname(created)),
      mkdirBoundaryEquivalent: typeof first === "string" && path.relative(first, path.dirname(created)) === "",
      normalizedMkdirBoundaryEquivalent: typeof first === "string" && path.relative(path.toNamespacedPath(first), path.toNamespacedPath(path.dirname(created))) === "" };
    console.log("::notice title=Owned filesystem metadata::" + JSON.stringify(facts));
    if (["dev", "ino", "size"].some(key => before[key] !== opened[key] || before[key] !== after[key] || before[key] !== facts.pathAfter[key]) ||
        beforeBig.dev !== openedBig.dev || beforeBig.ino !== openedBig.ino) incompatible.push(label);
    if (label === "runner-temp") inspectTarClient(root);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    const current = fs.lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Owned metadata fixture changed");
    fs.rmSync(root, { recursive: true });
  }
}
if (incompatible.length) throw new Error("Path/descriptor identity is inconsistent on the supported CI runtime: " + incompatible.join(", "));
