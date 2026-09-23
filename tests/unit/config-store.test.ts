// Config write budget (R10): the 64 MiB cap is measured on the FINAL serialized
// JSON in UTF-8 bytes, before any tmp file exists — so a rejected write cannot
// leave a stray tmp, cannot touch the original file, and cannot re-sync the
// in-memory cache to a draft that never reached disk. The load path checks the
// same budget and must NOT treat an oversized file as corruption (no misleading
// .corrupt salvage copy, no "remove the file" advice).
//
// These tests run against the REAL production cap (64 MiB), not a mocked one:
// the exact-boundary semantics ("== cap is writable, cap + 1 is not") are the
// contract, and a smaller fake constant would not prove it.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-config-store-test");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, "utf8"),
    decryptString: (encrypted: Buffer) => Buffer.from(encrypted).toString("utf8"),
  },
}));

import { transact } from "../../src/main/services/config/store.js";
import { CONFIG_MAX_BYTES, ConfigTooLargeError } from "../../src/main/services/config/limits.js";
import { getConfig, reloadConfig, getConfigPath } from "../../src/main/services/config-manager.js";

// A proxy username is the size carrier: it is the one config field that survives
// mergeConfig's whitelist without a length cap, so the payload reaches the
// serialized JSON verbatim. `host: "10.0.0.1"` is required (an IP, no DNS).
const CARRIER = "capprobe";

function setCarrier(username: string): void {
  transact((draft: any) => {
    draft.proxies = { [CARRIER]: { type: "http", host: "10.0.0.1", port: 8080, username } };
  });
}

/** Serialized size of the config carrying a one-character username, measured
 *  from disk so it includes whatever identity/normalization the live config has.
 *
 *  Seeded with a non-empty value on purpose: an empty username is dropped by the
 *  normalizer (and with it the `"username":` key), so a zero-length baseline
 *  would be ~15 bytes short of the real thing. Once the key is present, each
 *  extra ASCII character adds exactly one byte — so the length needed to reach
 *  any target is (target - baseline) + 1. */
function carrierBaseline(): number {
  setCarrier("a");
  return fs.statSync(getConfigPath()).size;
}

/** Username length that serializes the config to exactly `target` bytes. */
function carrierLengthFor(target: number): number {
  return target - carrierBaseline() + 1;
}

const configDir = () => path.dirname(getConfigPath());
const tmpFiles = (): string[] => {
  const dir = configDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("config.json.tmp-"));
};
const corruptFiles = (): string[] => {
  const dir = configDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".corrupt"));
};

describe("config store write budget", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
    // getConfig() assigns deviceId/deviceName through its own saveConfig on the
    // first call after a reload. Settle that before measuring: otherwise it
    // fires mid-test and silently rewrites the file the assertions compare.
    getConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("shares one 64 MiB budget between the read and write paths", () => {
    expect(CONFIG_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("writes a config exactly at the cap and reads it back", () => {
    const n = carrierLengthFor(CONFIG_MAX_BYTES);
    expect(n).toBeGreaterThan(0);

    expect(() => setCarrier("a".repeat(n))).not.toThrow();

    // Byte-exact: the boundary is "at the cap is allowed", so landing on
    // CONFIG_MAX_BYTES proves the check is not off by one in either direction.
    expect(fs.statSync(getConfigPath()).size).toBe(CONFIG_MAX_BYTES);
    expect(tmpFiles()).toEqual([]);
    // The read path must accept what the write path produced.
    expect(() => reloadConfig()).not.toThrow();
    expect((getConfig() as any).proxies[CARRIER].username.length).toBe(n);
  });

  it("rejects a config one byte over the cap without touching disk or cache", () => {
    const n = carrierLengthFor(CONFIG_MAX_BYTES + 1);
    const diskBefore = fs.readFileSync(getConfigPath());
    const cacheBefore = JSON.stringify(getConfig());

    expect(() => setCarrier("a".repeat(n))).toThrow(ConfigTooLargeError);

    expect(tmpFiles()).toEqual([]);
    expect(fs.readFileSync(getConfigPath())).toEqual(diskBefore);
    expect(JSON.stringify(getConfig())).toBe(cacheBefore);
  });

  it("counts multibyte UTF-8 by bytes rather than characters", () => {
    // Each "中" is 3 bytes: a .length check would wave this through at a third
    // of the real size.
    const per = Buffer.byteLength("中", "utf8");
    const chars = Math.ceil((carrierLengthFor(CONFIG_MAX_BYTES + 1)) / per);
    expect(chars).toBeLessThan(CONFIG_MAX_BYTES);

    expect(() => setCarrier("中".repeat(chars))).toThrow(ConfigTooLargeError);
    expect(tmpFiles()).toEqual([]);
  });

  it("does not report a size rejection as corruption or advise deleting the file", () => {
    const before = corruptFiles().length;
    const n = carrierLengthFor(CONFIG_MAX_BYTES + 1);

    let message = "";
    try {
      setCarrier("a".repeat(n));
    } catch (e: any) {
      message = String(e?.message || "");
    }

    expect(message).toMatch(/too large/i);
    expect(message).not.toMatch(/corrupt/i);
    expect(message).not.toMatch(/delete|remove|fix or/i);
    expect(corruptFiles().length).toBe(before);
  });

  it("accepts a legal write after a rejected one and survives a reload", () => {
    const n = carrierLengthFor(CONFIG_MAX_BYTES + 8);
    expect(() => setCarrier("a".repeat(n))).toThrow(ConfigTooLargeError);

    transact((draft: any) => { (draft as any).deviceName = "after-reject"; });
    expect((getConfig() as any).deviceName).toBe("after-reject");

    reloadConfig();
    expect((getConfig() as any).deviceName).toBe("after-reject");
    expect(tmpFiles()).toEqual([]);
  });

  it("refuses to load an oversized config without a .corrupt backup", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Sparse file: the stat cap must fire before the read, so the contents
    // never have to be valid JSON (or materialized on disk).
    fs.writeFileSync(configPath, "");
    fs.truncateSync(configPath, CONFIG_MAX_BYTES + 1);

    let error: any = null;
    try {
      reloadConfig();
    } catch (e: any) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigTooLargeError);
    expect(String(error.message)).toMatch(/too large/i);
    expect(String(error.message)).not.toMatch(/corrupt/i);
    expect(corruptFiles(), "an oversized file is not corruption").toEqual([]);
    expect(fs.statSync(configPath).size).toBe(CONFIG_MAX_BYTES + 1);
  });
});
