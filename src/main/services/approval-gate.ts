// Approval gate — pauses risky agent operations until the user authorizes them.
// The agent's db_exec (and future risky tools) check this gate before executing.
// Returns { allowed: true } if auto-allowed (permanent rule) or after the user
// clicks 允许; throws (or returns denied) if the user rejects.
import { BrowserWindow, type WebContents } from "electron";

export interface ApprovalRequest {
  id: string;
  runId?: string;
  category: "db-write" | "db-destroy" | "fs-write" | "http-write";
  tool: string;
  description: string;     // human-readable summary of the action
  detail?: string;         // e.g. the SQL / file path
  createdAt: number;
}

export type ApprovalDecision = "once" | "always" | "deny";

interface Pending {
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  wc?: WebContents;
}

type ApprovalResolver = (value: { allowed: boolean; decision: ApprovalDecision }) => void;

const pending = new Map<string, Pending>();

// Permanently-allowed patterns (from "always" decisions).
// Keyed by category + a normalized signature of the action.
const alwaysAllowed = new Set<string>();

// Permanently-denied signatures.
const alwaysDenied = new Set<string>();

function newId(): string {
  return "appr_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Strip leading SQL comments/CTE prefix for risk classification (R6 #71).
 * SQLite skips `--...`, `/* ... *\/` and `WITH ...` prefixes before the
 * real statement, but the old classifier anchored DELETE at string start —
 * so `/* x *\/ DELETE FROM users` classified as db-write and executed with
 * no destroy-approval. Fail closed: anything unrecognized as safe is destroy.
 */
function stripLeadingSqlNoise(sql: string): string {
  let s = String(sql || "");
  for (let guard = 0; guard < 10; guard++) {
    const t = s.trimStart();
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      s = nl === -1 ? "" : t.slice(nl + 1);
      continue;
    }
    if (t.startsWith("/*")) {
      const end = t.indexOf("*/");
      s = end === -1 ? "" : t.slice(end + 2);
      continue;
    }
    // WITH cte AS (...) — the CTE body itself contains SELECT, so skip
    // forward to the statement keyword that FOLLOWS the CTE definitions:
    // scan top-level (depth 0, outside strings) words and take the first
    // DELETE/INSERT/UPDATE/DROP/TRUNCATE/CREATE/ALTER/SELECT/VALUES.
    const m = /^\s*WITH\b/i.exec(t);
    if (m) {
      let i = m[0].length;
      let depth = 0;
      let inStr: string | null = null;
      let word = "";
      let rest = "";
      const flush = () => {
        const u = word.toUpperCase();
        if (/^(DELETE|INSERT|UPDATE|DROP|TRUNCATE|CREATE|ALTER|SELECT|VALUES)$/.test(u)) {
          rest = t.slice(i - word.length);
          return true;
        }
        word = "";
        return false;
      };
      for (; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
          if (c === inStr && t[i - 1] !== "\\") inStr = null;
          continue;
        }
        if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
        if (c === "(") { depth++; word = ""; continue; }
        if (c === ")") { depth = Math.max(0, depth - 1); word = ""; continue; }
        if (/[A-Za-z_]/.test(c)) { word += c; continue; }
        if (depth === 0 && word && flush()) break;
        if (!/[A-Za-z_]/.test(c)) word = "";
      }
      if (!rest && depth === 0 && word && /^(DELETE|INSERT|UPDATE|DROP|TRUNCATE|CREATE|ALTER|SELECT|VALUES)$/i.test(word)) {
        rest = t.slice(t.length - word.length);
      }
      s = rest || "";
      continue;
    }
    return t;
  }
  return s.trimStart();
}

/** Classify a db_exec SQL statement by risk. */
export function classifyDbSql(sql: string): { category: ApprovalRequest["category"]; signature: string } {
  const trimmed = sql.trim().replace(/\s+/g, " ");
  const upper = trimmed.toUpperCase();
  const head = stripLeadingSqlNoise(sql);
  const headUpper = head.toUpperCase();
  // Destructive: DROP, DELETE, TRUNCATE — matched on the de-noised head, so
  // comment/CTE-prefixed statements cannot dodge the destroy gate.
  if (/\b(DROP|TRUNCATE)\b/.test(headUpper) || /^\s*DELETE\b/.test(headUpper)) {
    // Signature: verb + table name if extractable (from the de-noised head).
    const m = head.match(/^\s*(?:DROP\s+TABLE|DELETE\s+FROM|TRUNCATE\s+TABLE)\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)/i);
    return { category: "db-destroy", signature: m ? headUpper.split(/\s+/).slice(0, 2).join(" ") + " " + m[1].toLowerCase() : headUpper.slice(0, 40) };
  }
  // Other writes: INSERT/UPDATE/CREATE/ALTER
  return { category: "db-write", signature: upper.slice(0, 40) };
}

/** Ask the user to authorize a risky action. Resolves with the decision.
 *  - "once": run this one time
 *  - "always": remember and never ask again for this signature
 *  - "deny": refused (caller should treat as error) */
export async function requestApproval(
  req: Omit<ApprovalRequest, "id" | "createdAt">,
  webContents?: WebContents,
  signal?: AbortSignal,
): Promise<{ allowed: boolean; decision: ApprovalDecision }> {
  if (signal?.aborted) return { allowed: false, decision: "deny" };
  const sig = signatureFor(req.category, req.detail || req.tool);
  // Auto-decisions from prior "always" choices.
  if (alwaysAllowed.has(sig)) return { allowed: true, decision: "always" };
  if (alwaysDenied.has(sig)) return { allowed: false, decision: "deny" };

  const full: ApprovalRequest = { ...req, id: newId(), createdAt: Date.now() };
  return new Promise((resolve: ApprovalResolver) => {
    const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
    const decisionToResult = (d: ApprovalDecision) => { cleanupAbort(); resolve({ allowed: d !== "deny", decision: d }); };
    const onAbort = () => {
      pending.delete(full.id);
      decisionToResult("deny");
    };
    pending.set(full.id, { req: full, resolve: decisionToResult, wc: webContents });
    signal?.addEventListener("abort", onAbort, { once: true });
    broadcast("agent:approval-request", full, webContents);
  });
}

/** Called by the UI when the user decides. */
export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  if (decision === "always") {
    // HTTP writes can differ materially in redacted URL/body/header values, so
    // treat "always" as once for this category instead of memoizing a broad rule.
    if (p.req.category !== "http-write") {
      const sig = signatureFor(p.req.category, p.req.detail || p.req.tool);
      alwaysAllowed.add(sig);
    }
  } else if (decision === "deny") {
    // Don't permanently deny on a single reject (user may change mind); only
    // record if they explicitly chose a "never" path. For now treat deny as once.
  }
  p.resolve(decision);
  return true;
}

/** All currently-pending requests (for UI to recover state). */
export function listPendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.req);
}

export function clearApprovalMemory(): void {
  alwaysAllowed.clear();
  alwaysDenied.clear();
  for (const p of pending.values()) p.resolve("deny");
  pending.clear();
}

function signatureFor(category: string, detail: string): string {
  const compact = String(detail || "").replace(/\s+/g, " ").trim();
  if (category === "http-write") return `${category}|${compact}`;
  return category + "|" + compact.toLowerCase().slice(0, 80);
}

function broadcast(channel: string, payload: unknown, wc?: WebContents): void {
  try {
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
    for (const win of BrowserWindow.getAllWindows()) {
      const contents = win.webContents;
      if (contents && !contents.isDestroyed() && (!wc || contents.id !== wc.id)) {
        contents.send(channel, payload);
      }
    }
  } catch { /* no windows in tests */ }
}
