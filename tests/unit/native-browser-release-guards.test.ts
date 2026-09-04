import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const SYNC_SCRIPT = path.join(ROOT, "scripts", "sync-native-browsers.mjs");
const AFTER_PACK = path.join(ROOT, "scripts", "after-pack.mjs");
const BUILDER_CONFIG = path.join(ROOT, "electron-builder.yml");
const BUNDLED_RUNTIME = path.join(ROOT, "src", "main", "services", "bundled-native-browsers.ts");
const CHROMIUM_MANAGER = path.join(ROOT, "src", "main", "services", "native-chromium-manager.ts");
const FIREFOX_MANAGER = path.join(ROOT, "src", "main", "services", "native-firefox-manager.ts");
const FIREFOX_CAPABILITIES = path.join(ROOT, "src", "main", "services", "firefox-native-capabilities.ts");
const FIREFOX_INSTALLER = path.join(ROOT, "src", "tools", "install-native-firefox.ts");
const PACKAGE_JSON = path.join(ROOT, "package.json");

describe("native browser release guards", () => {
  it("preserves and verifies macOS bundle signatures while staging", () => {
    const script = fs.readFileSync(SYNC_SCRIPT, "utf8");
    expect(script).toContain('spawnSync("ditto", [src, staging]');
    expect(script).not.toContain("fs.cpSync(src, staging");
    expect(script).toContain('spawnSync("codesign", ["--verify", "--deep", "--strict", bundlePath]');
    expect(script.indexOf("verifyMacBundle(chromiumStage)")).toBeLessThan(
      script.indexOf("dittoZip(chromiumStage"),
    );

    const afterPack = fs.readFileSync(AFTER_PACK, "utf8");
    expect(afterPack.match(/"--deep"/g)).toHaveLength(2);
    expect(afterPack).toContain("the complete Electron app deeply");
    expect(fs.readFileSync(BUILDER_CONFIG, "utf8"))
      .toContain("electronDist: node_modules/electron/dist");
  });

  it("fails closed when unpacking and versions the extraction cache", () => {
    const runtime = fs.readFileSync(BUNDLED_RUNTIME, "utf8");
    expect(runtime).toContain("AGENT_BROWSER_BUNDLED_CACHE_DIR");
    expect(runtime).toContain("archiveCacheKey(zip, manifest?.chromiumVersion)");
    expect(runtime).toContain("unpack.error || unpack.status !== 0 || !fs.existsSync(expectedBinary)");
    expect(runtime).toContain('spawnSync("codesign", ["--verify", "--deep", "--strict", appBundle]');
    expect(runtime.indexOf("signature.error || signature.status !== 0")).toBeLessThan(
      runtime.indexOf("fs.writeFileSync(marker"),
    );
  });

  it("uses the unpacked binary version before the bundled manifest label", () => {
    const manager = fs.readFileSync(CHROMIUM_MANAGER, "utf8");
    expect(manager).toContain('version: detectBinaryVersion(bundled) || manifest?.chromiumVersion || "bundled"');
  });

  it("installs only binary-attested Firefox bundles with atomic replacement", () => {
    const manager = fs.readFileSync(FIREFOX_MANAGER, "utf8");
    expect(manager).toContain("supportsFirefoxNativeConfig(binaryPath, platform)");
    expect(manager).toContain("capabilityReport.browserVersion !== version");
    expect(manager).toContain("Ignore one incomplete or tampered install");

    const capabilities = fs.readFileSync(FIREFOX_CAPABILITIES, "utf8");
    expect(capabilities).toContain("fileContainsMarker(markerPath, REPORT_MARKER)");
    expect(capabilities.indexOf("fileContainsMarker(markerPath, REPORT_MARKER)")).toBeLessThan(
      capabilities.indexOf("execFileSync(resolved"),
    );
    expect(capabilities).toContain("sourceStamp: candidate.sourceStamp");

    const installer = fs.readFileSync(FIREFOX_INSTALLER, "utf8");
    expect(installer).toContain("verifyMacBundle(sourceApp)");
    expect(installer).toContain("validateNativeBinary(sourceExecutable, version)");
    expect(installer).toContain("signAndVerifyMacBundle(stageApp)");
    expect(installer).toContain("validateNativeBinary(stagedExecutable, stagedVersion)");
    expect(installer.indexOf("validateNativeBinary(stagedExecutable, stagedVersion)")).toBeLessThan(
      installer.indexOf("fs.renameSync(stageDir, targetDir)"),
    );
    expect(installer).toContain("Firefox capability provenance mismatch");
    expect(installer).toContain("validateNativeBinary(targetExecutable, version)");
    expect(installer).toContain("Installed Firefox readback hash changed");
    expect(JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).scripts["install:firefox"])
      .toContain("install-native-firefox.js");
  });
});
