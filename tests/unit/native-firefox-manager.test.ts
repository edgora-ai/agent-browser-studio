import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIREFOX_HELPER_APPS, firefoxFixturePlistJson, writeFirefoxFixturePlist, writeFirefoxRuntimeFixture } from "../helpers/firefox-runtime-package.js";

const probes = vi.hoisted(() => ({ execFileSync: vi.fn(), execFile: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => probes);
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compareFirefoxVersions,
  findManagedFirefoxBinary,
  getManagedFirefoxRoot,
  listManagedFirefoxBinaries,
  normalizeManagedFirefoxVersion,
} from "../../src/main/services/native-firefox-manager.js";
import {
  FIREFOX_CAPABILITY_PRODUCT,
  FIREFOX_EXPECTED_SOURCE_STAMP,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES,
} from "../../src/main/services/firefox-native-capabilities.js";

const roots: string[] = [];
const reports = new Map<string, Record<string, unknown>>();
beforeEach(() => {
  probes.execFileSync.mockReset().mockImplementation((file: string, args: string[]) => {
    if (file === "/usr/bin/plutil") return firefoxFixturePlistJson(args);
    const report = reports.get(file);
    if (!report) throw new Error(`Unowned binary fixture: ${file}`);
    return JSON.stringify(report);
  });
  probes.spawnSync.mockReset().mockImplementation((file: string) => {
    const report = reports.get(file);
    if (!report) throw new Error(`Unowned binary fixture: ${file}`);
    return { status: 0, stdout: `Mozilla Firefox ${report.browserVersion}\n`, stderr: "" };
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-managed-firefox-test-"));
  roots.push(root);
  return root;
}

function installFake(root: string, version: string, capable = true): string {
  const directory = path.join(root, `firefox-${version}`, "Firefox.app", "Contents", "MacOS");
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, "firefox");
  const report = {
    product: FIREFOX_CAPABILITY_PRODUCT,
    capabilitySchemaVersion: 1,
    browserVersion: version,
    buildId: "20260902025601",
    sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP,
    capabilities: FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  };
  fs.writeFileSync(binary, "fixture data; never executable", { mode: 0o600 });
  reports.set(binary, report);
  writeFirefoxRuntimeFixture(binary, version);
  fs.writeFileSync(
    path.join(directory, "XUL"),
    capable ? `\"product\":\"${FIREFOX_CAPABILITY_PRODUCT}\"` : "stock-xul",
  );
  return binary;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("managed native Firefox discovery", () => {
  it("uses the caller-provided environment for cache isolation", () => {
    const root = path.join(makeRoot(), "isolated-cache");
    expect(getManagedFirefoxRoot({ AGENT_BROWSER_FIREFOX_CACHE_DIR: root })).toBe(path.resolve(root));
  });

  it("normalizes exact versions and rejects ambiguous input", () => {
    expect(normalizeManagedFirefoxVersion("154.0")).toBe("154.0");
    expect(normalizeManagedFirefoxVersion("154.0.1")).toBe("154.0.1");
    expect(normalizeManagedFirefoxVersion("auto")).toBeNull();
    expect(normalizeManagedFirefoxVersion(null)).toBeNull();
    expect(() => normalizeManagedFirefoxVersion("154")).toThrow("Invalid Firefox version");
  });

  it("lists only binary-attested installs and selects the requested version", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const first = installFake(root, "154.0");
    const latest = installFake(root, "154.0.1");
    installFake(root, "153.0", false);
    fs.mkdirSync(path.join(root, "firefox-152.0"));

    expect(listManagedFirefoxBinaries(root, "darwin").map((entry) => entry.version)).toEqual([
      "154.0.1",
      "154.0",
    ]);
    expect(findManagedFirefoxBinary(null, root, "darwin")?.binaryPath).toBe(latest);
    expect(findManagedFirefoxBinary("154.0", root, "darwin")?.binaryPath).toBe(first);
    expect(findManagedFirefoxBinary("155.0", root, "darwin")).toBeNull();
  });

  it("rejects the reproduced developer bundle before any binary probe", () => {
    const root = makeRoot();
    const binary = installFake(root, "154.0");
    const contents = path.dirname(path.dirname(binary));
    writeFirefoxFixturePlist(path.join(contents, "Info.plist"), {
      CFBundleShortVersionString: "154.0", CFBundleVersion: "154.0",
      MozillaDeveloperObjPath: "/nonexistent/objdir",
    });
    fs.unlinkSync(path.join(contents, "Resources", "omni.ja"));
    expect(listManagedFirefoxBinaries(root, "darwin")).toEqual([]);
    expect(probes.spawnSync).not.toHaveBeenCalled();
    expect(probes.execFileSync.mock.calls.filter(([file]) => file !== "/usr/bin/plutil")).toEqual([]);
  });

  it.each(["omni.ja", "browser/omni.ja"])("rechecks %s even with a hot native capability cache", (relative) => {
    const root = makeRoot();
    const binary = installFake(root, "154.0");
    expect(findManagedFirefoxBinary("154.0", root, "darwin")?.binaryPath).toBe(binary);
    fs.truncateSync(path.join(path.dirname(path.dirname(binary)), "Resources", relative), 0);
    expect(findManagedFirefoxBinary("154.0", root, "darwin")).toBeNull();
  });

  it.each(["main", ...FIREFOX_HELPER_APPS])("rejects newly added developer paths in %s after a hot hit", (helper) => {
    const root = makeRoot();
    const binary = installFake(root, "154.0");
    expect(listManagedFirefoxBinaries(root, "darwin")).toHaveLength(1);
    const contents = path.dirname(path.dirname(binary));
    writeFirefoxFixturePlist(helper === "main" ? path.join(contents, "Info.plist")
      : path.join(contents, "MacOS", helper, "Contents", "Info.plist"), {
      CFBundleShortVersionString: "154.0", CFBundleVersion: "154.0", MozillaDeveloperRepoPath: "",
    });
    expect(listManagedFirefoxBinaries(root, "darwin")).toEqual([]);
  });

  it("requires the complete package product version to match directory, version probe and capability report", () => {
    const root = makeRoot();
    const binary = installFake(root, "154.0.1");
    writeFirefoxFixturePlist(path.join(path.dirname(path.dirname(binary)), "Info.plist"), {
      CFBundleShortVersionString: "154.0.2", CFBundleVersion: "154.0.2",
    });
    expect(listManagedFirefoxBinaries(root, "darwin")).toEqual([]);
  });

  it.each(["154.0a1", "154.0.1.2"])("does not truncate a version probe %s into a supported exact version", (version) => {
    const root = makeRoot();
    installFake(root, version === "154.0a1" ? "154.0" : "154.0.1");
    probes.spawnSync.mockReturnValue({ status: 0, stdout: `Mozilla Firefox ${version}\n`, stderr: "" });
    expect(listManagedFirefoxBinaries(root, "darwin")).toEqual([]);
  });

  it("compares dotted Firefox versions numerically", () => {
    expect(compareFirefoxVersions("154.0.1", "154.0")).toBeGreaterThan(0);
    expect(compareFirefoxVersions("154.0", "153.9.9")).toBeGreaterThan(0);
    expect(compareFirefoxVersions("154.0", "154.0.0")).toBe(0);
  });
});
