import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getConfigPath } from "./paths.js";
import { assertConfigSize } from "./limits.js";
import type { AccountReference, MgmtConfig, PlatformAccount, ProxyConfig } from "../../types.js";
import { createProxyWitness, isAuthenticatedProxyObservation, type AuthenticatedProxyObservation, type ProxyWitness } from "../proxy-observation.js";

/** One committed bundle, not a post-commit observer or a second config cache.
 * The detached account witness is only for change detection. Revisions are
 * private random snapshot nonces, never secret hashes or durable account IDs.
 * This synchronous store requires one admitted writer per user-data directory;
 * atomic rename does NOT provide multi-process compare-and-swap. */
interface CommittedState {
  config: MgmtConfig;
  accountWitness: PlatformAccount[];
  accountRevision: string;
  proxyWitness: Map<string, ProxyWitness>;
  proxyGeneration: Map<string, string>;
  proxyOrder: Map<string, Readonly<{ order: number; healthApplied: boolean }>>;
}
let committed: CommittedState | null = null;
let proxyWitnessAdapter = createProxyWitness;
export function setProxyWitnessAdapter(adapter: typeof createProxyWitness): void { proxyWitnessAdapter = adapter; }

// Empty handles cannot be forged/serialized into authority. All captured routing
// data stays in main; the witness itself contains no plaintext credentials.
export interface ProxyDetectionTarget { readonly __proxyTarget?: never; }
interface CapturedProxyTarget { name: string; generation: string; identity: string; config: ProxyConfig; }
const proxyTargets = new WeakMap<ProxyDetectionTarget, CapturedProxyTarget>();
export type ProxyDetectionErrorCode = "PROXY_DETECTION_TARGET_CHANGED" | "PROXY_DETECTION_STALE" | "PROXY_DETECTION_UNOBSERVED";
export class ProxyDetectionCommitError extends Error {
  constructor(public readonly code: ProxyDetectionErrorCode) { super(code); this.name = "ProxyDetectionCommitError"; }
}
export function captureProxyTarget(name: string): ProxyDetectionTarget | null {
  const state = requireState();
  const proxy = Object.hasOwn(state.config.proxies || {}, name) ? state.config.proxies[name] : null;
  const witness = state.proxyWitness.get(name);
  if (!proxy || !witness || proxyWitnessAdapter(proxy, witness).identity !== witness.identity) return null;
  const target = Object.freeze({});
  proxyTargets.set(target, { name, generation: state.proxyGeneration.get(name)!, identity: witness.identity, config: structuredClone(proxy) });
  return target;
}
export function proxyTargetDetails(target: ProxyDetectionTarget): CapturedProxyTarget {
  const captured = proxyTargets.get(target);
  if (!captured) throw new ProxyDetectionCommitError("PROXY_DETECTION_TARGET_CHANGED");
  return { ...captured, config: structuredClone(captured.config) };
}
function assertProxyTarget(target: ProxyDetectionTarget, config = requireState().config): CapturedProxyTarget {
  const captured = proxyTargets.get(target), state = requireState();
  const witness = captured && state.proxyWitness.get(captured.name);
  const proxy = captured && Object.hasOwn(config.proxies || {}, captured.name) && config.proxies[captured.name];
  if (!captured || !witness || !proxy || state.proxyGeneration.get(captured.name) !== captured.generation ||
      witness.identity !== captured.identity || proxyWitnessAdapter(proxy, witness).identity !== captured.identity) {
    throw new ProxyDetectionCommitError("PROXY_DETECTION_TARGET_CHANGED");
  }
  return captured;
}
/** No stale/duplicate write, and no snapshot-base transaction. Acceptance order
 * is published in the very same candidate as the two measurement projections. */
