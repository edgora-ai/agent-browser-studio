// ── CDP Cookie Service ──
// Exports/imports and edits cookies via Chrome DevTools Protocol.
// Plaintext values — bypasses macOS Keychain encryption. Cross-device safe.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAppDataDir, getProfilesDir } from "./config-manager.js";
import { findCdpPortSync } from "./process-discovery.js";
import { validateDirId } from "./utils.js";
import type { CookieInfo } from "../types.js";

/** Only a validated native response (including []) is authoritative. Reasons
 * are static codes, never provider errors, endpoints, cookie names or values. */
export type CookieExportSnapshot =
  | { state: "available"; cookies: CookieInfo[] }
  | { state: "unavailable"; reason: string }
  | { state: "cancelled"; reason: string };

const COOKIE_EXPORT_TIMEOUT_MS = 5000;
const cancelledCookieExport = (): CookieExportSnapshot => ({ state: "cancelled", reason: "cookie_export_cancelled" });

interface CdpCookieImportTarget {
  port: number;
  isCurrent: () => boolean;
}

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
  async applyQueuedImports(dirId: string, target?: CdpCookieImportTarget): Promise<number> {
    const pending = readQueuedCookieImports(dirId, target ? { strict: true } : undefined);
    if (!pending.length || (target && !target.isCurrent())) return 0;
    const imported = target
      ? await this.importCookies(dirId, pending, undefined, target)
      : await this.importCookies(dirId, pending);
    // Clear only the same queued data on the same native instance. Partial
    // application retains the full queue for an explicit follow-up attempt.
    if (imported === pending.length && (!target || target.isCurrent()) &&
        JSON.stringify(readQueuedCookieImports(dirId, target ? { strict: true } : undefined)) === JSON.stringify(pending)) {
      clearQueuedCookieImports(dirId);
    }
    return imported;
  },

  /** Availability-preserving export. Cancellation resolves to cancelled (also
   * before discovery); callers must not publish unavailable/cancelled as []. */
  async exportCookiesSnapshot(dirId: string, signal?: AbortSignal): Promise<CookieExportSnapshot> {
    if (signal?.aborted) return cancelledCookieExport();
    try {
      const port = findCdpPort(dirId);
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { state: "unavailable", reason: "cdp_cookie_endpoint_unavailable" };
      }
      return await cdpGetCookiesSnapshot(port, signal);
    } catch {
      return signal?.aborted ? cancelledCookieExport() : { state: "unavailable", reason: "cdp_cookie_export_unavailable" };
    }
  },

  /** Legacy array interface: failures still produce []; cancellation rejects.
   * Use exportCookiesSnapshot for backup/sync decisions, not this lossy view. */
  async exportCookies(dirId: string, signal?: AbortSignal): Promise<CookieInfo[]> {
    assertCdpNotAborted(signal);
    validateDirId(dirId);
    const snapshot = await cdpCookieService.exportCookiesSnapshot(dirId, signal);
    if (snapshot.state === "cancelled") throw new Error("CDP cookie operation cancelled");
    return snapshot.state === "available" ? snapshot.cookies : [];
  },

  /** Import cookies via CDP. Only works when Chrome IS running. Returns 0 otherwise. */
  async importCookies(dirId: string, cookies: CookieInfo[], signal?: AbortSignal, target?: CdpCookieImportTarget): Promise<number> {
    assertCdpNotAborted(signal);
    validateDirId(dirId);
    if (target && !target.isCurrent()) return 0;
    // Fresh launch already owns its exact port; a cached process-table sample
    // must not make a just-started browser appear unavailable to its importer.
    const port = target ? target.port : findCdpPort(dirId);
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return 0;
    return cdpSetCookies(port as number, cookies, signal, target?.isCurrent);
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
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal, redirect: "error" });
  if (!response.ok) throw new Error("CDP page discovery unavailable");
  const pages: unknown = await response.json();
  assertCdpNotAborted(signal);
  if (!Array.isArray(pages)) throw new Error("Invalid CDP page discovery");
  const page = pages.find((p: any) => p && p.type === "page" && typeof p.webSocketDebuggerUrl === "string" && p.webSocketDebuggerUrl);
  return page ? normalizeCdpWebSocketUrl(page.webSocketDebuggerUrl, port) : null;
}

