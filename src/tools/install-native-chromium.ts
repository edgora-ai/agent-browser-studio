import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function fail(message: string): never {
  throw new Error(message);
}

function resolveMacApp(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() && resolved.endsWith(".app")) {
    return resolved;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const app = path.resolve(resolved, "..", "..", "..");
    if (app.endsWith(".app") && fs.existsSync(app)) return app;
  }
  fail(`Chromium application bundle not found: ${input}`);
}

function executableFor(app: string): string {
  for (const name of [path.basename(app, ".app"), "Chromium"]) {
    const candidate = path.join(app, "Contents", "MacOS", name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  fail(`Chromium executable not found inside ${app}`);
}

function detectVersion(executable: string): string {
  const output = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return output.match(/\d+\.\d+\.\d+\.\d+/)?.[0]
    || fail(`Could not detect Chromium version from: ${output.trim()}`);
}

function main(): void {
  if (process.platform !== "darwin") fail("The current native installer supports macOS application bundles only");
  const input = process.argv[2];
  if (!input) fail("usage: npm run install:chromium -- /path/to/Chromium.app");

  const sourceApp = resolveMacApp(input);
  const sourceExecutable = executableFor(sourceApp);
  const version = detectVersion(sourceExecutable);
  if (Number(version.split(".")[0]) < 149) fail(`Chromium 149+ required, detected ${version}`);

  const cacheRoot = process.env.ROXY_CHROMIUM_CACHE_DIR
    ? path.resolve(process.env.ROXY_CHROMIUM_CACHE_DIR)
    : path.join(os.homedir(), ".roxy-lite-cloak");
  const targetDir = path.join(cacheRoot, `chromium-${version}`);
  const targetApp = path.join(targetDir, "Chromium.app");
  const targetExecutable = path.join(targetApp, "Contents", "MacOS", "Chromium");

  if (fs.existsSync(targetExecutable)) {
    const installedVersion = detectVersion(targetExecutable);
    if (installedVersion === version) {
      process.stdout.write(JSON.stringify({ installed: true, unchanged: true, version, executablePath: targetExecutable }, null, 2) + "\n");
      return;
    }
    fail(`Install target already exists with version ${installedVersion}: ${targetDir}`);
  }
  if (fs.existsSync(targetDir)) fail(`Install target already exists and is incomplete: ${targetDir}`);

  fs.mkdirSync(cacheRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(cacheRoot, ".chromium-install-"));
  const stageApp = path.join(stageDir, "Chromium.app");
  try {
    execFileSync("ditto", [sourceApp, stageApp], { stdio: "inherit" });
    const stagedExecutable = executableFor(stageApp);
    const stagedVersion = detectVersion(stagedExecutable);
    if (stagedVersion !== version) fail(`Staged Chromium version changed from ${version} to ${stagedVersion}`);
    fs.renameSync(stageDir, targetDir);
  } finally {
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  }

  process.stdout.write(JSON.stringify({ installed: true, unchanged: false, version, executablePath: targetExecutable }, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`[install:chromium] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
