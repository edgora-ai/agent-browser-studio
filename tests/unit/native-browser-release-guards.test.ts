import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
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
const VISUAL_SCRIPT = path.join(ROOT, "scripts", "visual-shot.mjs");

function functionBody(source: string, name: string): string {
  const file = ts.createSourceFile("guard-fixture.ts", source, ts.ScriptTarget.Latest, true);
  const functions = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
  expect(functions, `unique function ${name}`).toHaveLength(1);
  expect(functions[0].body, `body for ${name}`).toBeDefined();
  return functions[0].body!.getText(file);
}
describe("visual-shot Chromium resolution without launching a browser", () => {
  function resolve(globals: Record<string, unknown>): string | null {
    const body = functionBody(fs.readFileSync(VISUAL_SCRIPT, "utf8"), "resolveChromium");
    return vm.runInNewContext("(function resolveChromium() " + body + ")()", globals);
  }
  it.each(["PLAYWRIGHT_CHROMIUM_PATH", "CHROME_PATH"])("preserves the existing %s override before Playwright discovery", key => {
    expect(resolve({
      process: { env: { [key]: "explicit-binary" } }, existsSync: (file: string) => file === "explicit-binary",
      chromium: { executablePath: () => { throw new Error("override must win"); } },
    })).toBe("explicit-binary");
  });
  it("prefers Playwright's installed layout/custom cache over any scanned revision", () => {
    expect(resolve({
      process: { env: { PLAYWRIGHT_CHROMIUM_PATH: "missing-override" } },
      chromium: { executablePath: () => "/owned/custom-cache/chromium-123/chrome-linux64/chrome" },
      existsSync: (file: string) => file !== "missing-override",
      os: { homedir: () => { throw new Error("installed path must win before cache scanning"); } },
    })).toBe("/owned/custom-cache/chromium-123/chrome-linux64/chrome");
  });
  it.each(["chrome-linux", "chrome-linux64"])("retains newest-revision fallback discovery for %s", layout => {
    const root = "/owned/home/.cache/ms-playwright";
    const binary = `${root}/chromium-20/${layout}/chrome`;
    expect(resolve({
      process: { platform: "linux", env: {} }, path: path.posix, os: { homedir: () => "/owned/home" },
      chromium: { executablePath: () => "/missing/installed" },
      existsSync: (file: string) => file === root || file === binary || file === `${root}/chromium-10/${layout}/chrome`,
      readdirSync: () => ["chromium-10", "chromium-20", "not-a-browser"],
    })).toBe(binary);
  });
});

function before(source: string, earlier: string, later: string): void {
  const first = source.indexOf(earlier), second = source.indexOf(later);
  expect(first, `missing ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(second, `missing ${later}`).toBeGreaterThanOrEqual(0);
  expect(first, `${earlier} must precede ${later}`).toBeLessThan(second);
}

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

    // This used to assert `electronDist: node_modules/electron/dist`, added in
    // 527f6dc alongside the deep-sign hook. That line turned out to be the
    // cause of a packaging defect: electronDist pins the Electron binary to
    // whatever arch this machine installed, and electron-builder reuses it for
    // every requested target arch without checking. So `--mac zip --x64`
    // silently emitted an arm64 app under an x64 filename — a package Intel
    // users cannot launch.
    //
    // The signing guarantee is independent of it: after-pack.mjs never reads
    // electronDist (it operates on the already-packed bundle via
    // context.appOutDir), and builds verify "valid on disk / satisfies its
    // Designated Requirement" with the line removed.
    //
    // What must hold now is the opposite: no unconditional arch pinning, and
    // the offline escape hatch stays documented.
    const builderConfig = fs.readFileSync(BUILDER_CONFIG, "utf8");
    expect(
      builderConfig,
      "an unconditional electronDist pins the host arch into every target; pass it per-invocation instead",
    ).not.toMatch(/^electronDist:/m);
    expect(builderConfig).toContain("-c.electronDist=");
  });

  it("fails closed when unpacking and versions the identity-bound extraction cache before marking ready", () => {
    const runtime = fs.readFileSync(BUNDLED_RUNTIME, "utf8");
    expect(runtime).toContain("AGENT_BROWSER_BUNDLED_CACHE_DIR");
    const spec = functionBody(runtime, "archiveSpec");
    expect(spec).toContain('input.kind === "chromium" ? manifest?.chromiumVersion : manifest?.firefoxVersion');
    expect(spec).toContain("`${identity.size}-${Math.trunc(identity.mtimeMs)}`");
    expect(spec).toContain("`${version}-${archiveKey}` : archiveKey");
    expect(spec).toContain("/^[0-9A-Za-z._+-]+$/");
    expect(functionBody(runtime, "browserLocation")).toContain("captureArchiveSync(zipPath), readManifestAtRoot(input.root)");
    const asyncLocation = functionBody(runtime, "browserLocationAsync");
    before(asyncLocation, "await captureArchive(zipPath)", "return archiveSpec(");
    expect(asyncLocation).toContain("binaryRelative(input.kind), identity, manifest");
    expect(functionBody(runtime, "sameArchive")).toContain("a.source === b.source && a.dev === b.dev && a.ino === b.ino && a.size === b.size");
    expect(functionBody(runtime, "sameArchive")).toContain("a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs");

    const unpack = functionBody(runtime, "unpackArchiveIfNeeded");
    before(unpack, "if (unpack.error || unpack.status !== 0) throw", "requireBinary(binary)");
    before(unpack, "requireBinary(binary)", 'spawnSync("codesign", ["--verify", "--deep", "--strict", appBundleFor(binary)]');
    before(unpack, "if (signature.error || signature.status !== 0) throw", "publishArchive(spec, stage, lock)");
    const publish = functionBody(runtime, "publishArchive");
    before(publish, "requireArchiveUnchangedSync(spec)", 'fs.writeFileSync(path.join(stage, ".ready"), marker)');
    before(publish, "requireBinary(stagedBinary(spec, stage))", 'fs.writeFileSync(path.join(stage, ".ready"), marker)');
    before(publish, 'fs.writeFileSync(path.join(stage, ".ready"), marker)', "fs.renameSync(stage, spec.cacheDir)");

    const asyncUnpack = functionBody(runtime, "produceArchiveAsync");
    before(asyncUnpack, 'await runSubprocess("ditto"', "await requireBinaryAsync(binary)");
    before(asyncUnpack, "await requireBinaryAsync(binary)", 'await runSubprocess("codesign", ["--verify", "--deep", "--strict", appBundleFor(binary)]');
    before(asyncUnpack, 'await runSubprocess("codesign"', "await publishArchiveAsync(spec, stage, lock)");
    expect(functionBody(runtime, "runSubprocess")).toContain("else if (code !== 0 || signal) reject(");
    const asyncPublish = functionBody(runtime, "publishArchiveAsync");
    before(asyncPublish, "await requireArchiveUnchanged(spec)", 'await fs.promises.writeFile(path.join(stage, ".ready"), marker)');
    before(asyncPublish, "await requireBinaryAsync(stagedBinary(spec, stage))", 'await fs.promises.writeFile(path.join(stage, ".ready"), marker)');
    before(asyncPublish, 'await fs.promises.writeFile(path.join(stage, ".ready"), marker)', "await fs.promises.rename(stage, spec.cacheDir)");
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
