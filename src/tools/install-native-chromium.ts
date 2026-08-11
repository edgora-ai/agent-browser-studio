import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHROMIUM_CACHE_DIR_NAME } from "../main/branding.js";

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

function updateHashFromFile(hash: ReturnType<typeof createHash>, filePath: string): void {
  hash.update(path.basename(filePath));
  hash.update("\0");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  hash.update("\0");
}

function bundleBuildHash(app: string): string {
  const executable = executableFor(app);
  const frameworkRoot = path.join(
    app,
    "Contents",
    "Frameworks",
    "Chromium Framework.framework",
    "Versions",
    "Current",
  );
  const framework = path.join(frameworkRoot, "Chromium Framework");
  if (!fs.existsSync(framework) || !fs.statSync(framework).isFile()) {
    fail(`Chromium Framework binary not found inside ${app}`);
  }

  const hash = createHash("sha256");
  for (const filePath of [
    executable,
    framework,
    path.join(frameworkRoot, "Resources", "resources.pak"),
    path.join(frameworkRoot, "Resources", "v8_context_snapshot.arm64.bin"),
    path.join(frameworkRoot, "Resources", "v8_context_snapshot.x86_64.bin"),
  ]) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      updateHashFromFile(hash, filePath);
    }
  }
  return hash.digest("hex");
}

function main(): void {
  if (process.platform !== "darwin") fail("The current native installer supports macOS application bundles only");
  const input = process.argv[2];
  if (!input) fail("usage: npm run install:chromium -- /path/to/Chromium.app");

  const sourceApp = resolveMacApp(input);
  const sourceExecutable = executableFor(sourceApp);
  const version = detectVersion(sourceExecutable);
  if (Number(version.split(".")[0]) < 149) fail(`Chromium 149+ required, detected ${version}`);

  const cacheOverride = process.env.AGENT_BROWSER_CHROMIUM_CACHE_DIR
    || process.env.CLOAKLITE_CHROMIUM_CACHE_DIR; // pre-rename compatibility
  const cacheRoot = cacheOverride
    ? path.resolve(cacheOverride)
    : path.join(os.homedir(), CHROMIUM_CACHE_DIR_NAME);
  const targetDir = path.join(cacheRoot, `chromium-${version}`);
  const targetApp = path.join(targetDir, "Chromium.app");
  const targetExecutable = path.join(targetApp, "Contents", "MacOS", "Chromium");
  const sourceHash = bundleBuildHash(sourceApp);
  let installedHash: string | null = null;

  if (fs.existsSync(targetExecutable)) {
    const installedVersion = detectVersion(targetExecutable);
    if (installedVersion === version) {
      installedHash = bundleBuildHash(targetApp);
      if (installedHash === sourceHash) {
        process.stdout.write(JSON.stringify({
          installed: true,
          unchanged: true,
          version,
          buildHash: sourceHash,
          executablePath: targetExecutable,
        }, null, 2) + "\n");
        return;
      }
    } else {
      fail(`Install target already exists with version ${installedVersion}: ${targetDir}`);
    }
  }
  if (fs.existsSync(targetDir) && installedHash === null) {
    fail(`Install target already exists and is incomplete: ${targetDir}`);
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(cacheRoot, ".chromium-install-"));
  const stageApp = path.join(stageDir, "Chromium.app");
  let previousDir: string | null = null;
  try {
    execFileSync("ditto", [sourceApp, stageApp], { stdio: "inherit" });
    const stagedExecutable = executableFor(stageApp);
    const stagedVersion = detectVersion(stagedExecutable);
    if (stagedVersion !== version) fail(`Staged Chromium version changed from ${version} to ${stagedVersion}`);
    const stagedHash = bundleBuildHash(stageApp);
    if (stagedHash !== sourceHash) fail("Staged Chromium runtime build hash does not match the source build");

    if (installedHash !== null) {
      previousDir = path.join(
        cacheRoot,
        `.chromium-${version}-previous-${installedHash.slice(0, 12)}-${Date.now()}`,
      );
      fs.renameSync(targetDir, previousDir);
    }
    try {
      fs.renameSync(stageDir, targetDir);
    } catch (error) {
      if (previousDir && fs.existsSync(previousDir) && !fs.existsSync(targetDir)) {
        fs.renameSync(previousDir, targetDir);
        previousDir = null;
      }
      throw error;
    }
  } finally {
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  }

  process.stdout.write(JSON.stringify({
    installed: true,
    unchanged: false,
    replaced: installedHash !== null,
    version,
    buildHash: sourceHash,
    executablePath: targetExecutable,
    previousPath: previousDir,
  }, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`[install:chromium] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
