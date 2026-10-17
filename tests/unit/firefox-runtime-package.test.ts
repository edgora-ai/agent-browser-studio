import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertFirefoxRuntimePackage, assertFirefoxRuntimePackageAsync,
} from "../../src/main/services/firefox-runtime-package.js";
import { FIREFOX_HELPER_APPS, writeFirefoxFixturePlist, writeFirefoxRuntimeFixture } from "../helpers/firefox-runtime-package.js";

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "firefox-runtime-package-")));
  roots.push(root);
  const contents = path.join(root, "Firefox.app", "Contents");
  const binary = path.join(contents, "MacOS", "firefox");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  // If the helper ever executes the selected binary, it cannot succeed.
  fs.writeFileSync(binary, "not executable; static package fixture", { mode: 0o600 });
  writeFirefoxRuntimeFixture(binary, "154.0");
  return { root, binary, contents, plist: path.join(contents, "Info.plist") };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// This group deliberately exercises the actual host plist parser, not a regexp
// or a fake JSON response. Other discovery suites inject controlled plutil output.
describe.skipIf(process.platform !== "darwin")("static macOS Firefox runtime package", () => {
  it("accepts XML and binary Info.plist without executing the selected file", async () => {
    const { binary, plist } = fixture();
    expect(() => assertFirefoxRuntimePackage(binary, "darwin", "154.0")).not.toThrow();
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin", "154.0")).resolves.toBeUndefined();
    fs.writeFileSync(plist, Buffer.from("YnBsaXN0MDDSAQIDA18QGkNGQnVuZGxlU2hvcnRWZXJzaW9uU3RyaW5nXxAPQ0ZCdW5kbGVWZXJzaW9uVTE1NC4wCA0qPAAAAAAAAAEBAAAAAAAAAAQAAAAAAAAAAAAAAAAAAABC", "base64"));
    expect(() => assertFirefoxRuntimePackage(binary, "darwin", "154.0")).not.toThrow();
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin", "154.0")).resolves.toBeUndefined();
  });

  it("rejects a developer key in a binary plist and an entity-encoded XML key", async () => {
    const { binary, plist } = fixture();
    fs.writeFileSync(plist, Buffer.from("YnBsaXN0MDDTAQIDBAQFXxAaQ0ZCdW5kbGVTaG9ydFZlcnNpb25TdHJpbmdfEA9DRkJ1bmRsZVZlcnNpb25fEBdNb3ppbGxhRGV2ZWxvcGVyT2JqUGF0aFUxNTQuMF8QDy9taXNzaW5nL29iamRpcggPLD5YXgAAAAAAAAEBAAAAAAAAAAYAAAAAAAAAAAAAAAAAAABw", "base64"));
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/MozillaDeveloperObjPath/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/MozillaDeveloperObjPath/);
    fs.writeFileSync(plist, '<plist version="1.0"><dict><key>MozillaDeveloper&#79;bjPath</key><string></string></dict></plist>');
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/MozillaDeveloperObjPath/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/MozillaDeveloperObjPath/);
  });

  it("does not mistake developer key text in comments or values for a real key", async () => {
    const { binary, plist } = fixture();
    fs.writeFileSync(plist, '<plist version="1.0"><dict><!-- <key>MozillaDeveloperObjPath</key> --><key>CFBundleShortVersionString</key><string>154.0</string><key>description</key><string>MozillaDeveloperRepoPath</string></dict></plist>');
    expect(() => assertFirefoxRuntimePackage(binary, "darwin", "154.0")).not.toThrow();
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin", "154.0")).resolves.toBeUndefined();
  });

  it.each(["main", ...FIREFOX_HELPER_APPS])("rejects developer path keys by presence in %s, including empty values", async (helper) => {
    const { binary, contents, plist } = fixture();
    const file = helper === "main" ? plist : path.join(contents, "MacOS", helper, "Contents", "Info.plist");
    writeFirefoxFixturePlist(file, { MozillaDeveloperRepoPath: "" });
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/MozillaDeveloperRepoPath/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/MozillaDeveloperRepoPath/);
  });

  it.each(["omni.ja", "browser/omni.ja"])("requires a real nonempty %s on every call", async (relative) => {
    const { binary, contents } = fixture();
    const file = path.join(contents, "Resources", relative);
    assertFirefoxRuntimePackage(binary, "darwin");
    await assertFirefoxRuntimePackageAsync(binary, "darwin");
    fs.truncateSync(file, 0);
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/omni.ja/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/omni.ja/);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/omni.ja/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/omni.ja/);
    fs.rmdirSync(file);
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/omni.ja/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/omni.ja/);
    // An owned link is still not a distribution resource. Never follow a test
    // symlink to an external objdir or another user's files.
    fs.symlinkSync(binary, file);
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/omni.ja/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/omni.ja/);
  });

  it("rejects symlinked resource directories without consulting their target", async () => {
    const { binary, contents, root } = fixture();
    fs.rmSync(path.join(contents, "Resources"), { recursive: true });
    fs.symlinkSync(path.join(root, "not-created-objdir"), path.join(contents, "Resources"));
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/Resources/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/Resources/);
  });

  it.each(["main", ...FIREFOX_HELPER_APPS])("fails closed for malformed or missing %s plist", async (helper) => {
    const { binary, contents, plist } = fixture();
    const file = helper === "main" ? plist : path.join(contents, "MacOS", helper, "Contents", "Info.plist");
    fs.writeFileSync(file, "not a property list");
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/Info.plist/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/Info.plist/);
    fs.unlinkSync(file);
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/Info.plist/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/Info.plist/);
  });

  it("allows older layouts with no optional helper bundles, but not malformed main metadata", async () => {
    const { binary, contents, plist } = fixture();
    for (const helper of FIREFOX_HELPER_APPS) fs.rmSync(path.join(contents, "MacOS", helper), { recursive: true });
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin", "154.0")).resolves.toBeUndefined();
    fs.writeFileSync(plist, '<plist version="1.0"><array><string>not a dictionary</string></array></plist>');
    expect(() => assertFirefoxRuntimePackage(binary, "darwin")).toThrow(/Info.plist/);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin")).rejects.toThrow(/Info.plist/);
  });

  it("compares full product versions, not majors or prefixes", async () => {
    const { binary } = fixture();
    expect(() => assertFirefoxRuntimePackage(binary, "darwin", "154.0.1")).toThrow(/version/i);
    await expect(assertFirefoxRuntimePackageAsync(binary, "darwin", "154.0.1")).rejects.toThrow(/version/i);
  });
});

describe("non-macOS engine compatibility", () => {
  it.each(["linux", "win32"] as const)("does not impose macOS packaging on %s paths", async (platform) => {
    // No file or user config is read at this deliberately absent path.
    const file = path.join(os.tmpdir(), "no-macos-layout-required", "firefox");
    expect(() => assertFirefoxRuntimePackage(file, platform, "154.0")).not.toThrow();
    await expect(assertFirefoxRuntimePackageAsync(file, platform, "154.0")).resolves.toBeUndefined();
  });
});
