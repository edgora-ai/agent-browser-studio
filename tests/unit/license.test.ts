// sale-90/92: license trial + activation semantics (offline, no network).
import { vi, describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "license-test-"));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_DATA : "/tmp"),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, "utf8"),
    decryptString: (enc: Buffer) => Buffer.from(enc).toString("utf8"),
  },
}));

import {
  getLicenseState,
  trialDaysLeft,
  isTrialExpired,
  verifyLicenseSignature,
  activateLicense,
  parseActivationCode,
  checkCreateAllowed,
  checkLaunchAllowed,
  setLicensePublicKeyForTests,
  DEFAULT_TRIAL_DAYS,
} from "../../src/main/services/license.js";
import { getConfig, saveConfig, reloadConfig } from "../../src/main/services/config-manager.js";

const DAY = 24 * 60 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint an activation code with a throwaway keypair (seller-side equivalent). */
function mintKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { pubB64: pubDer.toString("base64"), privateKey };
}

function mintCode(privateKey: any, payload: Record<string, unknown>): string {
  const body = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(body, "utf-8"), privateKey);
  return `${b64url(Buffer.from(body, "utf-8"))}.${b64url(sig)}`;
}

beforeEach(() => {
  try { fs.rmSync(path.join(TEST_DATA, "license.json"), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TEST_DATA, "config.json"), { force: true }); } catch { /* ignore */ }
  // The config module caches in memory — deleting files alone leaks the
  // previous test's trial marker. Reload forces a fresh read.
  reloadConfig();
  setLicensePublicKeyForTests(null);
});

describe("license trial (sale-90/92)", () => {
  it("starts a fresh 14-day trial on first launch", () => {
    const now = Date.now();
    const st = getLicenseState(now);
    expect(st.plan).toBe("trial");
    expect(st.trialStartedAt).toBe(now);
    expect(trialDaysLeft(now)).toBe(DEFAULT_TRIAL_DAYS);
    expect(isTrialExpired(now)).toBe(false);
  });

  it("expires after the trial window", () => {
    const now = Date.now();
    getLicenseState(now);
    const later = now + (DEFAULT_TRIAL_DAYS + 1) * DAY;
    expect(isTrialExpired(later)).toBe(true);
    expect(trialDaysLeft(later)).toBe(0);
  });

  it("clock rollback beyond grace voids the trial", () => {
    const now = Date.now();
    const st = getLicenseState(now);
    expect(st.trialStartedAt).toBe(now);
    const back = now - 25 * 60 * 60 * 1000;
    const st2 = getLicenseState(back);
    expect(st2.trialDays).toBe(0);
    expect(isTrialExpired(back)).toBe(true);
  });

  it("rejects signatures without a built-in public key", () => {
    expect(verifyLicenseSignature("{}", "AAAA")).toBe(false);
    expect(parseActivationCode("not-a-code")).toBe(null);
  });

  it("persists the trial marker through a config save round-trip", () => {
    const now = Date.now();
    getLicenseState(now);
    saveConfig(getConfig());
    reloadConfig();
    const cfg = getConfig() as any;
    expect(typeof cfg.trialStartedAt).toBe("number");
    // Reloaded marker still anchors the same trial (no reset).
    expect(getLicenseState(now + DAY).trialStartedAt).toBe(cfg.trialStartedAt);
  });
});

describe("license activation (sale-90 one-machine-one-code)", () => {
  it("activates a code bound to this device and stays valid past the trial window", () => {
    const { pubB64, privateKey } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    const now = Date.now();
    getLicenseState(now);
    const deviceId = String((getConfig() as any).deviceId || "");
    expect(deviceId).not.toBe("");
    const code = mintCode(privateKey, {
      plan: "yearly",
      licensedTo: "buyer-1",
      expiresAt: now + 365 * DAY,
      maxProfiles: null,
      deviceId,
      issuedAt: now,
      nonce: "n1",
    });
    const r = activateLicense(code, now);
    expect(r.ok).toBe(true);
    expect(r.state?.plan).toBe("yearly");
    // Past the trial window the license still holds.
    const later = getLicenseState(now + (DEFAULT_TRIAL_DAYS + 5) * DAY);
    expect(later.plan).toBe("yearly");
    expect(checkCreateAllowed(now + (DEFAULT_TRIAL_DAYS + 5) * DAY).allowed).toBe(true);
    expect(checkLaunchAllowed(now + (DEFAULT_TRIAL_DAYS + 5) * DAY).allowed).toBe(true);
  });

  it("rejects a code bound to another device (copy protection)", () => {
    const { pubB64, privateKey } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    const now = Date.now();
    getLicenseState(now);
    const code = mintCode(privateKey, {
      plan: "lifetime",
      licensedTo: "buyer-2",
      expiresAt: null,
      maxProfiles: null,
      deviceId: "someone-elses-device",
      issuedAt: now,
      nonce: "n2",
    });
    const r = activateLicense(code, now);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("DEVICE_MISMATCH");
    // A copied license file grants nothing either — falls back to trial.
    expect(getLicenseState(now).plan).toBe("trial");
  });

  it("rejects tampered payloads and expired codes", () => {
    const { pubB64, privateKey } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    const now = Date.now();
    getLicenseState(now);
    const deviceId = String((getConfig() as any).deviceId || "");
    const good = mintCode(privateKey, {
      plan: "monthly", licensedTo: "x", expiresAt: now + 30 * DAY,
      maxProfiles: null, deviceId, issuedAt: now, nonce: "n3",
    });
    const [body] = good.split(".");
    const tamperedBody = b64url(Buffer.from(JSON.stringify({
      plan: "lifetime", licensedTo: "x", expiresAt: null,
      maxProfiles: null, deviceId, issuedAt: now, nonce: "n3",
    }), "utf-8"));
    void body;
    // Signature from the monthly payload does not verify the lifetime body.
    expect(activateLicense(`${tamperedBody}.${good.split(".")[1]}`, now).code).toBe("INVALID_CODE");
    const expired = mintCode(privateKey, {
      plan: "monthly", licensedTo: "x", expiresAt: now - DAY,
      maxProfiles: null, deviceId, issuedAt: now - 60 * DAY, nonce: "n4",
    });
    expect(activateLicense(expired, now).code).toBe("EXPIRED_CODE");
  });
});

describe("license gates (sale-92 paywall)", () => {
  it("refuses create and launch after trial expiry", () => {
    const now = Date.now();
    getLicenseState(now);
    const later = now + (DEFAULT_TRIAL_DAYS + 1) * DAY;
    const c = checkCreateAllowed(later);
    expect(c.allowed).toBe(false);
    expect(c.code).toBe("LICENSE_EXPIRED");
    const l = checkLaunchAllowed(later);
    expect(l.allowed).toBe(false);
    expect(l.code).toBe("LICENSE_EXPIRED");
  });

  it("allows create and launch during trial and when licensed", () => {
    const now = Date.now();
    getLicenseState(now);
    expect(checkCreateAllowed(now).allowed).toBe(true);
    expect(checkLaunchAllowed(now).allowed).toBe(true);
  });
});