async function withCdpClient<T>(port: number, timeoutMs: number, run: (send: (method: string, params?: Record<string, any>) => Promise<any>) => Promise<T>, signal?: AbortSignal, isCurrent?: () => boolean): Promise<T | null> {
  return new Promise((resolve) => {
    let ws: any = null, nextId = 1, settled = false;
    let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeDiscovery: (() => void) | undefined;
    const controller = new AbortController();
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    // One existing budget covers discovery headers/body, module load, handshake
    // and commands. Only an empty, pre-command page discovery may be retried.
    const timer = setTimeout(() => settle(null), timeoutMs);
    const onAbort = () => settle(null);
    signal?.addEventListener("abort", onAbort, { once: true });

    function closeOwnedSocket(): void {
      if (!ws) return;
      try {
        if (typeof ws.terminate === "function") ws.terminate();
        else ws.close();
      } catch { console.warn("[cdp] cookie connection cleanup failed"); }
    }
    function settle(value: T | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (discoveryTimer) clearTimeout(discoveryTimer);
      const wake = wakeDiscovery; wakeDiscovery = undefined; wake?.();
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      for (const waiter of pending.values()) waiter.reject(new Error("CDP connection closed"));
      pending.clear();
      closeOwnedSocket();
      resolve(value);
    }
    function assertCurrent(): void {
      assertCdpNotAborted(signal);
      if (settled || (isCurrent && !isCurrent())) throw new Error("CDP cookie operation is no longer current");
    }
    function send(method: string, params?: Record<string, any>): Promise<any> {
      assertCurrent();
      const id = nextId++;
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        try { ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) })); }
        catch {
          pending.delete(id);
          requestReject(new Error("CDP cookie command unavailable"));
        }
      });
    }
    async function start(): Promise<void> {
      try {
        let pageWsUrl: string | null = null;
        while (!settled) {
          assertCurrent();
          pageWsUrl = await getPageWebSocketUrl(port, controller.signal);
          assertCurrent();
          if (pageWsUrl) break;
          await new Promise<void>((resume) => {
            wakeDiscovery = resume;
            discoveryTimer = setTimeout(() => {
              discoveryTimer = undefined; wakeDiscovery = undefined; resume();
            }, 50);
          });
        }
        assertCurrent();
        if (!pageWsUrl) { settle(null); return; }
        const wsModule = await getWs();
        assertCurrent();
        if (!wsModule) { settle(null); return; }
        const Ws = (wsModule as any).default || wsModule;
        ws = new Ws(pageWsUrl, { followRedirects: false, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
        ws.on("error", () => settle(null));
        ws.on("close", () => settle(null));
        ws.on("message", (data: any) => {
          let msg: unknown;
          try { msg = JSON.parse(data.toString()); }
          catch { settle(null); return; }
          if (!isRecord(msg) || typeof msg.id !== "number") return;
          const waiter = pending.get(msg.id);
          if (!waiter) return;
          pending.delete(msg.id);
          if (Object.hasOwn(msg, "error") || !Object.hasOwn(msg, "result") || !isRecord(msg.result)) {
            waiter.reject(new Error("CDP cookie command failed"));
          } else waiter.resolve(msg.result);
        });
        ws.on("open", async () => {
          try {
            await send("Network.enable");
            assertCurrent();
            settle(await run(send));
          } catch {
            console.error("[cdp] cookie operation failed");
            settle(null);
          }
        });
        if (settled) closeOwnedSocket();
        else if (signal?.aborted) onAbort();
      } catch { settle(null); }
    }
    if (signal?.aborted) onAbort();
    else void start();
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

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseCdpCookies(result: unknown): CookieInfo[] | null {
  if (!isRecord(result) || !Object.hasOwn(result, "cookies") || !Array.isArray(result.cookies)) return null;
  for (const cookie of result.cookies) {
    if (!isRecord(cookie) || typeof cookie.domain !== "string" || !cookie.domain ||
        typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
        typeof cookie.path !== "string" || !cookie.path.startsWith("/") ||
        typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean" ||
        typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) ||
        (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(cookie.sameSite)) ||
        (cookie.session !== undefined && typeof cookie.session !== "boolean") ||
        (cookie.size !== undefined && (typeof cookie.size !== "number" || !Number.isSafeInteger(cookie.size) || cookie.size < 0))) return null;
  }
  return result.cookies.map(cdpCookieToCookieInfo);
}

/** Unlike withCdpClient's legacy mutation result, this reads raw response
 * envelopes without collapsing missing results, errors or missing cookies to
 * successful empty arrays. One deadline also bounds HTTP discovery/module load. */
function cdpGetCookiesSnapshot(port: number, signal?: AbortSignal): Promise<CookieExportSnapshot> {
  if (signal?.aborted) return Promise.resolve(cancelledCookieExport());
  return new Promise((resolve) => {
    let settled = false, ws: any = null, nextId = 1;
    let pending: { id: number; method: string } | null = null;
    let failureReason = "cdp_cookie_discovery_unavailable";
    const controller = new AbortController();
    const timer = setTimeout(() => finish({ state: "unavailable", reason: "cdp_cookie_export_timeout" }), COOKIE_EXPORT_TIMEOUT_MS);
    const onAbort = () => finish(cancelledCookieExport());
    function closeOwnedSocket(): void {
      if (!ws) return;
      try { ws.close(); }
      catch { console.warn("[cdp] cookie export connection cleanup failed"); }
    }
    function finish(snapshot: CookieExportSnapshot): void {
      if (settled) return;
      settled = true;
      pending = null;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      closeOwnedSocket();
      resolve(snapshot);
    }
    function fail(reason: string): void {
      finish(signal?.aborted ? cancelledCookieExport() : { state: "unavailable", reason });
    }
    function send(method: string): void {
      if (settled) return;
      if (signal?.aborted) { onAbort(); return; }
      pending = { id: nextId++, method };
      ws.send(JSON.stringify({ id: pending.id, method }));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    async function start(): Promise<void> {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: controller.signal });
        if (settled) return;
        if (!response.ok) { fail("cdp_cookie_discovery_unavailable"); return; }
        const pages: unknown = await response.json();
        if (settled) return;
        if (!Array.isArray(pages)) { fail("cdp_cookie_discovery_invalid_response"); return; }
        const page = pages.find((entry) => isRecord(entry) && entry.type === "page" && typeof entry.webSocketDebuggerUrl === "string" && entry.webSocketDebuggerUrl);
        if (!page) { fail("cdp_cookie_page_unavailable"); return; }
        failureReason = "cdp_cookie_endpoint_unavailable";
        const url = normalizeCdpWebSocketUrl(page.webSocketDebuggerUrl, port);
        failureReason = "cdp_cookie_transport_unavailable";
        const wsModule = await getWs();
        if (settled) return;
        if (!wsModule) { fail(failureReason); return; }
        failureReason = "cdp_cookie_connection_unavailable";
        const Ws = wsModule.default || wsModule;
        ws = new Ws(url);
        ws.on("error", () => fail("cdp_cookie_connection_unavailable"));
        ws.on("close", () => fail("cdp_cookie_connection_closed"));
        ws.on("message", (data: any) => {
          if (settled) return;
          let message: unknown;
          try { message = JSON.parse(data.toString()); }
          catch { fail("cdp_cookie_invalid_response"); return; }
          if (!isRecord(message)) { fail("cdp_cookie_invalid_response"); return; }
          if (!pending || message.id !== pending.id) return; // Events/unrelated command IDs are not replies.
          if (Object.hasOwn(message, "error")) { fail("cdp_cookie_command_failed"); return; }
          if (!Object.hasOwn(message, "result") || !isRecord(message.result)) { fail("cdp_cookie_invalid_response"); return; }
          try {
            if (pending.method === "Network.enable") { send("Network.getAllCookies"); return; }
            const cookies = parseCdpCookies(message.result);
            if (cookies === null) fail("cdp_cookie_invalid_response");
            else finish({ state: "available", cookies });
          } catch { fail("cdp_cookie_command_failed"); }
        });
        ws.on("open", () => {
          try { send("Network.enable"); }
          catch { fail("cdp_cookie_connection_unavailable"); }
        });
        // A caller can abort from inside a native constructor. The terminal
        // result already exists, but the newly returned owned socket still needs cleanup.
        if (settled) closeOwnedSocket();
        else if (signal?.aborted) onAbort();
      } catch { fail(failureReason); }
    }
    void start();
  });
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

