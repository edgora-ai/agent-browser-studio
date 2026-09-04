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
import { connectBidi, bidiGetCookies, bidiSetCookie, bidiDeleteCookies, type BidiConnection, type BidiCookie } from "./bidi-client.js";
import { getProfileEngineByDirId } from "./page-eval.js";
import { runningProcesses } from "./browser/runtime-table.js";
import { cdpCookieService, readQueuedCookieImports, clearQueuedCookieImports } from "./cdp-cookie-service.js";

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

export const firefoxCookieService = {
  /** Export all cookies from a running Firefox profile. Returns [] when idle. */
  async exportCookies(dirId: string, signal?: AbortSignal): Promise<CookieInfo[]> {
    try {
      const cookies = await withBidiClient(dirId, async (conn) => bidiGetCookies(conn, 10000));
      if (!cookies) return [];
      return cookies
        .map(bidiCookieToCookieInfo)
        .filter((c) => c.domain && c.name);
    } catch (e: any) {
      if (signal?.aborted) throw e;
      console.error("[bidi] exportCookies:", e?.message || String(e));
      return [];
    }
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