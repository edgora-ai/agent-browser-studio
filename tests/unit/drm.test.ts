// Widevine/DRM discovery unit tests — real service imports with an electron mock.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-drm-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-drm-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        if (name === "home") return TEST_DATA;
        return "/tmp";
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain, "utf8"),
      decryptString: (encrypted: Buffer) => Buffer.from(encrypted).toString("utf8"),
    },
  };
});

import { reloadConfig, saveConfig, setProfileMeta, getConfig } from "../../src/main/services/config-manager.js";
import {
  readCdmManifestVersion,
  validateCdmDir,
  findWidevineCdm,
  ensureManagedCdm,
  drmLaunchArgs,
} from "../../src/main/services/drm.js";
import {
  resetSecretStorageForTests,
  initializeSecretStorage,
  planSecretStorage,
} from "../../src/main/services/secrets.js";

const LIB_NAME = process.platform === "win32" ? "widevinecdm.dll"
  : process.platform === "darwin" ? "libwidevinecdm.dylib"
  : "libwidevinecdm.so";
const PLAT_DIR = process.platform === "darwin" ? "mac_arm64" : process.platform === "win32" ? "win_x64" : "linux_x64";

function makeCdmDir(root: string, version: string): string {
  const dir = path.join(root, "WidevineCdm");
  const plat = path.join(dir, "_platform_specific", PLAT_DIR);
  fs.mkdirSync(plat, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "WidevineCdm", version }));
  fs.writeFileSync(path.join(plat, LIB_NAME), "fake-cdm-binary");
  return dir;
}

describe("drm service (real files)", () => {
  beforeEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    initializeSecretStorage(planSecretStorage({ userDataDir: TEST_USER_DATA, platform: "darwin", trustedMacSignature: false, environment: {} }));
    reloadConfig();
  });

  afterEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("parses the CDM version from manifest.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drm-manifest-"));
    const dir = makeCdmDir(root, "4.10.2710.1");
    expect(readCdmManifestVersion(dir)).toBe("4.10.2710.1");
    expect(readCdmManifestVersion(root)).toBeNull();
  });

  it("validates a CDM dir only when manifest + platform library exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drm-validate-"));
    const dir = makeCdmDir(root, "4.10.2710.1");
    const info = validateCdmDir(dir);
    expect(info).toMatchObject({ version: "4.10.2710.1" });
    expect(fs.existsSync(info!.libraryPath)).toBe(true);
    expect(validateCdmDir(root)).toBeNull();
  });

  it("finds a configured CDM with source 'configured'", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drm-config-"));
    const dir = makeCdmDir(root, "4.10.2710.1");
    const info = findWidevineCdm({ cdmPath: dir, appDataDir: path.join(root, "appdata"), homeDir: root });
    expect(info).not.toBeNull();
    expect(info!.source).toBe("configured");
    expect(info!.path).toBe(path.resolve(dir));
  });

  it("returns null when no CDM is present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drm-none-"));
    // Use the Linux candidate set (no Chrome install on this host) to prove the negative case.
    expect(findWidevineCdm({ cdmPath: null, platform: "linux", appDataDir: path.join(root, "appdata"), homeDir: root })).toBeNull();
  });

  it("stages a managed copy under <appData>/cdm/widevine/<version>", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drm-managed-"));
    const dir = makeCdmDir(root, "4.10.2710.1");
    const appData = path.join(root, "appdata");
    const info = ensureManagedCdm({ cdmPath: dir, appDataDir: appData, homeDir: root });
    expect(info).not.toBeNull();
    expect(info!.source).toBe("managed");
    expect(info!.path).toBe(path.join(appData, "cdm", "widevine", "4.10.2710.1"));
    expect(fs.existsSync(path.join(info!.path, "manifest.json"))).toBe(true);
  });

  it("drmLaunchArgs returns widevine flags only for DRM-enabled profiles with a CDM", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "drm-args-"));
    const dir = makeCdmDir(root, "4.10.2710.1");
    // Seed a DRM-enabled profile; set the configured CDM path so discovery succeeds.
    const cfg = getConfig() as any;
    cfg.drm = { cdmPath: dir };
    cfg.browserProfiles["drm-probe-1"] = { name: "drm", fingerprintSeed: 12345, drm: true } as any;
    cfg.browserProfiles["plain-probe-1"] = { name: "plain", fingerprintSeed: 12345 } as any;
    saveConfig(cfg);
    const args = drmLaunchArgs("drm-probe-1");
    expect(args.some((a) => a.startsWith("--widevine-cdm-path="))).toBe(true);
    expect(args.some((a) => a.startsWith("--widevine-cdm-version="))).toBe(true);
    expect(drmLaunchArgs("plain-probe-1")).toEqual([]);
  });

  it("setProfileMeta persists the per-profile DRM toggle", () => {
    const cfg = getConfig() as any;
    cfg.browserProfiles["drm-probe-2"] = { name: "drm2", fingerprintSeed: 12345 } as any;
    saveConfig(cfg);
    setProfileMeta("drm-probe-2", { drm: true });
    expect((getConfig() as any).browserProfiles["drm-probe-2"].drm).toBe(true);
    setProfileMeta("drm-probe-2", { drm: false });
    expect((getConfig() as any).browserProfiles["drm-probe-2"].drm).toBe(false);
  });
});
