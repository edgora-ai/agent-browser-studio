// sale-90/92: license trial + activation semantics (offline, no network).
import { vi, describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "license-test-"));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
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
import { getConfig, getConfigPath, saveConfig, reloadConfig } from "../../src/main/services/config-manager.js";

import { ipcMain } from "electron";
import { registerLicenseHandlers } from "../../src/main/ipc/license.js";

async function readStatusHandler(): Promise<any> {
  vi.mocked(ipcMain.handle).mockClear();
  registerLicenseHandlers();
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === "license:status")?.[1];
  expect(handler).toBeTypeOf("function");
  return handler!({} as any);
}

const DAY = 24 * 60 * 60 * 1000;

function setProfileCount(count: number): void {
  const cfg = getConfig();
  cfg.browserProfiles = Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `fixture-profile-${i}`, { name: `Synthetic ${i}` },
  ])) as typeof cfg.browserProfiles;
  saveConfig(cfg);
  expect(Object.keys(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).browserProfiles)).toHaveLength(count);
  reloadConfig();
  expect(Object.keys(getConfig().browserProfiles)).toHaveLength(count);
}

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

describe("F10 readiness through the actual license:status handler", () => {
  it("reports no-key builds as trial-only and preserves both trial markers on disk/reload", async () => {
    setLicensePublicKeyForTests(""); // Explicitly avoids host env/resources keys.
    const st = await readStatusHandler();
    expect(st).toMatchObject({ plan: "trial", canActivate: false, expired: false });
    const disk = JSON.parse(fs.readFileSync(path.join(TEST_DATA, "license.json"), "utf8"));
    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(disk.trialStartedAt).toBe(st.trialStartedAt);
    expect(config.trialStartedAt).toBe(st.trialStartedAt);
    reloadConfig();
    expect((await readStatusHandler()).trialStartedAt).toBe(st.trialStartedAt);
    expect(getConfig().deviceId).toBe(st.deviceId);
  });
  it("reports an ephemeral valid test public key as activation-ready without granting a license", async () => {
    const { pubB64 } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    expect(await readStatusHandler()).toMatchObject({ plan: "trial", canActivate: true, expired: false });
    expect(getLicenseState().plan).toBe("trial");
    expect(activateLicense("not-a-code").code).toBe("INVALID_CODE");
  });
  it("does not advertise readiness for an unusable configured key", async () => {
    setLicensePublicKeyForTests("synthetic-invalid-key");
    expect(await readStatusHandler()).toMatchObject({ plan: "trial", canActivate: false });
    expect(verifyLicenseSignature("{}", "AAAA")).toBe(false);
  });
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

  it("trial: the tenth profile can be created, the eleventh cannot, and existing profiles still launch", () => {
    const now = Date.now();
    expect(getLicenseState(now)).toMatchObject({ plan: "trial", maxProfiles: 10 });
    setProfileCount(9);
    expect(checkCreateAllowed(now).allowed).toBe(true);
    expect(checkLaunchAllowed(now).allowed).toBe(true);
    setProfileCount(10);
    expect(checkCreateAllowed(now)).toMatchObject({ allowed: false, code: "PROFILE_LIMIT" });
    expect(checkLaunchAllowed(now)).toMatchObject({ allowed: true, state: { plan: "trial" } });
    setProfileCount(11); // An over-limit imported config still has launchable existing profiles.
    expect(checkCreateAllowed(now)).toMatchObject({ allowed: false, code: "PROFILE_LIMIT" });
    expect(checkLaunchAllowed(now).allowed).toBe(true);
    const expired = now + DEFAULT_TRIAL_DAYS * DAY;
    expect(checkCreateAllowed(expired).code).toBe("LICENSE_EXPIRED");
    expect(checkLaunchAllowed(expired).code).toBe("LICENSE_EXPIRED");
    expect(checkLaunchAllowed(now - 25 * 60 * 60 * 1000).code).toBe("LICENSE_EXPIRED");
  });

  it("signed capped paid: quota restricts creation, not launch; expiry still restricts both", () => {
    const { pubB64, privateKey } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    const now = Date.now();
    getLicenseState(now);
    const deviceId = String(getConfig().deviceId || "");
    const expiresAt = now + 30 * DAY;
    const code = mintCode(privateKey, {
      plan: "monthly", licensedTo: "synthetic purchaser", expiresAt,
      maxProfiles: 2, deviceId, issuedAt: now, nonce: "fixture-capped",
    });
    expect(activateLicense(code, now)).toMatchObject({ ok: true, state: { plan: "monthly", maxProfiles: 2 } });
    setProfileCount(1);
    expect(checkCreateAllowed(now).allowed).toBe(true);
    setProfileCount(2);
    expect(checkCreateAllowed(now)).toMatchObject({ allowed: false, code: "PROFILE_LIMIT" });
    expect(checkLaunchAllowed(now)).toMatchObject({ allowed: true, state: { plan: "monthly", maxProfiles: 2 } });
    setProfileCount(3);
    expect(checkCreateAllowed(now).code).toBe("PROFILE_LIMIT");
    expect(checkLaunchAllowed(now).allowed).toBe(true);
    const pastTrial = now + (DEFAULT_TRIAL_DAYS + 1) * DAY;
    expect(checkLaunchAllowed(pastTrial)).toMatchObject({ allowed: true, state: { plan: "monthly" } });
    // The expired signed license falls back to the original (now-expired) trial.
    expect(checkCreateAllowed(expiresAt).code).toBe("LICENSE_EXPIRED");
    expect(checkLaunchAllowed(expiresAt).code).toBe("LICENSE_EXPIRED");
    const disk = JSON.parse(fs.readFileSync(path.join(TEST_DATA, "license.json"), "utf8"));
    expect(disk.payload).toBeTruthy();
    expect(disk.signature).toBeTruthy();
    reloadConfig();
    expect(checkLaunchAllowed(now).allowed).toBe(true);
  });

  it("does not let an invalid signature or other device bypass an expired trial", () => {
    const { pubB64, privateKey } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    const now = Date.now();
    getLicenseState(now);
    setProfileCount(10);
    const expiredTrial = now + (DEFAULT_TRIAL_DAYS + 1) * DAY;
    const payload = {
      plan: "lifetime", licensedTo: "synthetic purchaser", expiresAt: null,
      maxProfiles: 10, deviceId: String(getConfig().deviceId || ""), issuedAt: now, nonce: "fixture-tamper",
    };
    const [, signature] = mintCode(privateKey, payload).split(".");
    const licenseFile = path.join(TEST_DATA, "license.json");
    const trialStartedAt = JSON.parse(fs.readFileSync(licenseFile, "utf8")).trialStartedAt;
    fs.writeFileSync(licenseFile, JSON.stringify({ payload: JSON.stringify({ ...payload, licensedTo: "tampered" }), signature, trialStartedAt }));
    expect(getLicenseState(now).plan).toBe("trial");
    expect(checkLaunchAllowed(expiredTrial).code).toBe("LICENSE_EXPIRED");
    const otherDevice = mintCode(privateKey, { ...payload, deviceId: "fixture-other-device" });
    const parsed = parseActivationCode(otherDevice)!;
    fs.writeFileSync(licenseFile, JSON.stringify({ payload: parsed.payload, signature: parsed.signatureB64, trialStartedAt }));
    expect(getLicenseState(now).plan).toBe("trial");
    expect(checkLaunchAllowed(expiredTrial).code).toBe("LICENSE_EXPIRED");
    expect(checkCreateAllowed(expiredTrial).code).toBe("LICENSE_EXPIRED");
  });
});