async function cdpSetCookies(port: number, cookies: CookieInfo[], signal?: AbortSignal, isCurrent?: () => boolean): Promise<number> {
  try {
    const imported = await withCdpClient(port, 30000, async (send) => {
      let count = 0;
      for (const cookie of cookies) {
        assertCdpNotAborted(signal);
        try {
          const result = await send("Network.setCookie", cookieInfoToCdpParams(cookie));
          if (result.success === true) count++;
        } catch {
          console.error("[cdp] queued Cookie command was not confirmed");
        }
      }
      return count;
    }, signal, isCurrent);
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

function assertQueuePathSafe(filePath: string): void {
  for (const dir of [getAppDataDir(), path.dirname(filePath)]) {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Cookie queue requires a real directory, not a symlink");
  }
  const file = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("Unsafe Cookie queue file");
}

/** Read the queued cookie imports for a profile. */
export function readQueuedCookieImports(dirId: string, options?: { strict?: boolean }): CookieInfo[] {
  const filePath = pendingCookiePath(dirId);
  try {
    assertQueuePathSafe(filePath);
    if (!fs.existsSync(filePath)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("Invalid Cookie import queue");
    const normalized = parsed.map(normalizeCookieForQueue);
    if (options?.strict && normalized.some((cookie) => !cookie)) throw new Error("Invalid queued Cookie");
    return normalized.filter(Boolean) as CookieInfo[];
  } catch {
    console.error(`[cdp] failed to read queued cookies for ${dirId}: COOKIE_QUEUE_UNREADABLE`);
    if (options?.strict) throw new Error("COOKIE_QUEUE_UNREADABLE");
    return [];
  }
}

/** Write cookie imports to the per-profile queue for the next launch. */
export function writeQueuedCookieImports(dirId: string, cookies: CookieInfo[]): void {
  const filePath = pendingCookiePath(dirId);
  const dir = path.dirname(filePath);
  const normalized = cookies.map(normalizeCookieForQueue).filter(Boolean) as CookieInfo[];
  assertQueuePathSafe(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let created = false;
  let published = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    const text = JSON.stringify(normalized);
    try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.readFileSync(temporary, "utf8") !== text) throw new Error("Cookie queue staging readback mismatch");
    assertQueuePathSafe(filePath);
    fs.renameSync(temporary, filePath);
    published = true;
  } finally {
    if (created && !published) {
      try { fs.rmSync(temporary, { force: true }); }
      catch (error) { console.error("[cdp] could not clean uncommitted Cookie queue staging file:", error); }
    }
  }
}

/** Clear the queued cookie imports for a profile. */
export function clearQueuedCookieImports(dirId: string): void {
  try {
    const filePath = pendingCookiePath(dirId);
    assertQueuePathSafe(filePath);
    fs.rmSync(filePath, { force: true });
  } catch (error) { console.error(`[cdp] failed to clear queued cookies for ${dirId}:`, error); }
}

export function normalizeCookieForQueue(cookie: any): CookieInfo | null {
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
