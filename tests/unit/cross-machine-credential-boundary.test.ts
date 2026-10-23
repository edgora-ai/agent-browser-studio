// Cross-machine credential boundary without a second Mac.
//
// What actually differs between two Macs for credentials is (a) config.json
// bytes and (b) the secret backend behind Electron safeStorage (login Keychain).
// This moves the ciphertext into a second, independently initialized vault and
// asserts the product fails closed with a "re-enter the credential" message
// instead of using a swapped key. It does NOT prove a second physical Mac.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  decryptSecret, decryptSecretOr, encryptSecret, initializeSecretStorage,
  planSecretStorage, resetSecretStorageForTests, type OsSecretStorage,
} from "../../src/main/services/secrets.js";
import { normalizePortableProfileMeta, portableProfileContent } from "../../src/main/services/config-manager.js";
import { PORTABLE_PROFILE_FIELDS } from "../../src/main/services/profile-portability.js";

const SECRET = "synthetic-proxy-password-cross-machine";
let root: string;

function freshDir(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileVault(dir: string): void {
  resetSecretStorageForTests();
  initializeSecretStorage(planSecretStorage({ userDataDir: dir, platform: "darwin", isPackaged: true, trustedMacSignature: false, environment: {} }));
}

function osVault(dir: string, machineTag: string): { storage: OsSecretStorage; decrypted: string[] } {
  const decrypted: string[] = [];
  const storage: OsSecretStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(machineTag + ":" + plain, "utf8"),
    decryptString: (encrypted) => {
      const text = Buffer.from(encrypted).toString("utf8");
      const prefix = machineTag + ":";
      if (!text.startsWith(prefix)) throw new Error("keychain item belongs to a different key");
      decrypted.push(text);
      return text.slice(prefix.length);
    },
  };
  resetSecretStorageForTests();
  initializeSecretStorage(planSecretStorage({ userDataDir: dir, platform: "darwin", isPackaged: true, trustedMacSignature: true, environment: {} }), { osStorage: storage });
  return { storage, decrypted };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-machine-vault-"));
});

afterEach(() => {
  resetSecretStorageForTests();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("cross-machine-vault-")) {
    throw new Error("Unsafe cross-machine fixture cleanup");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cross-machine credential restore", () => {
  it("keeps cleartext out of config and fails closed when machine B's file vault receives A's value", () => {
    const a = freshDir("machine-a");
    fileVault(a);
    const ciphertext = encryptSecret(SECRET);
    expect(ciphertext.startsWith("v2:")).toBe(true);
    expect(ciphertext).not.toContain(SECRET);
    expect(decryptSecret(ciphertext)).toBe(SECRET);

    // B has its own userData, its own key file, and only the copied config bytes.
    const b = freshDir("machine-b");
    fileVault(b);
    expect(fs.existsSync(path.join(b, ".secret-vault-key"))).toBe(true);
    const fingerprint = (dir: string) => createHash("sha256").update(fs.readFileSync(path.join(dir, ".secret-vault-key"))).digest("hex");
    expect(fingerprint(b)).not.toBe(fingerprint(a));
    expect(ciphertext.startsWith("v2:")).toBe(true);

    // The user-visible outcome is a re-entry request, never a silent empty or
    // wrong credential handed to the proxy.
    expect(() => decryptSecretOr(ciphertext)).toThrow(/corrupt.*re-enter|re-enter the credential/i);
  });

  it("fails closed when a signed build's Keychain item is absent on the second machine", () => {
    const a = freshDir("machine-a");
    osVault(a, "machine-a");
    const ciphertext = encryptSecret(SECRET);
    expect(ciphertext.startsWith("os1:")).toBe(true);

    const b = freshDir("machine-b");
    const { storage } = osVault(b, "machine-b");
    // Simulate the second Mac's Keychain not holding A's item: safeStorage
    // cannot decrypt, which is what Electron reports as a decrypt failure.
    expect(storage.isEncryptionAvailable()).toBe(true);
    expect(() => decryptSecretOr(ciphertext)).toThrow(/corrupt.*different key|keychain item belongs/i);
    expect(() => decryptSecretOr(ciphertext)).toThrow(/re-enter the credential/i);
  });

  it("moves profile metadata but never device paths, sync bookkeeping, or credentials", () => {
    // same ID + same profile content on B; only the machine-local parts differ
    const stored = {
      name: "Cross machine", engine: "chromium", fingerprintMode: "managed", fingerprintSeed: 777,
      platform: "windows", proxyMode: "named", proxyName: "synthetic-node", timezone: "UTC", locale: "en-US",
      note: "synthetic note", tags: ["cross-machine"], updatedAt: 111, syncedAt: 222, syncedHash: "a".repeat(64),
      historySyncBaseline: { historyId: "a".repeat(64), exportedAt: 333, sha256: "b".repeat(64) },
      syncedPreferences: { state: "present" }, fontsDir: "/Users/someone/Documents/fonts", lock: { owner: 1 },
      proxyPassword: SECRET, vaultKeyPath: "/Users/someone/Library/Application Support/agent/.secret-vault-key",
    };
    const portable = portableProfileContent(stored);
    const serialized = JSON.stringify(portable);
    // Exact projection: every whitelisted field except the two conditional ones,
    // and nothing outside the whitelist (no local paths or bookkeeping leak in).
    const conditional = new Set<string>(["windowTitlePrefix", "fingerprintBaseline"]);
    expect(Object.keys(portable).sort()).toEqual(
      [...PORTABLE_PROFILE_FIELDS].filter((key) => !conditional.has(key)).sort(),
    );
    expect(portable.name).toBe("Cross machine");
    expect(portable.fingerprintSeed).toBe(777);
    expect(portable.proxyName).toBe("synthetic-node");
    for (const forbidden of ["updatedAt", "syncedAt", "syncedHash", "historySyncBaseline", "syncedPreferences", "fontsDir", "lock", "proxyPassword", "vaultKeyPath"]) {
      expect(portable).not.toHaveProperty(forbidden);
    }
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(".secret-vault-key");
    expect(serialized).not.toContain("/Users/");

    // The import path rebuilds only explicit portable fields; unknown keys from
    // another machine are ignored rather than adopted as local state.
    const imported = normalizePortableProfileMeta({ ...portable, updatedAt: 1, syncedHash: "c".repeat(64), localPath: "/tmp/x" });
    expect(imported.name).toBe("Cross machine");
    expect(imported.syncedHash).toBeUndefined();
    expect((imported as any).localPath).toBeUndefined();
  });

  it("decrypts only when the receiving machine actually holds the same key material", () => {
    const a = freshDir("machine-a");
    fileVault(a);
    const ciphertext = encryptSecret(SECRET);

    // The boundary is the key, not config.json: copying the key (which the
    // product never does) is the one way the value becomes readable on B.
    const b = freshDir("machine-b");
    fileVault(b);
    fs.copyFileSync(path.join(a, ".secret-vault-key"), path.join(b, ".secret-vault-key"));
    resetSecretStorageForTests();
    initializeSecretStorage(planSecretStorage({ userDataDir: b, platform: "darwin", isPackaged: true, trustedMacSignature: false, environment: {} }));
    expect(decryptSecret(ciphertext)).toBe(SECRET);
  });
});
