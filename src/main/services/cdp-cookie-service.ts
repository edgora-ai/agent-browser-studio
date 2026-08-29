// ── CDP Cookie Service ──
// Exports/imports and edits cookies via Chrome DevTools Protocol.
// Plaintext values — bypasses macOS Keychain encryption. Cross-device safe.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir, getProfilesDir } from "./config-manager.js";
import { findCdpPortSync } from "./process-discovery.js";
import { validateDirId } from "./utils.js";
import type { CookieInfo } from "../types.js";

let _wsPromiseCDP: Promise<any> | null = null;
async function getWs(): Promise<any> {
  if (!_wsPromiseCDP) {
    _wsPromiseCDP = import("ws").then((m: any) => m.default || m).catch((e: any) => { console.error("[cdp] ws module unavailable:", e.message); return null; });
  }
  return _wsPromiseCDP;
}

export const cdpCookieService = {
  /** Quick check: is Chrome already running for this profile? (must have CDP enabled) */
  hasRunningChrome(dirId: string): boolean {
    return findCdpPort(dirId) !== null;
  },

  /** Queue cookies for a stopped profile; launch will apply them once CDP is ready. */
  queueImport(dirId: string, cookies: CookieInfo[]): void {
    writeQueuedCookieImports(dirId, cookies);
  },

  /** Apply and clear queued cookies for a running profile. */
  async applyQueuedImports(dirId: string): Promise<number> {
    const pending = readQueuedCookieImports(dirId);
    if (!pending.length) return 0;
    const imported = await this.importCookies(dirId, pending);
    if (imported === pending.length) {
      clearQueuedCookieImports(dirId);
    }
    return imported;
  },

  /** Export cookies via CDP. Only works when Chrome IS running. Returns [] otherwise. */
  async exportCookies(dirId: string, signal?: AbortSignal): Promise<CookieInfo[]> {
    assertCdpNotAborted(signal);
    const port = findCdpPort(dirId);
    if (!port) return [];
    return cdpGetAllCookies(port, signal);
  },

  /** Import cookies via CDP. Only works when Chrome IS running. Returns 0 otherwise. */
  async importCookies(dirId: string, cookies: CookieInfo[], signal?: AbortSignal): Promise<number> {
    assertCdpNotAborted(signal);
    const port = findCdpPort(dirId);
    if (!port) { console.log(`[cdp] Chrome not running for ${dirId.slice(0, 8)}, skip import`); return 0; }
    return cdpSetCookies(port, cookies, signal);
  },

  /** Set a single cookie via CDP. Only works when Chrome IS running. */
  async setCookie(dirId: string, cookie: CookieInfo): Promise<boolean> {
    const port = findCdpPort(dirId);
    if (!port) return false;
    return cdpSetCookie(port, cookie);
  },

  /** Delete matching cookies via CDP. Only works when Chrome IS running. */
  async deleteCookie(dirId: string, domain: string, name: string): Promise<boolean> {
    const port = findCdpPort(dirId);
    if (!port) return false;
    return cdpDeleteCookie(port, domain, name);
  },
};

function normalizeCdpWebSocketUrl(value: string, port: number): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") || Number(url.port) !== port) {
    throw new Error("CDP websocket target is not on the expected loopback port");
  }
  url.hostname = "127.0.0.1";
  return url.toString();
}

function assertCdpNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("CDP cookie operation cancelled");
}

async function getPageWebSocketUrl(port: number, signal?: AbortSignal): Promise<string | null> {
  assertCdpNotAborted(signal);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal })).json() as any[];
  assertCdpNotAborted(signal);
  const page = pages.find((p: any) => p.type === "page" && p.webSocketDebuggerUrl);
  return page ? normalizeCdpWebSocketUrl(page.webSocketDebuggerUrl, port) : null;
}

