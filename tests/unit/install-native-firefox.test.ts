import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { firefoxFixturePlistJson, writeFirefoxFixturePlist, writeFirefoxRuntimeFixture } from "../helpers/firefox-runtime-package.js";

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(), execFile: vi.fn(), report: vi.fn(), supports: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync, execFile: mocks.execFile }));
vi.mock("../../src/main/services/firefox-native-capabilities.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/firefox-native-capabilities.js")>(),
  readFirefoxNativeCapabilityReport: mocks.report,
  supportsFirefoxNativeConfig: mocks.supports,
}));
import { validateNativeBinary } from "../../src/tools/install-native-firefox.js";
import { FIREFOX_EXPECTED_SOURCE_STAMP } from "../../src/main/services/firefox-native-capabilities.js";

let root: string;
let binary: string;
let contents: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "firefox-install-validator-")));
  contents = path.join(root, "Firefox.app", "Contents");
  binary = path.join(contents, "MacOS", "firefox");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "data-only installer fixture", { mode: 0o600 });
  writeFirefoxRuntimeFixture(binary, "154.0");
  mocks.execFileSync.mockReset().mockImplementation((file: string, args: string[]) => {
    if (file !== "/usr/bin/plutil") throw new Error(`Installation, browser probes and signing are forbidden: ${file}`);
    return firefoxFixturePlistJson(args);
  });
  mocks.execFile.mockReset().mockImplementation(() => { throw new Error("Unexpected asynchronous subprocess"); });
  mocks.report.mockReset().mockReturnValue({ browserVersion: "154.0", sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP });
  mocks.supports.mockReset().mockReturnValue(true);
});
afterEach(() => {
  expect(mocks.execFileSync.mock.calls.every(([file]) => file === "/usr/bin/plutil")).toBe(true);
  expect(mocks.execFile).not.toHaveBeenCalled();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("native Firefox installer validation only (no installation/signing)", () => {
  it("requires a distribution package as well as native capabilities/provenance", () => {
    expect(() => validateNativeBinary(binary, "154.0")).not.toThrow();
    expect(mocks.report).toHaveBeenCalledWith(binary, "darwin");
    expect(mocks.supports).toHaveBeenCalledWith(binary, "darwin");
  });

  it.each(["GRE", "developer", "version"])("rejects %s defects before a binary capability probe", (defect) => {
    if (defect === "GRE") fs.unlinkSync(path.join(contents, "Resources", "omni.ja"));
    else writeFirefoxFixturePlist(path.join(contents, "Info.plist"), defect === "developer"
      ? { CFBundleShortVersionString: "154.0", MozillaDeveloperObjPath: "/missing/objdir" }
      : { CFBundleShortVersionString: "154.0.1" });
    expect(() => validateNativeBinary(binary, "154.0")).toThrow(/Firefox.*runtime package/i);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.supports).not.toHaveBeenCalled();
  });

  it("does not let cached capabilities conceal package damage on a later validation", () => {
    validateNativeBinary(binary, "154.0");
    fs.truncateSync(path.join(contents, "Resources", "browser", "omni.ja"), 0);
    expect(() => validateNativeBinary(binary, "154.0")).toThrow(/omni.ja/);
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });

  it("still rejects incomplete capabilities and mismatched full version/source provenance", () => {
    mocks.supports.mockReturnValue(false);
    expect(() => validateNativeBinary(binary, "154.0")).toThrow(/capability report/);
    mocks.supports.mockReturnValue(true);
    mocks.report.mockReturnValue({ browserVersion: "154.0.1", sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP });
    expect(() => validateNativeBinary(binary, "154.0")).toThrow(/provenance mismatch/);
    mocks.report.mockReturnValue({ browserVersion: "154.0", sourceStamp: "0".repeat(40) });
    expect(() => validateNativeBinary(binary, "154.0")).toThrow(/provenance mismatch/);
  });
});