// F10: invoke the actual registered IPC handler, with an explicit override so
// these tests never inspect host environment/resource keys. Keys exist only
// inside this unit process; no signing fixture enters an app candidate.
describe("license:status activation readiness", () => {
  it("reports no-key trial-only truth and persists/reloads the same synthetic trial markers", async () => {
    setLicensePublicKeyForTests("");
    const status = await readStatusHandler();
    expect(status).toMatchObject({ plan: "trial", canActivate: false, expired: false, daysLeft: DEFAULT_TRIAL_DAYS });
    const disk = JSON.parse(fs.readFileSync(path.join(TEST_DATA, "license.json"), "utf8"));
    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(disk.trialStartedAt).toBe(status.trialStartedAt);
    expect(config.trialStartedAt).toBe(status.trialStartedAt);
    expect(config.deviceId).toBe(status.deviceId);
    reloadConfig();
    expect(await readStatusHandler()).toMatchObject({ canActivate: false, deviceId: status.deviceId, trialStartedAt: status.trialStartedAt });
  });
  it("reports ready with a unit-only ephemeral ed25519 public key without activating a license", async () => {
    const { pubB64 } = mintKeypair();
    setLicensePublicKeyForTests(pubB64);
    const status = await readStatusHandler();
    expect(status).toMatchObject({ canActivate: true, plan: "trial", expired: false });
    expect(JSON.parse(fs.readFileSync(path.join(TEST_DATA, "license.json"), "utf8")).payload).toBeUndefined();
    reloadConfig(); expect((await readStatusHandler()).canActivate).toBe(true);
  });
  it("reports unavailable for a malformed key without altering existing activation verification", async () => {
    setLicensePublicKeyForTests("not-a-public-key");
    expect((await readStatusHandler()).canActivate).toBe(false);
    expect(verifyLicenseSignature("{}", "AAAA")).toBe(false);
    setLicensePublicKeyForTests(Buffer.from("invalid DER bytes").toString("base64"));
    expect((await readStatusHandler()).canActivate).toBe(false);
  });
});