export function transactProxyObservation(target: ProxyDetectionTarget, stamp: AuthenticatedProxyObservation,
  mutate: (draft: MgmtConfig) => void): "committed" | "duplicate" {
  const captured = assertProxyTarget(target);
  if (!isAuthenticatedProxyObservation(stamp) || stamp.identity !== captured.identity || stamp.result.observedAt === null || stamp.result.source === "unknown") {
    throw new ProxyDetectionCommitError("PROXY_DETECTION_UNOBSERVED");
  }
  const accepted = requireState().proxyOrder.get(captured.name) || { order: 0, healthApplied: false };
  if (stamp.order < accepted.order) throw new ProxyDetectionCommitError("PROXY_DETECTION_STALE");
  // Cache-first informational publication does not consume the one real
  // network sample. Promote that SAME authenticated order once, atomically;
  // newer orders still fence older ones, and failed writes consume nothing.
  const healthApplied = stamp.result.source === "network";
  if (stamp.order === accepted.order && (accepted.healthApplied || !healthApplied)) return "duplicate";
  transact((draft: MgmtConfig) => { assertProxyTarget(target, draft); mutate(draft); }, undefined,
    { acceptedProxyObservation: { name: captured.name, generation: captured.generation, order: stamp.order, healthApplied } });
  return "committed";
}
let normalizer: ((draft: any, mode: "load" | "save") => any) | null = null;
export function setNormalizer(fn: ((draft: any, mode: "load" | "save") => any) | null): void { normalizer = fn; }
let afterTransact: ((normalized: any, draft: any) => void) | null = null;
/** Best-effort cleanup only. It cannot own config/revision publication. */
export function setAfterTransactHook(fn: ((normalized: any, draft: any) => void) | null): void { afterTransact = fn; }

export function getCommittedConfig(): MgmtConfig | null { return committed?.config ?? null; }
function prepareCommit(config: MgmtConfig, options: TransactionOptions = {}, loaded = false): CommittedState {
  const accountWitness = structuredClone(config.accounts || []);
  const accountRevision = options.forceAccountRevision || !committed || !isDeepStrictEqual(accountWitness, committed.accountWitness)
    ? randomUUID() : committed.accountRevision;
  const proxyWitness = new Map<string, ProxyWitness>(), proxyGeneration = new Map<string, string>();
  const proxyOrder: CommittedState["proxyOrder"] = new Map();
  for (const [name, proxy] of Object.entries(config.proxies || {})) {
    const previous = committed?.proxyWitness.get(name);
    const witness = proxyWitnessAdapter(proxy, previous);
    const changed = previous && witness.identity !== previous.identity;
    const reset = !previous || changed || options.invalidateProxyTargets === "all" || options.invalidateProxyTargets?.includes(name);
    proxyWitness.set(name, witness);
    proxyGeneration.set(name, reset ? randomUUID() : committed!.proxyGeneration.get(name)!);
    proxyOrder.set(name, !reset && committed?.proxyOrder.get(name) || Object.freeze({ order: 0, healthApplied: false }));
    // Shared-store writers (including sync) cannot retain measurements for a
    // genuinely changed route. Equal normalization/adoption of envelopes is not
    // replacement; explicit reload/reset uses its separate lifecycle option.
    if (changed && !loaded) {
      if (config.proxyDetections) delete config.proxyDetections[name];
      if (config.proxyHealth) delete config.proxyHealth[name];
    }
  }
  const observation = options.acceptedProxyObservation;
  if (observation) {
    if (proxyGeneration.get(observation.name) !== observation.generation) throw new ProxyDetectionCommitError("PROXY_DETECTION_TARGET_CHANGED");
    proxyOrder.set(observation.name, Object.freeze({ order: observation.order, healthApplied: observation.healthApplied }));
  }
  return { config, accountWitness, accountRevision, proxyWitness, proxyGeneration, proxyOrder };
}
/** Successful initial load/reload invalidates all references. Preparation may
 * throw, but the old config/witness/revision remain together until publication. */
export function adoptLoadedConfig(config: MgmtConfig): void {
  committed = prepareCommit(config, { forceAccountRevision: true, invalidateProxyTargets: "all" }, true);
}
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
export interface TransactionOptions {
  forceAccountRevision?: boolean;
  requireAccountRetention?: boolean;
  invalidateProxyTargets?: "all" | readonly string[];
  acceptedProxyObservation?: { name: string; generation: string; order: number; healthApplied: boolean };
}

export function transact<T>(mutate: (draft: any) => T, base?: any, options: TransactionOptions = {}): T {
  const draft = structuredClone(base !== undefined ? base : requireBase());
  const result = mutate(draft);
  const normalized = normalizer ? normalizer(draft, "save") : draft;
  if (options.requireAccountRetention && (!Array.isArray(draft.accounts) || !Array.isArray(normalized.accounts) || draft.accounts.length !== normalized.accounts.length)) {
    throw new AccountOperationError("ACCOUNT_VALIDATION_FAILED", "Normalization would drop or truncate an account");
  }
  // All fallible witness/nonce preparation occurs BEFORE writing or rename.
  const candidate = prepareCommit(normalized, options);
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
