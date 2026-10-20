// ── Firefox runtime cookie service (Slice 79) ──
// Firefox's BiDi equivalent of `cdpCookieService` (Chromium CDP Network
// domain): export / import / delete cookies on a *running* Firefox profile
// through the WebDriver BiDi `storage.*` commands. Stopped profiles keep using
// the shared pending-import queue, so queue → launch → apply works on Firefox
// exactly like it does on Chromium.
//
// NOTE: this module must not statically import browser-manager (the launcher
// imports this service for the Firefox cookie apply at launch — that would be
// a cycle). The status lookup is therefore a deferred dynamic import.

import type { CookieInfo } from "../types.js";
import { connectBidi, getRegisteredFirefoxSession, bidiSetCookie, bidiDeleteCookies, type BidiConnection, type BidiCookie } from "./bidi-client.js";
import { getProfileEngineByDirId } from "./page-eval.js";
import { runningProcesses } from "./browser/runtime-table.js";
import { cdpCookieService, readQueuedCookieImports, clearQueuedCookieImports, type CookieExportSnapshot } from "./cdp-cookie-service.js";
import { validateDirId } from "./utils.js";
export type { CookieExportSnapshot } from "./cdp-cookie-service.js";

const COOKIE_EXPORT_TIMEOUT_MS = 15000;
const cancelledCookieExport = (): CookieExportSnapshot => ({ state: "cancelled", reason: "cookie_export_cancelled" });

/** Map a BiDi `storage.getCookies` entry to the product's CookieInfo. */
export function bidiCookieToCookieInfo(c: BidiCookie): CookieInfo {
  let sameSite = -1;
  if (c.sameSite === "strict") sameSite = 2;
  else if (c.sameSite === "lax") sameSite = 1;
  else if (c.sameSite === "none") sameSite = 0;
  return {
    domain: c.domain || "",
    name: c.name || "",
    value: String(c.value?.value ?? ""),
    path: c.path || "/",
    expires: Number.isFinite(c.expiry as number) && (c.expiry as number) > 0 ? Math.floor(c.expiry as number) : null,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite,
  };
}

/** Map a product CookieInfo to a BiDi `storage.setCookie` payload. */
export function cookieInfoToBidiCookie(c: CookieInfo): BidiCookie {
  const sameSite = c.sameSite === 2 ? "strict" : c.sameSite === 1 ? "lax" : c.sameSite === 0 ? "none" : "none";
  return {
    name: c.name,
    value: { type: "string", value: c.value },
    domain: c.domain.startsWith(".") ? c.domain.slice(1) : c.domain,
    path: c.path || "/",
    size: c.value.length,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite,
    ...(c.expires && c.expires > 0 ? { expiry: Math.floor(c.expires) } : {}),
  };
}

async function getRunningPort(dirId: string): Promise<number | null> {
  try {
    const { statusBrowser } = await import("./browser-manager.js");
    const st = statusBrowser(dirId);
    if (!st.running) return null;
    return Number.isInteger(st.cdpPort) && (st.cdpPort as number) > 0 ? (st.cdpPort as number) : null;
  } catch {
    return null;
  }
}

async function withBidiClient<T>(
  dirId: string,
  run: (conn: BidiConnection) => Promise<T>,
  timeoutMs = 15000,
): Promise<T | null> {
  const port = await getRunningPort(dirId);
  if (port === null) return null;
  const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs });
  try {
    return await run(conn);
  } finally {
    conn.close();
  }
}

/** True when the profile runs Firefox with a BiDi endpoint we can drive.
 * Sync by design (R7 #76): the async getRunningPort returns a Promise which
 * is never === null — comparing it directly made this always truthy. Read
 * the runtime table synchronously instead (runtime-table has no
 * browser-manager dependency, so no import cycle). */
export function hasRunningFirefox(dirId: string): boolean {
  try {
    if (getProfileEngineByDirId(dirId) !== "firefox") return false;
    const entry = runningProcesses.get(dirId);
    if (!entry) return false;
    try { process.kill(entry.pid, 0); } catch { return false; }
    return typeof entry.port === "number" && entry.port > 0;
  } catch {
    return false;
  }
}

