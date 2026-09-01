import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const SYNC_SCRIPT = path.join(ROOT, "scripts", "sync-native-browsers.mjs");
const BUNDLED_RUNTIME = path.join(ROOT, "src", "main", "services", "bundled-native-browsers.ts");
const CHROMIUM_MANAGER = path.join(ROOT, "src", "main", "services", "native-chromium-manager.ts");

describe("native browser release guards", () => {
  it("preserves and verifies macOS bundle signatures while staging", () => {
    const script = fs.readFileSync(SYNC_SCRIPT, "utf8");
    expect(script).toContain('spawnSync("ditto", [src, staging]');
    expect(script).not.toContain("fs.cpSync(src, staging");
    expect(script).toContain('spawnSync("codesign", ["--verify", "--deep", "--strict", bundlePath]');
    expect(script.indexOf("verifyMacBundle(chromiumStage)")).toBeLessThan(
      script.indexOf("dittoZip(chromiumStage"),
    );
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
});
