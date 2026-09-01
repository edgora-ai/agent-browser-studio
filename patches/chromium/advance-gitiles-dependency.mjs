#!/usr/bin/env node
// Advance an archive-seeded dependency without transferring a Git pack.
// Gitiles exposes each commit's tree_diff plus immutable base64 file content;
// the script walks first-parent commits, applies the target state, and verifies
// every regular-file Git blob SHA locally.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [, , sourceArg, repositoryArg, baseCommit, targetCommit] = process.argv;
if (!sourceArg || !repositoryArg || !baseCommit || !targetCommit) {
  console.error("usage: advance-gitiles-dependency.mjs <source-dir> <gitiles-repository-url> <base-commit> <target-commit>");
  process.exit(2);
}
const sourceRoot = path.resolve(sourceArg);
const repository = repositoryArg.replace(/\/+$/, "");
const proxy = process.env.GITILES_PROXY || "";
if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
  throw new Error(`Dependency source directory does not exist: ${sourceRoot}`);
}
for (const commit of [baseCommit, targetCommit]) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid Git commit: ${commit}`);
}

function curl(url) {
  const args = [
    "--fail", "--silent", "--show-error", "--connect-timeout", "10",
    "--max-time", "60", "--retry", "6", "--retry-delay", "2", "--retry-all-errors",
  ];
  if (proxy) args.push("--proxy", proxy);
  args.push(url);
  return execFileSync("curl", args, { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
}

function commitData(commit) {
  const raw = curl(`${repository}/+/${commit}?format=JSON`).toString("utf8");
  return JSON.parse(raw.replace(/^\)\]\}'\n/, ""));
}

function encodedPath(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function safeTarget(relativePath) {
  const target = path.resolve(sourceRoot, relativePath);
  if (target !== sourceRoot && !target.startsWith(sourceRoot + path.sep)) {
    throw new Error(`Gitiles diff escaped dependency root: ${relativePath}`);
  }
  return target;
}

const targetStates = new Map();
let current = targetCommit;
let commits = 0;
while (current !== baseCommit) {
  if (commits >= 1000) throw new Error(`Base commit ${baseCommit} was not reached within 1000 first-parent commits`);
  const data = commitData(current);
  if (data.commit !== current) throw new Error(`Gitiles returned ${data.commit}, expected ${current}`);
  for (const diff of data.tree_diff || []) {
    if ((diff.type === "delete" || diff.type === "rename") && diff.old_path && !targetStates.has(diff.old_path)) {
      targetStates.set(diff.old_path, null);
    }
    if (diff.type !== "delete" && diff.new_path && !targetStates.has(diff.new_path)) {
      targetStates.set(diff.new_path, { id: diff.new_id, mode: diff.new_mode });
    }
  }
  if (!Array.isArray(data.parents) || data.parents.length < 1) {
    throw new Error(`Commit ${current} has no first parent before base ${baseCommit}`);
  }
  current = data.parents[0];
  commits += 1;
}

let written = 0;
let removed = 0;
for (const [relativePath, state] of [...targetStates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const target = safeTarget(relativePath);
  if (state === null) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`delete ${relativePath}`);
    removed += 1;
    continue;
  }
  const encoded = encodedPath(relativePath);
  const encodedContents = curl(`${repository}/+/${targetCommit}/${encoded}?format=TEXT`).toString("ascii").replace(/\s+/g, "");
  const contents = Buffer.from(encodedContents, "base64");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  let actual;
  if (state.mode === 40960) {
    const linkTarget = contents.toString("utf8");
    if (path.isAbsolute(linkTarget) || linkTarget.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe symlink target for ${relativePath}: ${JSON.stringify(linkTarget)}`);
    }
    fs.symlinkSync(linkTarget, target);
    actual = execFileSync("git", ["hash-object", "--stdin"], { input: contents, encoding: "utf8" }).trim();
  } else {
    fs.writeFileSync(target, contents, { mode: state.mode === 33261 ? 0o755 : 0o644 });
    actual = execFileSync("git", ["hash-object", target], { encoding: "utf8" }).trim();
  }
  if (actual !== state.id) throw new Error(`Blob verification failed for ${relativePath}: ${actual} != ${state.id}`);
  console.log(`write ${relativePath} ${actual}`);
  written += 1;
}
fs.writeFileSync(path.join(sourceRoot, ".chromium-dependency-commit"), `${targetCommit}\n`);
console.log(`advanced ${sourceRoot}: commits=${commits} files=${written} removed=${removed} target=${targetCommit}`);
