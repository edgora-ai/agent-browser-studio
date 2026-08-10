import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(repositoryRoot, "native", "masque-socks-bridge");
const outputDirectory = path.join(repositoryRoot, "dist", "native");
const binaryName = process.platform === "win32" ? "roxy-masque-bridge.exe" : "roxy-masque-bridge";
const outputPath = path.join(outputDirectory, binaryName);

fs.mkdirSync(outputDirectory, { recursive: true });
const result = spawnSync("go", [
  "build",
  "-buildvcs=false",
  "-trimpath",
  "-ldflags=-s -w",
  "-o",
  outputPath,
  ".",
], {
  cwd: sourceDirectory,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform !== "win32") fs.chmodSync(outputPath, 0o755);
fs.copyFileSync(
  path.join(sourceDirectory, "THIRD_PARTY_NOTICES.md"),
  path.join(outputDirectory, "THIRD_PARTY_NOTICES.md"),
);
