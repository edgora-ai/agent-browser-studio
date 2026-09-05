// Sale-90/92: offline license + trial. Design constraints:
// - No network: verify ed25519 signatures locally with a release-embedded
//   public key (env override for dev/tests).
// - One-machine-one-code (#90): the payload carries deviceId; a license file
//   copied to another machine falls back to trial (fail-closed, data kept).
// - Trial: first-launch timestamp persisted in two places (license.json +
//   config.json trialStartedAt marker); clock rollback beyond 24h grace voids
//   the trial. The config marker survives save round-trips via an explicit
//   mergeConfig branch (the strict whitelist would otherwise drop it).
// - Fail-closed on tamper, fail-open (trial) on first install.
// - Secrets: license file is 0600; never log the license key or code.
import * as fs from "node:fs";
import * as path from "node:path";
import { verify } from "node:crypto";
import { getAppDataDir, getConfig, saveConfig } from "./config-manager.js";

export type LicensePlan = "trial" | "monthly" | "yearly" | "lifetime";

export interface LicenseState {
  plan: LicensePlan;
  trialStartedAt: number | null;
  trialDays: number;
  licensedTo: string | null;
  expiresAt: number | null;
  maxProfiles: number | null;
  /** Device this license is bound to (null = unbound/trial). */
  deviceId: string | null;
}

/** Signed activation payload (minted offline by the seller tool). */
export interface LicensePayload {
  plan: Exclude<LicensePlan, "trial">;
  licensedTo: string;
  expiresAt: number | null;
  maxProfiles: number | null;
  deviceId: string;
  issuedAt: number;
  nonce: string;
  /**
   * Paddle linkage (sale-100): MoR order/subscription ids carried opaquely so
   * support can join a license dispute to the Paddle transaction. Unsigned
   * consumers must treat these as display-only (the signature covers them,
   * but no money logic reads them locally).
   */
  paddleOrderId?: string | null;
  paddleSubscriptionId?: string | null;
}

export interface ActivateResult {
  ok: boolean;
  state?: LicenseState;
  /** Machine-readable failure: INVALID_CODE | NO_PUBKEY | EXPIRED_CODE | DEVICE_MISMATCH | WRITE_FAILED. */
  code?: string;
  error?: string;
}

const LICENSE_FILE = "license.json";
const PUBKEY_FILE = "license-pubkey.txt";
export const TRIAL_MARKER_KEY = "trialStartedAt";
export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_TRIAL_MAX_PROFILES = 10;

const CLOCK_SKEW_GRACE_MS = 24 * 60 * 60 * 1000;

// Test override (env/file reads are static-hostile under vitest module
// evaluation order — imports evaluate before the test body can set env).
let testPubkeyOverride: string | null = null;
/** Test-only hook: inject the public key without touching env or disk. */
export function setLicensePublicKeyForTests(b64: string | null): void {
  testPubkeyOverride = b64;
}

/**
 * Release-embedded ed25519 public key (SPKI DER base64).
 * Precedence: test override → AGENT_BROWSER_LICENSE_PUBKEY env →
 * <resources>/license-pubkey.txt (written by `npm run license:inject`
 * between build and package) → "" (trial only, no license accepted).
 */
export function getLicensePublicKeyB64(): string {
  if (testPubkeyOverride !== null) return testPubkeyOverride;
  if (process.env.AGENT_BROWSER_LICENSE_PUBKEY) return process.env.AGENT_BROWSER_LICENSE_PUBKEY;
  try {
    const resPath = (process as any)?.resourcesPath;
    if (typeof resPath === "string" && resPath) {
      const p = path.join(resPath, PUBKEY_FILE);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8").trim();
    }
  } catch { /* packaged path unavailable (dev/test) */ }
  return "";
}

function licensePath(): string {
  return path.join(getAppDataDir(), LICENSE_FILE);
}

