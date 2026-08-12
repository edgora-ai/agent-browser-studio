// Credential vault for sensitive strings stored in config.json.
//
// Properly signed desktop builds use Electron safeStorage. Local/ad-hoc macOS
// builds use an AES-256-GCM vault key stored beside config.json with mode 0600.
// This avoids repeated Keychain authorization prompts for binaries whose
// ad-hoc code requirement changes on every rebuild, while keeping plaintext
// out of config.json. Existing v1 Electron safeStorage values are migrated
// without being discarded.
import { execFileSync, spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";

const LEGACY_OS_MARKER = "v1:";
const OS_MARKER = "os1:";
const FILE_MARKER = "v2:";
const FILE_KEY_NAME = ".secret-vault-key";
const FILE_KEY_BYTES = 32;
const FILE_NONCE_BYTES = 12;
const FILE_TAG_BYTES = 16;
const FILE_AAD = Buffer.from("agent-browser-studio-secret-v2", "utf8");
const MAX_ENCRYPTED_BYTES = 1024 * 1024;
const MAC_SAFE_STORAGE_SERVICES = [
  "CloakLite Safe Storage",
  "Agent Browser Studio Safe Storage",
] as const;

export type SecretStorageBackend = "file" | "os" | "passthrough";

export interface OsSecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStoragePlan {
  backend: "file" | "os";
  reason: string;
  userDataDir: string;
  keyPath: string;
}

interface SecretStorageState {
  backend: SecretStorageBackend;
  key: Buffer | null;
  keyPath: string | null;
  osStorage: OsSecretStorage | null;
  legacyDecryptor: ((stored: string) => string) | null;
}

let state: SecretStorageState = {
  backend: "passthrough",
  key: null,
  keyPath: null,
  osStorage: null,
  legacyDecryptor: null,
};

const queriedMacServices = new Set<string>();
const legacyMacKeys: Buffer[] = [];

export function planSecretStorage(options: {
  userDataDir: string;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  execPath?: string;
  environment?: NodeJS.ProcessEnv;
  trustedMacSignature?: boolean;
}): SecretStoragePlan {
  const userDataDir = path.resolve(options.userDataDir);
  const keyPath = path.join(userDataDir, FILE_KEY_NAME);
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const forced = environment.AGENT_BROWSER_SECRET_BACKEND?.trim().toLowerCase();

  if (forced && forced !== "file" && forced !== "os") {
    throw new Error("AGENT_BROWSER_SECRET_BACKEND must be 'file' or 'os'");
  }
  if (forced === "file") return { backend: "file", reason: "environment override", userDataDir, keyPath };
  if (forced === "os") return { backend: "os", reason: "environment override", userDataDir, keyPath };

  // Once a file vault exists, keep using it across later signed upgrades so
  // already-encrypted v2 values remain readable.
  if (fs.existsSync(keyPath)) return { backend: "file", reason: "existing local vault", userDataDir, keyPath };

  if (platform !== "darwin") {
    return { backend: "os", reason: "native OS credential storage", userDataDir, keyPath };
  }

  const trusted = options.trustedMacSignature
    ?? Boolean(options.isPackaged && hasTrustedMacSignature(options.execPath || process.execPath));
  return trusted
    ? { backend: "os", reason: "verified team-signed macOS bundle", userDataDir, keyPath }
    : { backend: "file", reason: "local/ad-hoc macOS bundle", userDataDir, keyPath };
}

export function initializeSecretStorage(
  plan: SecretStoragePlan,
  options: {
    osStorage?: OsSecretStorage;
    legacyDecryptor?: (stored: string) => string;
  } = {},
): { backend: SecretStorageBackend; reason: string; keyPath: string | null } {
  resetSecretStorageState();
  state.legacyDecryptor = options.legacyDecryptor || null;

  if (plan.backend === "file") {
    state.key = loadOrCreateFileKey(plan.userDataDir, plan.keyPath);
    state.keyPath = plan.keyPath;
    state.backend = "file";
  } else {
    if (!options.osStorage) throw new Error("OS secret storage adapter is required");
    state.osStorage = options.osStorage;
    state.backend = "os";
    if (!usingEncryption()) throw new Error("OS-backed secret encryption is unavailable");
  }

  return { backend: state.backend, reason: plan.reason, keyPath: state.keyPath };
}

export function getSecretStorageBackend(): SecretStorageBackend {
  return state.backend;
}

/** True only when the selected backend can encrypt and decrypt values. */
export function usingEncryption(): boolean {
  if (state.backend === "file") return state.key?.length === FILE_KEY_BYTES;
  if (state.backend === "os") {
    try { return Boolean(state.osStorage?.isEncryptionAvailable()); }
    catch { return false; }
  }
  return false;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && (
    value.startsWith(LEGACY_OS_MARKER)
    || value.startsWith(OS_MARKER)
    || value.startsWith(FILE_MARKER)
  );
}

/** Encrypt plaintext for at-rest storage. Passthrough is retained only for
 * plain Node/test contexts that have not initialized a backend. */
export function encryptSecret(plain: string): string {
  if (plain == null) return plain;
  if (isEncrypted(plain)) return plain;
  if (!usingEncryption()) return plain;
  return state.backend === "file" ? encryptFileSecret(plain) : encryptOsSecret(plain);
}

/** Decrypt a stored secret for use. Plaintext values pass through. */
export function decryptSecret(stored: string): string {
  if (stored == null) return stored;
  if (stored.startsWith(FILE_MARKER)) return decryptFileSecret(stored);
  if (stored.startsWith(OS_MARKER)) return decryptOsSecret(stored, OS_MARKER);
  if (stored.startsWith(LEGACY_OS_MARKER)) return decryptLegacyOsSecret(stored);
  return stored;
}

/** Convert plaintext or a legacy encrypted value to the selected backend. */
export function migrateSecret(stored: string): string {
  if (stored == null || stored === "") return stored;
  if (!usingEncryption()) return stored;

  if (state.backend === "file") {
    if (stored.startsWith(FILE_MARKER)) return stored;
    const plain = isEncrypted(stored) ? decryptSecret(stored) : stored;
    return encryptFileSecret(plain);
  }

  if (stored.startsWith(OS_MARKER)) return stored;
  const plain = isEncrypted(stored) ? decryptSecret(stored) : stored;
  return encryptOsSecret(plain);
}

/** Decrypt if needed, never throw — consumption paths fail closed. */
export function decryptSecretOr(stored: string, fallback = ""): string {
  try { return decryptSecret(stored); } catch { return fallback; }
}

export function maybeEncrypt(plain: string): string {
  return encryptSecret(plain);
}

/** Remove legacy Keychain material from process memory after migration. */
export function clearLegacySecretMigrationCache(): void {
  for (const key of legacyMacKeys) key.fill(0);
  legacyMacKeys.length = 0;
  queriedMacServices.clear();
}

/** Test-only reset; production initializes once per application process. */
export function resetSecretStorageForTests(): void {
  resetSecretStorageState();
}

function resetSecretStorageState(): void {
  if (state.key) state.key.fill(0);
  clearLegacySecretMigrationCache();
  state = {
    backend: "passthrough",
    key: null,
    keyPath: null,
    osStorage: null,
    legacyDecryptor: null,
  };
}

function encryptFileSecret(plain: string): string {
  const key = requireFileKey();
  const nonce = randomBytes(FILE_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(FILE_AAD);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  return FILE_MARKER + payload.toString("base64");
}

function decryptFileSecret(stored: string): string {
  const key = requireFileKey();
  const payload = decodePayload(stored, FILE_MARKER);
  if (payload.length < FILE_NONCE_BYTES + FILE_TAG_BYTES) {
    throw new Error("Invalid local vault ciphertext");
  }
  const nonce = payload.subarray(0, FILE_NONCE_BYTES);
  const tag = payload.subarray(FILE_NONCE_BYTES, FILE_NONCE_BYTES + FILE_TAG_BYTES);
  const ciphertext = payload.subarray(FILE_NONCE_BYTES + FILE_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(FILE_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Local vault ciphertext authentication failed");
  }
}

function encryptOsSecret(plain: string): string {
  if (!state.osStorage || !usingEncryption()) throw new Error("OS secret storage is unavailable");
  return OS_MARKER + Buffer.from(state.osStorage.encryptString(plain)).toString("base64");
}

function decryptOsSecret(stored: string, marker: string): string {
  if (!state.osStorage || !usingEncryption()) throw new Error("OS secret storage is unavailable");
  return state.osStorage.decryptString(decodePayload(stored, marker));
}

function decryptLegacyOsSecret(stored: string): string {
  if (state.legacyDecryptor) return state.legacyDecryptor(stored);
  if (state.backend === "passthrough") {
    throw new Error("Legacy encrypted secret is present but credential storage is unavailable");
  }

  // Renaming a macOS Electron product also renames its Safe Storage service.
  // Read the legacy service once and decrypt all v1 values with the derived
  // key, instead of prompting once per field. No password is logged or saved.
  if (process.platform === "darwin") return decryptLegacyMacSecret(stored);

  // Windows DPAPI and compatible non-macOS backends are not product-name
  // bound, so the current safeStorage adapter can migrate the old marker.
  return decryptOsSecret(stored, LEGACY_OS_MARKER);
}

function decryptLegacyMacSecret(stored: string): string {
  const encrypted = decodePayload(stored, LEGACY_OS_MARKER);
  for (const key of legacyMacKeys) {
    const plain = tryDecryptMacSafeStorage(encrypted, key);
    if (plain !== null) return plain;
  }

  for (const service of MAC_SAFE_STORAGE_SERVICES) {
    if (queriedMacServices.has(service)) continue;
    queriedMacServices.add(service);
    const key = readMacSafeStorageKey(service);
    if (!key) continue;
    legacyMacKeys.push(key);
    const plain = tryDecryptMacSafeStorage(encrypted, key);
    if (plain !== null) return plain;
  }

  throw new Error("Legacy macOS secret could not be migrated; Keychain access was denied or the value is incompatible");
}

function readMacSafeStorageKey(service: string): Buffer | null {
  let password: Buffer | null = null;
  try {
    password = execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ], {
      encoding: "buffer",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4096,
    }) as Buffer;
    while (password.length && (password.at(-1) === 0x0a || password.at(-1) === 0x0d)) {
      password = password.subarray(0, -1);
    }
    if (!password.length) return null;
    return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  } catch (error: any) {
    // `security` exits 44 only when the item does not exist. A denial, cancel,
    // or timeout must stop migration instead of trying another service and
    // presenting a second authorization prompt.
    if (error?.status === 44) return null;
    throw new Error(`macOS denied access to ${service}; the encrypted value was left unchanged`);
  } finally {
    password?.fill(0);
  }
}

function tryDecryptMacSafeStorage(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length <= 3) return null;
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

function decodePayload(stored: string, marker: string): Buffer {
  const encoded = stored.slice(marker.length);
  if (!encoded || encoded.length > MAX_ENCRYPTED_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Invalid encrypted secret encoding");
  }
  const payload = Buffer.from(encoded, "base64");
  if (!payload.length || payload.length > MAX_ENCRYPTED_BYTES) {
    throw new Error("Invalid encrypted secret payload");
  }
  return payload;
}

function requireFileKey(): Buffer {
  if (state.backend !== "file" || state.key?.length !== FILE_KEY_BYTES) {
    throw new Error("Local secret vault is unavailable");
  }
  return state.key;
}

function loadOrCreateFileKey(userDataDir: string, keyPath: string): Buffer {
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(keyPath, "wx", 0o600);
    try {
      const key = randomBytes(FILE_KEY_BYTES);
      fs.writeFileSync(fd, key);
      fs.fsyncSync(fd);
      return key;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }

  const before = fs.lstatSync(keyPath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Local secret vault key must be a regular file");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error("Local secret vault key is owned by another user");
    }
    if ((before.mode & 0o077) !== 0) fs.chmodSync(keyPath, 0o600);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== FILE_KEY_BYTES) throw new Error("Local secret vault key has an invalid size");
    const key = Buffer.alloc(FILE_KEY_BYTES);
    const bytes = fs.readSync(fd, key, 0, key.length, 0);
    if (bytes !== FILE_KEY_BYTES) throw new Error("Local secret vault key could not be read completely");
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

function hasTrustedMacSignature(execPath: string): boolean {
  const appBundle = findContainingAppBundle(execPath);
  if (!appBundle) return false;
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle], {
      stdio: "ignore",
      timeout: 15_000,
    });
    const details = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appBundle], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    return details.status === 0
      && /TeamIdentifier=(?!not set\b)[A-Z0-9]+/.test(`${details.stdout}\n${details.stderr}`);
  } catch {
    return false;
  }
}

function findContainingAppBundle(execPath: string): string | null {
  const resolved = path.resolve(execPath);
  const marker = ".app/Contents/";
  const index = resolved.indexOf(marker);
  return index >= 0 ? resolved.slice(0, index + 4) : null;
}
