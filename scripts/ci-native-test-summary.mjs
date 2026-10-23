// CI-only scalar receipt from a completed, owned Vitest JSON report. Never
// publish failure messages, stdout, application state, or absolute host paths.
import * as fs from "node:fs";
import * as path from "node:path";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP || !process.env.TMPDIR) throw new Error("Owned CI environment is required");
const rootStat = fs.lstatSync(process.env.TMPDIR);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe CI report directory");
const root = fs.realpathSync(process.env.TMPDIR), runner = fs.realpathSync(process.env.RUNNER_TEMP);
const relative = path.relative(runner, root);
if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("CI report root is outside its owned runner subtree");
const file = path.resolve(process.argv[2] || ""), fullSuite = process.argv[3] === "all";
const reportName = fullSuite ? "unit-smoke.json" : "native-recovery.json";
if (path.relative(path.toNamespacedPath(root), path.toNamespacedPath(file)) !== reportName) throw new Error("Unexpected CI report path");
const expectedFiles = fullSuite ? null : Number(process.argv[3]);
if (!fullSuite && (!Number.isSafeInteger(expectedFiles) || expectedFiles < 1 || expectedFiles > 64)) throw new Error("A bounded expected module count is required");
const before = fs.lstatSync(file), limit = (fullSuite ? 32 : 8) * 1024 * 1024;
if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > limit) throw new Error("Unsafe or oversized CI report");
const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink", "mode"].every(key => a[key] === b[key]);
const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
let bytes;
try {
  if (!same(before, fs.fstatSync(fd))) throw new Error("CI report changed before read");
  bytes = Buffer.alloc(before.size);
  for (let at = 0; at < bytes.length;) {
    const count = fs.readSync(fd, bytes, at, bytes.length - at, at);
    if (count <= 0) throw new Error("Short CI report read");
    at += count;
  }
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0 || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(file))) throw new Error("CI report changed during read");
} finally { fs.closeSync(fd); }
const afterRoot = fs.lstatSync(root);
if (!afterRoot.isDirectory() || afterRoot.isSymbolicLink() || afterRoot.dev !== rootStat.dev || afterRoot.ino !== rootStat.ino) throw new Error("CI report directory changed");
const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
if (typeof report.success !== "boolean" || !Array.isArray(report.testResults) ||
    (fullSuite ? report.testResults.length < 1 || report.testResults.length > 1024 : report.testResults.length !== expectedFiles)) throw new Error("Incomplete test report");
const files = report.testResults.map(module => {
  if (typeof module.name !== "string" || !Array.isArray(module.assertionResults)) throw new Error("Malformed native module report");
  const file = path.relative(process.cwd(), module.name).split(path.sep).join("/");
  if (!/^tests\/(?:unit|smoke)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.test\.ts$/.test(file) || !["passed", "failed", "pending"].includes(module.status)) throw new Error("Unexpected test module");
  const row = { file, state: module.status, passed: 0, failed: 0, skipped: 0, failedCases: [] };
  module.assertionResults.forEach((test, index) => {
    if (test.status === "passed") row.passed++;
    else if (["pending", "todo", "skipped"].includes(test.status)) row.skipped++;
    else if (test.status === "failed") {
      row.failed++;
      let line = null;
      for (const message of test.failureMessages || []) {
        if (typeof message !== "string") throw new Error("Invalid failure record");
        for (const text of message.split("\n")) {
          const marker = path.basename(file) + ":", at = text.indexOf(marker);
          if (at !== -1) { const position = text.slice(at + marker.length).match(/^(\d+):\d+/); if (position) { line = Number(position[1]); break; } }
        }
        if (line !== null) break;
      }
      row.failedCases.push({ index, line });
    } else throw new Error("Unknown native assertion state");
  });
  return row;
});
const total = files.reduce((sum, file) => sum + file.passed + file.failed + file.skipped, 0);
if (!Number.isSafeInteger(report.numTotalTests) || total !== report.numTotalTests || total < 1 || new Set(files.map(file => file.file)).size !== files.length) throw new Error("Inconsistent native diagnostic counts");
const counts = files.reduce((sum, file) => ({ passed: sum.passed + file.passed, failed: sum.failed + file.failed, notRun: sum.notRun + file.skipped }), { passed: 0, failed: 0, notRun: 0 });
// A bail-limited failure can report only part of the suite. These are observed
// module/assertion counts, not a claim that the complete suite ran successfully.
const summary = JSON.stringify({ scope: fullSuite ? "unit-smoke" : "native-recovery", success: report.success,
  reportedModules: files.length, total, ...counts, files: fullSuite ? files.filter(file => file.state === "failed" || file.failed > 0) : files });
const title = fullSuite ? "Unit and smoke test summary" : "Native recovery test summary";
console.log("::notice title=" + title + "::" + summary.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"));
process.exitCode = report.success ? 0 : 1;