function readLicenseFile(): any | null {
  try {
    const p = licensePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeLicenseFile(next: any): boolean {
  try {
    const dir = getAppDataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = licensePath();
    const fd = fs.openSync(p, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(next, null, 2), "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(p, 0o600); } catch { /* non-POSIX */ }
    return true;
  } catch {
    return false;
  }
}

function localDeviceId(): string {
  try {
    return String((getConfig() as any)?.deviceId || "");
  } catch {
    return "";
  }
}

function firstLaunchAt(): number {
  // Two independent markers make casual reinstall-reset harder: the license
  // file itself plus the config marker. Earliest wins.
  const marks: number[] = [];
  try {
    const cfg = getConfig() as any;
    if (typeof cfg?.[TRIAL_MARKER_KEY] === "number" && cfg[TRIAL_MARKER_KEY] > 0) {
      marks.push(cfg[TRIAL_MARKER_KEY]);
    }
  } catch { /* config unreadable — ignore */ }
  const lf = readLicenseFile();
  if (lf && typeof lf.trialStartedAt === "number" && lf.trialStartedAt > 0) {
    marks.push(lf.trialStartedAt);
  }
  if (!marks.length) return 0;
  return Math.min(...marks);
}

function persistTrialStart(ts: number): void {
  try {
    // Marker 1: license.json (0600).
    const cur = readLicenseFile() || {};
    if (typeof cur.trialStartedAt !== "number" || cur.trialStartedAt <= 0) {
      cur.trialStartedAt = ts;
      writeLicenseFile(cur);
    }
    // Marker 2: config.json — survives license.json deletion. Written
    // through saveConfig so the value is normalized, not raw-merged.
    try {
      const cfg = getConfig() as any;
      if (typeof cfg[TRIAL_MARKER_KEY] !== "number" || cfg[TRIAL_MARKER_KEY] <= 0) {
        cfg[TRIAL_MARKER_KEY] = ts;
        saveConfig(cfg);
      }
    } catch { /* config unwritable — license.json marker still stands */ }
  } catch { /* best effort — trial still works in-memory */ }
}

export function verifyLicenseSignature(payload: string, signatureB64: string): boolean {
  const pubB64 = getLicensePublicKeyB64();
  if (!pubB64) return false;
  try {
    const pub = Buffer.from(pubB64, "base64");
    const key = { key: pub, format: "der" as const, type: "spki" as const };
    return verify(null, Buffer.from(payload, "utf-8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Activation code format: base64url(payloadJson) + "." + base64url(signature). */
export function parseActivationCode(code: string): { payload: string; signatureB64: string } | null {
  if (typeof code !== "string") return null;
  const parts = code.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const payload = Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const signatureB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    JSON.parse(payload);
    return { payload, signatureB64 };
  } catch {
    return null;
  }
}

function sanitizePayload(data: any): LicensePayload | null {
  if (!data || typeof data !== "object") return null;
  const plan = data.plan;
  if (plan !== "monthly" && plan !== "yearly" && plan !== "lifetime") return null;
  if (typeof data.deviceId !== "string" || !data.deviceId) return null;
  const expiresAt = data.expiresAt === null || data.expiresAt === undefined ? null : data.expiresAt;
  if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) return null;
  return {
    plan,
    licensedTo: typeof data.licensedTo === "string" ? data.licensedTo.slice(0, 120) : "",
    expiresAt,
    maxProfiles: typeof data.maxProfiles === "number" && Number.isFinite(data.maxProfiles) ? data.maxProfiles : null,
    deviceId: String(data.deviceId).slice(0, 64),
    issuedAt: typeof data.issuedAt === "number" ? data.issuedAt : 0,
    nonce: typeof data.nonce === "string" ? data.nonce.slice(0, 64) : "",
    paddleOrderId: typeof data.paddleOrderId === "string" ? data.paddleOrderId.slice(0, 64) || null : null,
    paddleSubscriptionId: typeof data.paddleSubscriptionId === "string" ? data.paddleSubscriptionId.slice(0, 64) || null : null,
  };
}

/**
 * Activate with an offline code (sale-90). One-machine-one-code: the payload
 * deviceId must equal this install's deviceId (换机 = seller re-mints).
 * Never throws for bad input — returns a coded result instead.
 * Never logs the code.
 */
export function activateLicense(code: string, now = Date.now()): ActivateResult {
  const parsed = parseActivationCode(code);
  if (!parsed) return { ok: false, code: "INVALID_CODE", error: "Invalid activation code format" };
  if (!getLicensePublicKeyB64()) {
    return { ok: false, code: "NO_PUBKEY", error: "This build cannot verify licenses (trial only)" };
  }
  if (!verifyLicenseSignature(parsed.payload, parsed.signatureB64)) {
    return { ok: false, code: "INVALID_CODE", error: "Signature verification failed" };
  }
  const data = sanitizePayload(JSON.parse(parsed.payload));
  if (!data) return { ok: false, code: "INVALID_CODE", error: "License payload rejected" };
  if (data.plan !== "lifetime" && (data.expiresAt === null || data.expiresAt <= now)) {
    return { ok: false, code: "EXPIRED_CODE", error: "This activation code has expired" };
  }
  const me = localDeviceId();
  if (data.deviceId !== me) {
    return {
      ok: false,
      code: "DEVICE_MISMATCH",
      error: "This code is bound to another device — ask the seller for a transfer (换机) code",
    };
  }
  const cur = readLicenseFile() || {};
  const next = {
    payload: parsed.payload,
    signature: parsed.signatureB64,
    activatedAt: now,
    deviceId: me,
    trialStartedAt: typeof cur.trialStartedAt === "number" ? cur.trialStartedAt : now,
  };
  if (!writeLicenseFile(next)) {
    return { ok: false, code: "WRITE_FAILED", error: "Could not persist the license file" };
  }
  return { ok: true, state: getLicenseState(now) };
}

export function getLicenseState(now = Date.now()): LicenseState {
  const base: LicenseState = {
    plan: "trial",
    trialStartedAt: null,
    trialDays: DEFAULT_TRIAL_DAYS,
    licensedTo: null,
    expiresAt: null,
    maxProfiles: DEFAULT_TRIAL_MAX_PROFILES,
    deviceId: null,
  };
  // Licensed path: signed payload in license.json.
  const lf = readLicenseFile();
  if (lf && typeof lf.payload === "string" && typeof lf.signature === "string") {
    if (verifyLicenseSignature(lf.payload, lf.signature)) {
      try {
        const data = sanitizePayload(JSON.parse(lf.payload));
        // Device binding (sale-90): a license file copied to another machine
        // grants nothing — fall through to trial instead of erroring, so no
        // data is ever lost and the UI can show the trial banner.
        if (data && (!data.deviceId || data.deviceId === localDeviceId())) {
          if (data.plan === "lifetime" || (data.expiresAt !== null && data.expiresAt > now)) {
            return {
              plan: data.plan,
              trialStartedAt: typeof lf.trialStartedAt === "number" ? lf.trialStartedAt : null,
              trialDays: DEFAULT_TRIAL_DAYS,
              licensedTo: data.licensedTo || null,
              expiresAt: data.expiresAt,
              maxProfiles: data.maxProfiles,
              deviceId: data.deviceId,
            };
          }
        }
      } catch { /* tampered payload — fall through to trial */ }
    }
  }
  // Trial path.
  let started = firstLaunchAt();
  if (!started) {
    started = now;
    persistTrialStart(now);
  }
  // Clock rollback beyond grace: trial invalid (anti-tamper), not extended.
  if (now < started - CLOCK_SKEW_GRACE_MS) {
    return { ...base, trialStartedAt: started, trialDays: 0, maxProfiles: 0 };
  }
  return { ...base, trialStartedAt: started };
}

export function trialDaysLeft(now = Date.now()): number {
  const st = getLicenseState(now);
  if (st.plan !== "trial" || st.trialStartedAt === null) return st.plan === "trial" ? st.trialDays : Infinity;
  // Voided trial (clock rollback) reports 0 regardless of arithmetic.
  if (st.trialDays <= 0) return 0;
  const elapsed = now - st.trialStartedAt;
  const total = st.trialDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((total - elapsed) / (24 * 60 * 60 * 1000)));
}

export function isTrialExpired(now = Date.now()): boolean {
  const st = getLicenseState(now);
  if (st.plan !== "trial") return false;
  return trialDaysLeft(now) <= 0;
}

// ── Enforcement gates (sale-90/92) ─────────────────────────────────────────
// Checked at the IPC boundary (browser:create / browser:launch), NOT inside
// the browser-manager services, so unit tests calling services directly and
// e2e (fresh isolated userDataDir = fresh trial per test) keep working.
// The renderer maps gate codes to the paywall dialog; data is never touched.
export interface LicenseGate {
  allowed: boolean;
  /** LICENSE_EXPIRED | PROFILE_LIMIT — renderer opens the paywall dialog. */
  code?: string;
  error?: string;
  state: LicenseState;
}

function activeProfileCount(): number {
  try {
    const profiles = (getConfig() as any)?.browserProfiles;
    return profiles && typeof profiles === "object" ? Object.keys(profiles).length : 0;
  } catch {
    return 0;
  }
}

function evaluateGate(now: number): LicenseGate {
  const state = getLicenseState(now);
  if (state.plan !== "trial") {
    if (state.expiresAt !== null && state.expiresAt <= now) {
      return {
        allowed: false,
        code: "LICENSE_EXPIRED",
        error: "License expired — renew to keep creating and launching profiles. Your data is untouched.",
        state,
      };
    }
    if (typeof state.maxProfiles === "number" && activeProfileCount() >= state.maxProfiles) {
      return {
        allowed: false,
        code: "PROFILE_LIMIT",
        error: `Profile limit reached (${state.maxProfiles}). Delete unused profiles or upgrade — your data is untouched.`,
        state,
      };
    }
    return { allowed: true, state };
  }
  if (isTrialExpired(now)) {
    return {
      allowed: false,
      code: "LICENSE_EXPIRED",
      error: "Trial expired — activate a license to keep going. Your profiles and data are untouched.",
      state,
    };
  }
  if (typeof state.maxProfiles === "number" && activeProfileCount() >= state.maxProfiles) {
    return {
      allowed: false,
      code: "PROFILE_LIMIT",
      error: `Trial profile limit reached (${activeProfileCount()}/${state.maxProfiles}). Activate a license for more — your data is untouched.`,
      state,
    };
  }
  return { allowed: true, state };
}

/** Gate for browser:create — trial expiry or profile cap refuses new profiles. */
export function checkCreateAllowed(now = Date.now()): LicenseGate {
  return evaluateGate(now);
}

/** Gate for browser:launch — same policy: lock features, never data. */
export function checkLaunchAllowed(now = Date.now()): LicenseGate {
  return evaluateGate(now);
}