async function withCdpClient<T>(port: number, timeoutMs: number, run: (send: (method: string, params?: Record<string, any>) => Promise<any>) => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  const pageWsUrl = await getPageWebSocketUrl(port, signal);
  if (!pageWsUrl) return null;
  assertCdpNotAborted(signal);

  const wsModule = await getWs();
  assertCdpNotAborted(signal);
  if (!wsModule) return null;
  const Ws = (wsModule as any).default || wsModule;

  return new Promise((resolve) => {
    const ws = new Ws(pageWsUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const timer = setTimeout(() => settle(null), timeoutMs);
    const onAbort = () => settle(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    function settle(value: T | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const waiter of pending.values()) waiter.reject(new Error("CDP connection closed"));
      pending.clear();
      try { ws.close(); } catch {}
      resolve(value);
    }

    function send(method: string, params?: Record<string, any>): Promise<any> {
      assertCdpNotAborted(signal);
      const id = nextId++;
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
      });
    }

    ws.on("open", async () => {
      try {
        await send("Network.enable");
        assertCdpNotAborted(signal);
        settle(await run(send));
      } catch (e: any) {
        console.error("[cdp] cookie operation:", e.message || String(e));
        settle(null);
      }
    });

    ws.on("message", (data: any) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message || "CDP request failed"));
      } else {
        waiter.resolve(msg.result || {});
      }
    });

    ws.on("error", () => settle(null));
    ws.on("close", () => settle(null));
  });
}

function cdpCookieToCookieInfo(c: any): CookieInfo {
  let sameSite = -1;
  if (c.sameSite === "Strict") sameSite = 2;
  else if (c.sameSite === "Lax") sameSite = 1;
  else if (c.sameSite === "None") sameSite = 0;
  return {
    domain: c.domain || "",
    name: c.name || "",
    value: c.value || "",
    path: c.path || "/",
    expires: Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : null,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite,
  };
}

function cookieInfoToCdpParams(c: CookieInfo): Record<string, any> {
  const protocol = c.secure ? "https" : "http";
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  const pathPart = c.path || "/";
  const sameSite = c.sameSite === 2 ? "Strict" : c.sameSite === 1 ? "Lax" : c.sameSite === 0 ? "None" : undefined;
  return {
    url: `${protocol}://${host}${pathPart}`,
    name: c.name,
    value: c.value,
    ...(c.domain.startsWith(".") ? { domain: c.domain } : {}),
    path: pathPart,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(c.expires && c.expires > 0 ? { expires: Math.floor(c.expires) } : {}),
  };
}

async function cdpGetAllCookies(port: number, signal?: AbortSignal): Promise<CookieInfo[]> {
  try {
    const cookies = await withCdpClient(port, 5000, async (send) => {
      const result = await send("Network.getAllCookies");
      return ((result.cookies || []) as any[]).map(cdpCookieToCookieInfo);
    }, signal);
    assertCdpNotAborted(signal);
    return cookies || [];
  } catch (e: any) {
    if (signal?.aborted) throw e;
    console.error("[cdp] getAllCookies:", e.message);
    return [];
  }
}

async function cdpSetCookie(port: number, cookie: CookieInfo): Promise<boolean> {
  try {
    const ok = await withCdpClient(port, 5000, async (send) => {
      const result = await send("Network.setCookie", cookieInfoToCdpParams(cookie));
      return result.success === true;
    });
    return Boolean(ok);
  } catch (e: any) { console.error("[cdp] setCookie:", e.message); return false; }
}

async function cdpSetCookies(port: number, cookies: CookieInfo[], signal?: AbortSignal): Promise<number> {
  try {
    const imported = await withCdpClient(port, 30000, async (send) => {
      let count = 0;
      for (const cookie of cookies) {
        assertCdpNotAborted(signal);
        try {
          const result = await send("Network.setCookie", cookieInfoToCdpParams(cookie));
          if (result.success === true) count++;
        } catch (e: any) {
          console.error("[cdp] setCookie skipped:", e.message || String(e));
        }
      }
      return count;
    }, signal);
    assertCdpNotAborted(signal);
    return imported || 0;
  } catch (e: any) {
    if (signal?.aborted) throw e;
    console.error("[cdp] setCookies:", e.message);
    return 0;
  }
}

