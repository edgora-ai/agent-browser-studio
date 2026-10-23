// CI-only observations from newly created synthetic files, never app/user data.
import * as fs from "node:fs";
import * as path from "node:path";

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
      pathAfter: fields(fs.lstatSync(file)), beforeBig, openedBig, directorySync,
      firstCreated: typeof first === "string" ? path.relative(root, first) : null,
      expectedFirstCreated: path.relative(root, path.dirname(created)),
      mkdirBoundaryEquivalent: typeof first === "string" && path.relative(first, path.dirname(created)) === "" };
    console.log("::notice title=Owned filesystem metadata::" + JSON.stringify(facts));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    const current = fs.lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Owned metadata fixture changed");
    fs.rmSync(root, { recursive: true });
  }
}
