// Audit log — append-only record of sensitive operations (profile launch/stop,
// credential/proxy/fingerprint changes, sync, automation runs, agent dangerous
// tools). Answers "who did what to which asset, when" — the team-governance
// gap the scenario eval flagged. Stored as JSONL in the app data dir, ring-
// buffered to CAP entries. No Electron deps beyond getAppDataDir → unit-testable.
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir } from "./config-manager.js";
import { redactSensitive } from "./observability.js";

export interface AuditEntry {
  id: string;
  at: number;
  category: string;   // "profile" | "proxy" | "account" | "llm" | "sync" | "automation" | "agent" | "settings"
  action: string;     // e.g. "launch", "stop", "delete", "save"
  target?: string;    // e.g. dirId / proxy name / rule name
  actor?: string;     // "user" | "automation:<ruleId>" | "agent:<runId>"
  detail?: string;    // short human summary (no secrets)
}

const CAP = 2000;
/** Per-entry size cap (R7 #37): a 50 MB detail line must not land verbatim. */
const MAX_ENTRY_BYTES = 8 * 1024;
let _path: string | null = null;

function logPath(): string {
  if (!_path) _path = path.join(getAppDataDir(), "audit.log.jsonl");
  return _path;
}

/** Override the log path (tests inject a temp file). */
export function _setAuditPathForTesting(p: string | null): void {
  _path = p;
}

let _seq = 0;
function newId(): string {
  _seq = (_seq + 1) % 1_000_000;
  return `a_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/** Ensure the audit log exists owner-only before first append. */
function sealLogFile(p: string): void {
  try {
    const fd = fs.openSync(p, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  try { fs.chmodSync(p, 0o600); } catch { /* best effort on non-POSIX */ }
}

/** Append an audit entry. Safe to call from hot paths — best-effort, never throws.
 * The log may carry URLs/SQL/paths, so the file is owner-only (0600) — created
 * with O_CREAT|O_EXCL when missing, chmod-enforced on every append.
 * Entry fields are length-capped (R7 #37): unbounded detail/target strings
 * are truncated with a marker instead of landing verbatim.
 * R10 P1-1: fields pass through redactSensitive at the single choke point,
 * so a careless caller (e.g. SQL verbatim in detail) cannot land a secret —
 * the previous "no secrets" contract relied on all 119 callers being careful. */
function capField(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || !v) return v as string | undefined;
  if (Buffer.byteLength(v, "utf8") <= max) return v;
  // R12 P3-3: truncate on code-point boundary so a surrogate pair / multibyte
  // char is never split (String.slice cuts UTF-16 units).
  const chars = Array.from(v);
  let bytes = 0;
  let cut = 0;
  for (const ch of chars) {
    const len = Buffer.byteLength(ch, "utf8");
    if (bytes + len > max) break;
    bytes += len;
    cut++;
  }
  return chars.slice(0, cut).join("") + `…[truncated ${v.length} chars]`;
}

/** Scrub `password=...` / `token: ...` style pairs inside free text (SQL, error strings). */
function scrubInlineSecrets(text: string): string {
  return text
    .replace(
      /(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|bearer)\s*[:=]\s*['"]?[^'"\s,}]+['"]?/gi,
      "$1=[redacted]",
    )
    // R12 P3-3: space-separated auth headers ("Bearer abc123",
    // "Authorization Bearer xyz") carry the token after a bare space.
    .replace(
      /\b(bearer|authorization)\s+([A-Za-z0-9\-._~+/]+=*)/gi,
      "$1 [redacted]",
    );
}

function safeField(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || !v) return v as string | undefined;
  return scrubInlineSecrets(redactSensitive(capField(v, max)) as string);
}

export function recordAudit(entry: Omit<AuditEntry, "id" | "at"> & { at?: number }): void {
  try {
    const full: AuditEntry = {
      id: newId(),
      at: entry.at ?? Date.now(),
      ...entry,
      category: String(entry.category || "").slice(0, 64),
      action: String(entry.action || "").slice(0, 64),
      target: safeField(entry.target, 256),
      actor: safeField(entry.actor, 128),
      detail: safeField(entry.detail, MAX_ENTRY_BYTES),
    };
    const line = JSON.stringify(full) + "\n";
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    sealLogFile(p);
    fs.appendFileSync(p, line, { encoding: "utf-8" });
    try { fs.chmodSync(p, 0o600); } catch { /* best effort on non-POSIX */ }
    // Ring-buffer: trim if the file grew past CAP lines (cheap-ish, amortized).
    trimIfNeeded(p);
  } catch {
    /* never let auditing crash the operation it records */
  }
}

let _trimCounter = 0;
function trimIfNeeded(p: string): void {
  // Only check every ~50 appends to avoid stat'ing on every write.
  if ((_trimCounter++ % 50) !== 0) return;
  try {
    const stat = fs.statSync(p);
    if (stat.size < 512 * 1024) return; // < 512KB, leave it
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const keep = lines.slice(lines.length - CAP);
    // Unique tmp + O_EXCL (R7 #37): the old fixed ".tmp" name raced between
    // concurrent writers. fsync file + dir before rename for durability.
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, keep.join("\n") + "\n", "utf-8");
      try { fs.fsyncSync(fd); } catch { /* best effort */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
    try {
      const dirFd = fs.openSync(path.dirname(p), "r");
      try { fs.fsyncSync(dirFd); } catch { /* best effort */ }
      fs.closeSync(dirFd);
    } catch { /* best effort on non-POSIX */ }
  } catch { /* ignore */ }
}

/** Read recent audit entries (newest first). */
export function listAudit(limit = 200, opts?: { category?: string; target?: string }): AuditEntry[] {
  try {
    const p = logPath();
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
    let entries: AuditEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    if (opts?.category) entries = entries.filter((e) => e.category === opts.category);
    if (opts?.target) entries = entries.filter((e) => e.target === opts.target);
    entries.sort((a, b) => b.at - a.at);
    return entries.slice(0, Math.max(0, Math.min(limit, 2000)));
  } catch {
    return [];
  }
}

/** Clear the audit log (admin action). */
export function clearAudit(): void {
  try {
    const p = logPath();
    if (fs.existsSync(p)) fs.writeFileSync(p, "", { encoding: "utf-8", mode: 0o600 });
  } catch { /* ignore */ }
}