function parseBidiCookies(result: unknown): CookieInfo[] | null {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !Object.hasOwn(result, "cookies") || !Array.isArray((result as any).cookies)) return null;
  const cookies = (result as { cookies: unknown[] }).cookies;
  for (const value of cookies) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cookie = value as Record<string, any>;
    if (typeof cookie.domain !== "string" || !cookie.domain || typeof cookie.name !== "string" ||
        typeof cookie.path !== "string" || !cookie.path.startsWith("/") ||
        typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean" ||
        typeof cookie.size !== "number" || !Number.isSafeInteger(cookie.size) || cookie.size < 0 ||
        !["strict", "lax", "none"].includes(cookie.sameSite) ||
        (cookie.expiry !== undefined && (typeof cookie.expiry !== "number" || !Number.isFinite(cookie.expiry) || cookie.expiry < 0)) ||
        !cookie.value || typeof cookie.value !== "object" || Array.isArray(cookie.value) ||
        cookie.value.type !== "string" || typeof cookie.value.value !== "string") return null;
  }
  return (cookies as BidiCookie[]).map(bidiCookieToCookieInfo);
}

/** Read raw storage.getCookies results: bidiGetCookies's legacy [] fallback
 * intentionally cannot provide the availability authority needed by backup. */
function bidiGetCookiesSnapshot(dirId: string, signal?: AbortSignal): Promise<CookieExportSnapshot> {
  if (signal?.aborted) return Promise.resolve(cancelledCookieExport());
  return new Promise((resolve) => {
    let settled = false, owned = false, connection: BidiConnection | null = null;
    let failureReason = "bidi_cookie_endpoint_unavailable";
    const deadline = Date.now() + COOKIE_EXPORT_TIMEOUT_MS;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => finish({ state: "unavailable", reason: "bidi_cookie_export_timeout" }), COOKIE_EXPORT_TIMEOUT_MS);
    const onAbort = () => finish(cancelledCookieExport());
    function closeOwned(conn: BidiConnection): void {
      try { conn.close(); }
      catch { console.warn("[bidi] cookie export connection cleanup failed"); }
    }
    function finish(snapshot: CookieExportSnapshot): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (owned && connection) closeOwned(connection);
      resolve(snapshot);
    }
    function fail(reason: string): void {
      finish(signal?.aborted ? cancelledCookieExport() : { state: "unavailable", reason });
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    async function start(): Promise<void> {
      try {
        validateDirId(dirId);
        const port = await getRunningPort(dirId);
        if (settled) return;
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) { fail(failureReason); return; }
        failureReason = "bidi_cookie_connection_unavailable";
        const borrowed = getRegisteredFirefoxSession(port);
        const acquired = borrowed || await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: remaining() });
        // connectBidi has no signal parameter. An owned connection completing
        // after cancellation/deadline is closed, never used for a cookie read.
        if (settled) { if (!borrowed) closeOwned(acquired); return; }
        connection = acquired; owned = !borrowed;
        if (signal?.aborted) { onAbort(); return; }
        failureReason = "bidi_cookie_command_failed";
        const result: unknown = await connection.send("storage.getCookies", {}, remaining());
        if (settled) return;
        const cookies = parseBidiCookies(result);
        if (cookies === null) fail("bidi_cookie_invalid_response");
        else finish({ state: "available", cookies });
      } catch { fail(failureReason); }
    }
    void start();
  });
}

