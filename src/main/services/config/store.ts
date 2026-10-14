import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getConfigPath } from "./paths.js";
import { assertConfigSize } from "./limits.js";
import type { AccountReference, MgmtConfig, PlatformAccount } from "../../types.js";

/** One committed bundle, not a post-commit observer or a second config cache.
 * The detached account witness is only for change detection. Revisions are
 * private random snapshot nonces, never secret hashes or durable account IDs.
 * This synchronous store requires one admitted writer per user-data directory;
 * atomic rename does NOT provide multi-process compare-and-swap. */
interface CommittedState {
  config: MgmtConfig;
  accountWitness: PlatformAccount[];
  accountRevision: string;
}
let committed: CommittedState | null = null;
let normalizer: ((draft: any, mode: "load" | "save") => any) | null = null;
export function setNormalizer(fn: ((draft: any, mode: "load" | "save") => any) | null): void { normalizer = fn; }
let afterTransact: ((normalized: any, draft: any) => void) | null = null;
/** Best-effort cleanup only. It cannot own config/revision publication. */
export function setAfterTransactHook(fn: ((normalized: any, draft: any) => void) | null): void { afterTransact = fn; }

export function getCommittedConfig(): MgmtConfig | null { return committed?.config ?? null; }
function prepareCommit(config: MgmtConfig, forceAccountRevision: boolean): CommittedState {
  const accountWitness = structuredClone(config.accounts || []);
  const accountRevision = forceAccountRevision || !committed || !isDeepStrictEqual(accountWitness, committed.accountWitness)
    ? randomUUID() : committed.accountRevision;
  return { config, accountWitness, accountRevision };
}
/** Successful initial load/reload invalidates all references. Preparation may
 * throw, but the old config/witness/revision remain together until publication. */
export function adoptLoadedConfig(config: MgmtConfig): void { committed = prepareCommit(config, true); }
function requireState(): CommittedState {
  if (!committed) throw new Error("config store used before getConfig()/reloadConfig()");
  return committed;
}
function requireBase(): MgmtConfig { return requireState().config; }

export type AccountErrorCode = "ACCOUNT_REFERENCE_REQUIRED" | "ACCOUNT_REFERENCE_INVALID" | "ACCOUNT_REFERENCE_CONFLICT" | "ACCOUNT_NOT_FOUND" | "ACCOUNT_VALIDATION_FAILED";
export class AccountOperationError extends Error {
  constructor(public readonly code: AccountErrorCode, detail: string) {
    // Electron may serialize only the message. Keep an exact stable identity in it.
    super(`${code}: ${detail}`);
    this.name = "AccountOperationError";
  }
}
/** Validation is synchronous. Mutators invoke it INSIDE the live-base draft
 * callback; guarded read callers use it without a persistence transaction. */
export function assertAccountReference(index: number, reference: unknown, accounts: PlatformAccount[]): asserts reference is AccountReference {
  if (reference === undefined || reference === null) throw new AccountOperationError("ACCOUNT_REFERENCE_REQUIRED", "A displayed account reference is required");
  const ref = reference as AccountReference;
  if (typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).length !== 2 || Object.keys(reference).some(k => k !== "index" && k !== "revision")
    || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(ref.index) || ref.index !== index
    || typeof ref.revision !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.revision)) {
    throw new AccountOperationError("ACCOUNT_REFERENCE_INVALID", "Malformed or mismatched account reference");
  }
  const state = requireState();
  if (ref.revision !== state.accountRevision || !isDeepStrictEqual(accounts, state.accountWitness)) {
    throw new AccountOperationError("ACCOUNT_REFERENCE_CONFLICT", "Account snapshot changed; explicitly reselect the account");
  }
  if (index >= accounts.length) throw new AccountOperationError("ACCOUNT_NOT_FOUND", "Account not found in current snapshot");
}
export function readAccountSnapshot(): { accounts: PlatformAccount[]; revision: string } {
  const state = requireState();
  if (!isDeepStrictEqual(state.config.accounts || [], state.accountWitness)) {
    throw new AccountOperationError("ACCOUNT_REFERENCE_CONFLICT", "Uncommitted account changes cannot be referenced");
  }
  return { accounts: structuredClone(state.config.accounts || []), revision: state.accountRevision };
}

function fsyncFile(fd: number): void { try { fs.fsyncSync(fd); } catch {} }
function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}
export function readSnapshot(): any { return structuredClone(requireBase()); }
export interface TransactionOptions { forceAccountRevision?: boolean; requireAccountRetention?: boolean; }

export function transact<T>(mutate: (draft: any) => T, base?: any, options: TransactionOptions = {}): T {
  const draft = structuredClone(base !== undefined ? base : requireBase());
  const result = mutate(draft);
  const normalized = normalizer ? normalizer(draft, "save") : draft;
  if (options.requireAccountRetention && (!Array.isArray(draft.accounts) || !Array.isArray(normalized.accounts) || draft.accounts.length !== normalized.accounts.length)) {
    throw new AccountOperationError("ACCOUNT_VALIDATION_FAILED", "Normalization would drop or truncate an account");
  }
  // All fallible witness/nonce preparation occurs BEFORE writing or rename.
  const candidate = prepareCommit(normalized, Boolean(options.forceAccountRevision));
  const text = JSON.stringify(normalized, null, 2);
  assertConfigSize(Buffer.byteLength(text, "utf8"));
  const configPath = getConfigPath();
  const tmp = configPath + ".tmp-" + randomUUID();
  const dir = path.dirname(configPath);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf-8");
    fsyncFile(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, configPath);
  // The commit point. One non-fallible pointer publication, before fsync,
  // chmod or replaceable cleanup. Post-rename failures cannot imply rollback.
  committed = candidate;
  fsyncDir(dir);
  try { fs.chmodSync(configPath, 0o600); } catch {}
  if (afterTransact) { try { afterTransact(normalized, draft); } catch (e) { console.error("[config] post-commit hook failed:", e); } }
  return result;
}
/** Account writers have NO optional caller-supplied base. Every explicit
 * successful write (even equal replacement) rotates the collection revision. */
export function transactAccounts<T>(mutate: (draft: MgmtConfig) => T): T {
  return transact(mutate, undefined, { forceAccountRevision: true, requireAccountRetention: true });
}
