#!/usr/bin/env node
// Advance an official Chromium 152.0.7977.65 source archive to the pinned
// 152.0.7977.72 commit using GitHub's bounded compare response. Each changed
// regular file is downloaded by immutable Git blob SHA and verified locally.
// Gitlink changes are recorded and materialized later by gclient from DEPS.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE_COMMIT = "fc4d67f1788019a27e32511137ceccbd2fafdaaa";
const TARGET_COMMIT = "026bb13a93d60e7adfefa2bbf58d6f57c2d335cc";
const TARGET_VERSION = "152.0.7977.72";
const EXPECTED_COMMITS = 174;
const EXPECTED_FILES = 172;
const GITLINK_PATHS = new Set([
  "third_party/dawn",
  "third_party/devtools-frontend/src",
]);

const [, , sourceArg, compareArg] = process.argv;
if (!sourceArg || !compareArg) {
  console.error("usage: advance-source-compare.mjs <chromium-src> <compare-json>");
  process.exit(2);
}
const sourceRoot = path.resolve(sourceArg);
const comparePath = path.resolve(compareArg);
if (!fs.existsSync(path.join(sourceRoot, "DEPS"))) {
  throw new Error(`Chromium archive source is incomplete: ${sourceRoot}`);
}
const compare = JSON.parse(fs.readFileSync(comparePath, "utf8"));
const summary = {
  status: compare.status,
  base: compare.base_commit?.sha,
  target: compare.merge_base_commit?.sha === BASE_COMMIT
    ? compare.commits?.at(-1)?.sha
    : null,
  aheadBy: compare.ahead_by,
  totalCommits: compare.total_commits,
  commits: compare.commits?.length,
  files: compare.files?.length,
};
if (
  summary.status !== "ahead" ||
  summary.base !== BASE_COMMIT ||
  summary.target !== TARGET_COMMIT ||
  summary.aheadBy !== EXPECTED_COMMITS ||
  summary.totalCommits !== EXPECTED_COMMITS ||
  summary.commits !== EXPECTED_COMMITS ||
  summary.files !== EXPECTED_FILES
) {
  throw new Error(`GitHub compare response is incomplete or unexpected: ${JSON.stringify(summary)}`);
}

function safeTarget(relativePath) {
  const target = path.resolve(sourceRoot, relativePath);
  if (target !== sourceRoot && !target.startsWith(sourceRoot + path.sep)) {
    throw new Error(`Compare response escaped source root: ${relativePath}`);
  }
  return target;
}

function downloadBlob(sha) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return execFileSync(
        "gh",
        [
          "api",
          `repos/chromium/chromium/git/blobs/${sha}`,
          "-H",
          "Accept: application/vnd.github.raw+json",
        ],
        { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
      );
    } catch (error) {
      lastError = error;
      if (attempt < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
    }
  }
  throw lastError;
}

function gitBlobSha(filePath) {
  return execFileSync("git", ["hash-object", filePath], { encoding: "utf8" }).trim();
}

let regularFiles = 0;
const gitlinks = [];
for (const [index, file] of compare.files.entries()) {
  if (!file?.filename || !file?.status) throw new Error(`Malformed compare file at index ${index}`);
  const target = safeTarget(file.filename);
  const previousTarget = file.previous_filename ? safeTarget(file.previous_filename) : null;
  const previousMode = fs.existsSync(target)
    ? fs.statSync(target).mode
    : previousTarget && fs.existsSync(previousTarget)
      ? fs.statSync(previousTarget).mode
      : 0o644;
  if (file.status === "removed") {
    fs.rmSync(target, { recursive: true, force: true });
    regularFiles += 1;
    console.log(`[${index + 1}/${EXPECTED_FILES}] removed ${file.filename}`);
    continue;
  }
  if (!["modified", "added", "renamed", "copied", "changed"].includes(file.status) || !file.sha) {
    throw new Error(`Unsupported compare status ${file.status} for ${file.filename}`);
  }
  if (file.status === "renamed" && previousTarget && previousTarget !== target) {
    fs.rmSync(previousTarget, { recursive: true, force: true });
  }
  if (GITLINK_PATHS.has(file.filename)) {
    gitlinks.push(`${file.filename}\t${file.sha}`);
    console.log(`[${index + 1}/${EXPECTED_FILES}] gitlink ${file.filename} -> ${file.sha}`);
    continue;
  }
  const contents = downloadBlob(file.sha);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const executable = /(?:^|\n)new file mode 100755(?:\n|$)/.test(file.patch || "") || (previousMode & 0o111) !== 0;
  fs.writeFileSync(target, contents, { mode: executable ? 0o755 : 0o644 });
  const actualSha = gitBlobSha(target);
  if (actualSha !== file.sha) {
    throw new Error(`Blob verification failed for ${file.filename}: ${actualSha} != ${file.sha}`);
  }
  regularFiles += 1;
  console.log(`[${index + 1}/${EXPECTED_FILES}] ${file.status} ${file.filename} ${actualSha}`);
}
if (regularFiles + gitlinks.length !== EXPECTED_FILES) {
  throw new Error(`Applied ${regularFiles} files and ${gitlinks.length} gitlinks; expected ${EXPECTED_FILES}`);
}

const versionFile = fs.readFileSync(path.join(sourceRoot, "chrome", "VERSION"), "utf8");
const versionParts = Object.fromEntries(
  versionFile.trim().split(/\r?\n/).map((line) => line.split("=", 2)),
);
const version = ["MAJOR", "MINOR", "BUILD", "PATCH"].map((key) => versionParts[key]).join(".");
if (version !== TARGET_VERSION) throw new Error(`Advanced source reports ${version}, expected ${TARGET_VERSION}`);

fs.writeFileSync(path.join(sourceRoot, ".chromium-source-base-commit"), `${BASE_COMMIT}\n`);
fs.writeFileSync(path.join(sourceRoot, ".chromium-source-commit"), `${TARGET_COMMIT}\n`);
fs.writeFileSync(path.join(sourceRoot, ".chromium-source-gitlinks"), gitlinks.join("\n") + "\n");
console.log(`advanced source to Chromium ${TARGET_VERSION} (${TARGET_COMMIT})`);
console.log(`verified regular files: ${regularFiles}; deferred gitlinks: ${gitlinks.length}`);
