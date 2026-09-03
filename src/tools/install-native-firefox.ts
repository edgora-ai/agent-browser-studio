import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FIREFOX_EXPECTED_SOURCE_STAMP,
  readFirefoxNativeCapabilityReport,
  supportsFirefoxNativeConfig,
} from "../main/services/firefox-native-capabilities.js";
import { getManagedFirefoxRoot } from "../main/services/native-firefox-manager.js";

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
  fail(`Firefox application bundle not found: ${input}`);
}

function executableFor(app: string): string {
  const executable = path.join(app, "Contents", "MacOS", "firefox");
  if (fs.existsSync(executable) && fs.statSync(executable).isFile()) return executable;
  fail(`Firefox executable not found inside ${app}`);
}

function detectVersion(executable: string): string {
  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return output.match(/Mozilla Firefox\s*(\d+\.\d+(?:\.\d+)?)/i)?.[1]
    ?? fail(`Could not detect Firefox version from: ${output.trim()}`);
}

function updateHashFromFile(
  hash: ReturnType<typeof createHash>,
  app: string,
  filePath: string,
): void {
  hash.update(path.relative(app, filePath));
  hash.update("\0");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  hash.update("\0");
}

function bundleBuildHash(app: string): string {
  const files = [
    executableFor(app),
    path.join(app, "Contents", "MacOS", "XUL"),
    path.join(app, "Contents", "Resources", "application.ini"),
    path.join(app, "Contents", "Resources", "platform.ini"),
  ];
  const hash = createHash("sha256");
  for (const filePath of files) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      fail(`Required Firefox build artifact is missing: ${filePath}`);
    }
    updateHashFromFile(hash, app, filePath);
  }
  return hash.digest("hex");
}

function verifyMacBundle(app: string): void {
  execFileSync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ], { stdio: "inherit" });
}

function signAndVerifyMacBundle(app: string): void {
  execFileSync("/usr/bin/xattr", ["-cr", app], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    app,
  ], { stdio: "inherit" });
  verifyMacBundle(app);
}

function validateNativeBinary(executable: string, version: string): void {
  const report = readFirefoxNativeCapabilityReport(executable, "darwin");
  if (!report || !supportsFirefoxNativeConfig(executable, "darwin")) {
    fail("Firefox binary lacks a valid config-v1/native-required-v1/snapshot-v1 capability report");
  }
  if (report.browserVersion !== version || report.sourceStamp !== FIREFOX_EXPECTED_SOURCE_STAMP) {
    fail(`Firefox capability provenance mismatch: version=${report.browserVersion} source=${report.sourceStamp}`);
  }
}

function main(): void {
  if (process.platform !== "darwin") {
    fail("The current native Firefox installer supports macOS application bundles only");
  }
  const input = process.argv[2];
  if (!input) fail("usage: npm run install:firefox -- /path/to/Nightly.app");

  const sourceApp = resolveMacApp(input);
  const sourceExecutable = executableFor(sourceApp);
  const version = detectVersion(sourceExecutable);
  if (!/^154\.0(?:\.\d+)?$/.test(version)) fail(`Firefox 154 required, detected ${version}`);
  verifyMacBundle(sourceApp);
  validateNativeBinary(sourceExecutable, version);

  const cacheRoot = getManagedFirefoxRoot();
  const targetDir = path.join(cacheRoot, `firefox-${version}`);
  const targetApp = path.join(targetDir, "Firefox.app");
  const targetExecutable = path.join(targetApp, "Contents", "MacOS", "firefox");
  let installedHash: string | null = null;

  if (fs.existsSync(targetExecutable)) {
    const installedVersion = detectVersion(targetExecutable);
    if (installedVersion !== version) {
      fail(`Install target already exists with version ${installedVersion}: ${targetDir}`);
    }
    validateNativeBinary(targetExecutable, installedVersion);
    installedHash = bundleBuildHash(targetApp);
  }
  if (fs.existsSync(targetDir) && installedHash === null) {
    fail(`Install target already exists and is incomplete: ${targetDir}`);
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(cacheRoot, ".firefox-install-"));
  const stageApp = path.join(stageDir, "Firefox.app");
  let previousDir: string | null = null;
  let stagedHash: string | null = null;
  try {
    execFileSync("ditto", [sourceApp, stageApp], { stdio: "inherit" });
    signAndVerifyMacBundle(stageApp);
    const stagedExecutable = executableFor(stageApp);
    const stagedVersion = detectVersion(stagedExecutable);
    if (stagedVersion !== version) fail(`Staged Firefox version changed from ${version} to ${stagedVersion}`);
    validateNativeBinary(stagedExecutable, stagedVersion);
    stagedHash = bundleBuildHash(stageApp);

    if (installedHash === stagedHash) {
      process.stdout.write(`${JSON.stringify({
        installed: true,
        unchanged: true,
        version,
        sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP,
        buildHash: stagedHash,
        executablePath: path.join(targetApp, "Contents", "MacOS", "firefox"),
      }, null, 2)}\n`);
      return;
    }

    if (installedHash !== null) {
      previousDir = path.join(
        cacheRoot,
        `.firefox-${version}-previous-${installedHash.slice(0, 12)}-${Date.now()}`,
      );
      fs.renameSync(targetDir, previousDir);
    }
    let stageInstalled = false;
    try {
      fs.renameSync(stageDir, targetDir);
      stageInstalled = true;
      validateNativeBinary(targetExecutable, version);
      const installedReadbackHash = bundleBuildHash(targetApp);
      if (installedReadbackHash !== stagedHash) {
        fail(`Installed Firefox readback hash changed from ${stagedHash} to ${installedReadbackHash}`);
      }
    } catch (error) {
      if (stageInstalled && fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      if (previousDir && fs.existsSync(previousDir) && !fs.existsSync(targetDir)) {
        fs.renameSync(previousDir, targetDir);
        previousDir = null;
      }
      throw error;
    }
  } finally {
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    installed: true,
    unchanged: false,
    replaced: installedHash !== null,
    version,
    sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP,
    buildHash: stagedHash,
    executablePath: path.join(targetApp, "Contents", "MacOS", "firefox"),
    previousPath: previousDir,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[install:firefox] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
