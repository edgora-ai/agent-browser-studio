import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decryptSecret,
  decryptSecretOr,
  encryptSecret,
  getSecretStorageBackend,
  initializeSecretStorage,
  isEncrypted,
  migrateSecret,
  planSecretStorage,
  resetSecretStorageForTests,
  usingEncryption,
} from "../../src/main/services/secrets.js";

// In the Node test runner, Electron safeStorage is unavailable, so the vault
// is in passthrough mode. These tests cover the logic + marker handling; the
// real encrypt/decrypt round-trip is proved in the Electron e2e (J34).

describe("secrets vault (passthrough mode — Node, no safeStorage)", () => {
  beforeEach(() => resetSecretStorageForTests());
  afterEach(() => resetSecretStorageForTests());

  it("reports encryption unavailable outside Electron", () => {
    expect(usingEncryption()).toBe(false);
  });

  it("detects the encrypted-value marker", () => {
    expect(isEncrypted("v1:YWJj")).toBe(true);
    expect(isEncrypted("os1:YWJj")).toBe(true);
    expect(isEncrypted("v2:YWJj")).toBe(true);
    expect(isEncrypted("plain-text")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it("passes plaintext through unchanged when encryption is unavailable", () => {
    expect(encryptSecret("sk-test")).toBe("sk-test");
    expect(decryptSecret("sk-test")).toBe("sk-test");
  });

  it("never double-encrypts an already-marked value", () => {
    expect(encryptSecret("v1:YWJj")).toBe("v1:YWJj");
  });

  it("decryptSecret throws on an encrypted value when the keychain is unavailable", () => {
    expect(() => decryptSecret("v1:YWJj")).toThrow(/credential storage is unavailable/);
  });

  it("decryptSecretOr falls back instead of throwing", () => {
    expect(decryptSecretOr("v1:YWJj", "fallback")).toBe("fallback");
    expect(decryptSecretOr("plain", "fallback")).toBe("plain");
  });

  it("null/undefined pass through safely", () => {
    expect(encryptSecret(null as any)).toBe(null);
    expect(decryptSecret(undefined as any)).toBe(undefined);
  });
});

describe("secrets vault (local file backend)", () => {
  let dir: string;

  beforeEach(() => {
    resetSecretStorageForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-secret-vault-"));
  });

  afterEach(() => {
    resetSecretStorageForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("selects the file vault for an ad-hoc macOS build", () => {
    const plan = planSecretStorage({
      userDataDir: dir,
      platform: "darwin",
      isPackaged: true,
      execPath: "/Applications/Agent Browser Studio.app/Contents/MacOS/Agent Browser Studio",
      trustedMacSignature: false,
      environment: {},
    });
    expect(plan.backend).toBe("file");
    initializeSecretStorage(plan);
    expect(getSecretStorageBackend()).toBe("file");
    expect(usingEncryption()).toBe(true);
  });

  it("round-trips authenticated v2 ciphertext without plaintext on disk", () => {
    const plan = planSecretStorage({ userDataDir: dir, platform: "darwin", trustedMacSignature: false, environment: {} });
    initializeSecretStorage(plan);
    const encrypted = encryptSecret("secret-value");
    expect(encrypted).toMatch(/^v2:/);
    expect(encrypted).not.toContain("secret-value");
    expect(decryptSecret(encrypted)).toBe("secret-value");
    if (process.platform !== "win32") expect(fs.statSync(plan.keyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(plan.keyPath)).toHaveLength(32);
  });

  it("keeps the vault readable across process-style reinitialization", () => {
    const plan = planSecretStorage({ userDataDir: dir, platform: "darwin", trustedMacSignature: false, environment: {} });
    initializeSecretStorage(plan);
    const encrypted = encryptSecret("persistent-secret");
    resetSecretStorageForTests();
    initializeSecretStorage(planSecretStorage({ userDataDir: dir, platform: "darwin", trustedMacSignature: true, environment: {} }));
    expect(getSecretStorageBackend()).toBe("file");
    expect(decryptSecret(encrypted)).toBe("persistent-secret");
  });

  it("rejects modified ciphertext", () => {
    const plan = planSecretStorage({ userDataDir: dir, platform: "darwin", trustedMacSignature: false, environment: {} });
    initializeSecretStorage(plan);
    const encrypted = encryptSecret("secret-value");
    const payload = Buffer.from(encrypted.slice(3), "base64");
    payload[payload.length - 1] ^= 1;
    expect(() => decryptSecret("v2:" + payload.toString("base64"))).toThrow(/authentication failed/);
  });

  it("migrates a legacy v1 value exactly once", () => {
    const plan = planSecretStorage({ userDataDir: dir, platform: "darwin", trustedMacSignature: false, environment: {} });
    let calls = 0;
    initializeSecretStorage(plan, {
      legacyDecryptor: (stored) => {
        calls++;
        expect(stored).toBe("v1:YWJj");
        return "legacy-secret";
      },
    });
    const migrated = migrateSecret("v1:YWJj");
    expect(migrated).toMatch(/^v2:/);
    expect(decryptSecret(migrated)).toBe("legacy-secret");
    expect(migrateSecret(migrated)).toBe(migrated);
    expect(calls).toBe(1);
  });
});

describe("secrets vault (team-signed OS backend)", () => {
  let dir: string;

  beforeEach(() => {
    resetSecretStorageForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-os-vault-"));
  });

  afterEach(() => {
    resetSecretStorageForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses a distinct os1 marker and migrates legacy values", () => {
    const plan = planSecretStorage({
      userDataDir: dir,
      platform: "darwin",
      isPackaged: true,
      trustedMacSignature: true,
      environment: {},
    });
    expect(plan.backend).toBe("os");
    initializeSecretStorage(plan, {
      osStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(plain, "utf8"),
        decryptString: (encrypted) => encrypted.toString("utf8"),
      },
      legacyDecryptor: () => "legacy-os-secret",
    });
    const encrypted = encryptSecret("os-secret");
    expect(encrypted).toMatch(/^os1:/);
    expect(decryptSecret(encrypted)).toBe("os-secret");
    const migrated = migrateSecret("v1:YWJj");
    expect(migrated).toMatch(/^os1:/);
    expect(decryptSecret(migrated)).toBe("legacy-os-secret");
  });
});

// migrateSecrets is a no-op when encryption is unavailable (Node), so calling
// it must not corrupt config. We exercise it against a temp config via the
// config-manager singleton reset path is heavy; instead assert the contract
// directly through the function's guard.
describe("migrateSecrets contract (Node passthrough)", () => {
  it("is a no-op returning 0 when encryption is unavailable", async () => {
    resetSecretStorageForTests();
    // Lazy import so the module graph (which pulls electron) loads once.
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sec-")), "config.json");
    fs.writeFileSync(tmp, JSON.stringify({ llm: { apiKey: "plaintext-key" } }), "utf-8");
    const { migrateSecrets } = await import("../../src/main/services/config-manager.js");
    const n = migrateSecrets();
    expect(n).toBe(0);
  });
});