async function cdpDeleteCookie(port: number, domain: string, name: string): Promise<boolean> {
  try {
    const ok = await withCdpClient(port, 10000, async (send) => {
      const result = await send("Network.getAllCookies");
      const matches = ((result.cookies || []) as any[]).filter((c) => c.domain === domain && c.name === name);
      for (const cookie of matches) {
        await send("Network.deleteCookies", {
          name,
          domain: cookie.domain,
          path: cookie.path || "/",
        });
      }
      return true;
    });
    return Boolean(ok);
  } catch (e: any) { console.error("[cdp] deleteCookie:", e.message); return false; }
}

// ── Shared pending-cookie queue ──
// Engine-agnostic: the Chromium CDP path and the Firefox BiDi path both read
// and write the same per-profile queue file, so "queue on stopped profile →
// apply at next launch" works regardless of which engine eventually launches.

function pendingCookiePath(dirId: string): string {
  validateDirId(dirId);
  return path.join(getAppDataDir(), "pending-cookie-imports", `${dirId}.json`);
}

/** Read the queued cookie imports for a profile. */
export function readQueuedCookieImports(dirId: string): CookieInfo[] {
  const filePath = pendingCookiePath(dirId);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(parsed) ? parsed.map(normalizeCookieForQueue).filter(Boolean) as CookieInfo[] : [];
  } catch (e: any) {
    console.error(`[cdp] failed to read queued cookies for ${dirId}:`, e.message || String(e));
    return [];
  }
}

/** Write cookie imports to the per-profile queue for the next launch. */
export function writeQueuedCookieImports(dirId: string, cookies: CookieInfo[]): void {
  const filePath = pendingCookiePath(dirId);
  const dir = path.dirname(filePath);
  const normalized = cookies.map(normalizeCookieForQueue).filter(Boolean) as CookieInfo[];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(normalized), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(`${filePath}.tmp`, filePath);
}

/** Clear the queued cookie imports for a profile. */
export function clearQueuedCookieImports(dirId: string): void {
  try { fs.rmSync(pendingCookiePath(dirId), { force: true }); } catch {}
}

function normalizeCookieForQueue(cookie: any): CookieInfo | null {
  if (!cookie || typeof cookie !== "object") return null;
  if (typeof cookie.domain !== "string" || typeof cookie.name !== "string" || typeof cookie.value !== "string") return null;
  if (cookie.domain.length === 0 || cookie.domain.length > 255 || cookie.name.length === 0 || cookie.name.length > 255 || cookie.value.length > 4096) return null;
  if (!/^\.?[A-Za-z0-9*_-]+(?:\.[A-Za-z0-9*_-]+)*$/.test(cookie.domain) || /[\x00-\x1f\x7f;=\s]/.test(cookie.name) || /\x00/.test(cookie.value)) return null;
  const pathValue = typeof cookie.path === "string" && cookie.path.startsWith("/") && cookie.path.length <= 1024 ? cookie.path : "/";
  const expires = Number.isFinite(cookie.expires) && cookie.expires > 0 ? Math.floor(cookie.expires) : null;
  const sameSite = cookie.sameSite === 0 || cookie.sameSite === 1 || cookie.sameSite === 2 ? cookie.sameSite : -1;
  return {
    domain: cookie.domain,
    name: cookie.name,
    value: cookie.value,
    path: pathValue,
    expires,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite,
  };
}

function findCdpPort(dirId: string): number | null {
  validateDirId(dirId);
  const profileDir = path.join(getProfilesDir(), dirId);
  try {
    return findCdpPortSync(dirId, profileDir);
  } catch { return null; }
}
