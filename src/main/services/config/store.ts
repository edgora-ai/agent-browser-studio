import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAppDataDir, getConfigPath } from "./paths.js";

/**
 * Stateless transactional persistence for MgmtConfig (AR-1, single ownership).
 * config-manager owns the ONLY in-memory cache (`config`); this module is
 * purely the durable write path — unique tmp + rename + fsync on file and dir —
 * plus save-mode normalization. It holds no cache, so there is no second copy
 * of the config that can go stale (the dual-cache desync this replaces was the
 * root cause of silent stale reads and cross-test contamination).
 */
let baseProvider: (() => any) | null = null;
/** config-manager registers () => config so transact always drafts from the live value. */
export function setConfigBaseProvider(fn: (() => any) | null): void { baseProvider = fn; }
let normalizer: ((draft: any, mode: "load" | "save") => any) | null = null;
/** config-manager registers mergeConfig so saves land normalized; keeps this
 *  module free of a static (cyclic) dependency on config-manager. */
export function setNormalizer(fn: ((draft: any, mode: "load" | "save") => any) | null): void { normalizer = fn; }
let afterTransact: ((normalized: any) => void) | null = null;
/** config-manager registers (normalized) => { config = normalized } so every direct
 *  store.transact writer (skills, team, automation rules, trace trimming) keeps
 *  getConfig() in sync automatically. */
export function setAfterTransactHook(fn: ((normalized: any) => void) | null): void { afterTransact = fn; }

function requireBase(): any {
  if (!baseProvider) throw new Error("config store used before config-manager initialized (setConfigBaseProvider)");
  const base = baseProvider();
  if (base == null) throw new Error("config store drafted from an unloaded config — call getConfig()/reloadConfig() first");
  return base;
}

function fsyncFile(fd: number): void { try { fs.fsyncSync(fd); } catch {} }
function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}

export function readSnapshot(): any {
  // Deep readonly snapshot of the live config owned by config-manager.
  return structuredClone(requireBase());
}

export function transact<T>(mutate: (draft: any) => T, base?: any): T {
  const draft = structuredClone(base !== undefined ? base : requireBase());
  const result = mutate(draft);
  const normalized = normalizer ? normalizer(draft, "save") : draft;
  const tmp = getConfigPath() + ".tmp-" + randomUUID();
  const dir = path.dirname(getConfigPath());
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(normalized, null, 2), "utf-8");
    fsyncFile(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, getConfigPath());
  fsyncDir(dir);
  try { fs.chmodSync(getConfigPath(), 0o600); } catch {}
  if (afterTransact) { try { afterTransact(normalized); } catch { /* consumers must not break persistence */ } }
  return result;
}