export const firefoxCookieService = {
  /** Availability-preserving export. Abort resolves to cancelled, matching
   * CDP. Registered sessions are borrowed, not closed or modified on cancellation. */
  async exportCookiesSnapshot(dirId: string, signal?: AbortSignal): Promise<CookieExportSnapshot> {
    return bidiGetCookiesSnapshot(dirId, signal);
  },

  /** Legacy array view retained for existing consumers; cancellation rejects.
   * Backup/sync must use exportCookiesSnapshot to distinguish failure from []. */
  async exportCookies(dirId: string, signal?: AbortSignal): Promise<CookieInfo[]> {
    const snapshot = await firefoxCookieService.exportCookiesSnapshot(dirId, signal);
    if (snapshot.state === "cancelled") throw new Error("Cookie export cancelled");
    // Keep the legacy filter; snapshots themselves retain valid nameless cookies.
    return snapshot.state === "available" ? snapshot.cookies.filter((cookie) => cookie.domain && cookie.name) : [];
  },

  /** Import cookies into a running Firefox profile. Returns 0 when idle. */
  async importCookies(dirId: string, cookies: CookieInfo[], signal?: AbortSignal): Promise<number> {
    try {
      const imported = await withBidiClient(dirId, async (conn) => {
        let count = 0;
        for (const cookie of cookies) {
          if (signal?.aborted) throw new Error("Cookie import cancelled");
          try {
            const ok = await bidiSetCookie(conn, cookieInfoToBidiCookie(cookie), 10000);
            if (ok) count++;
          } catch (e: any) {
            console.error("[bidi] setCookie skipped:", e?.message || String(e));
          }
        }
        return count;
      }, 30000);
      return imported ?? 0;
    } catch (e: any) {
      if (signal?.aborted) throw e;
      console.error("[bidi] importCookies:", e?.message || String(e));
      return 0;
    }
  },

/** Set one cookie on a running Firefox profile. */
  async setCookie(dirId: string, cookie: CookieInfo): Promise<boolean> {
    try {
      const ok = await withBidiClient(dirId, async (conn) => bidiSetCookie(conn, cookieInfoToBidiCookie(cookie), 10000));
      return ok === true;
    } catch (e: any) {
      console.error("[bidi] setCookie:", e?.message || String(e));
      return false;
    }
  },

  /** Delete matching cookies on a running Firefox profile. */
  async deleteCookie(dirId: string, domain: string, name: string): Promise<boolean> {
    try {
      const deleted = await withBidiClient(dirId, async (conn) => bidiDeleteCookies(conn, { domain, name }, 10000));
      return deleted === 1;
    } catch (e: any) {
      console.error("[bidi] deleteCookie:", e?.message || String(e));
      return false;
    }
  },

  /** Apply and clear the shared pending queue against a running profile. */
  async applyQueuedImports(dirId: string): Promise<number> {
    const pending = readQueuedCookieImports(dirId);
    if (!pending.length) return 0;
    const imported = await this.importCookies(dirId, pending);
    if (imported === pending.length) {
      clearQueuedCookieImports(dirId);
    }
    return imported;
  },
};

/**
 * The engine-aware facade used by profile-manager / sync-service / launcher:
 * call sites no longer need to know which engine a profile uses.
 */
function pickService(dirId: string) {
  return getProfileEngineByDirId(dirId) === "firefox" ? firefoxCookieService : cdpCookieService;
}

interface CookieOps {
  hasRunningBrowser(dirId: string): boolean;
  exportCookies(dirId: string, signal?: AbortSignal): Promise<CookieInfo[]>;
  exportCookiesSnapshot(dirId: string, signal?: AbortSignal): Promise<CookieExportSnapshot>;
  importCookies(dirId: string, cookies: CookieInfo[], signal?: AbortSignal): Promise<number>;
  setCookie(dirId: string, cookie: CookieInfo): Promise<boolean>;
  deleteCookie(dirId: string, domain: string, name: string): Promise<boolean>;
}

export const runtimeCookieOps: CookieOps = {
  hasRunningBrowser(dirId) {
    return getProfileEngineByDirId(dirId) === "firefox"
      ? hasRunningFirefox(dirId)
      : cdpCookieService.hasRunningChrome(dirId);
  },
  exportCookies(dirId, signal) {
    return pickService(dirId).exportCookies(dirId, signal);
  },
  exportCookiesSnapshot(dirId, signal) {
    return pickService(dirId).exportCookiesSnapshot(dirId, signal);
  },
  importCookies(dirId, cookies, signal) {
    return pickService(dirId).importCookies(dirId, cookies, signal);
  },
  setCookie(dirId, cookie) {
    return pickService(dirId).setCookie(dirId, cookie);
  },
  deleteCookie(dirId, domain, name) {
    return pickService(dirId).deleteCookie(dirId, domain, name);
  },
};