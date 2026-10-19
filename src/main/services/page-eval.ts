// ── Engine-aware in-page evaluation (Slice 79) ──
// One entry point for "run this expression inside the profile's real browser":
//  - chromium → CDP (the patched build's native protocol);
//  - firefox  → WebDriver BiDi (the RoxyFirefox-aligned automation protocol).
//
// Everything that previously hardwired `LocalAgent.cdpEvaluate` now routes by
// engine, so fingerprint capture, drift checks, WebRTC diagnostics, DRM probes
// and environment-risk runtime measurements all work on Firefox too.

import { getConfig } from "./config-manager.js";
import type { BrowserEngine } from "./browser-engine.js";
import { sanitizeBrowserEngine } from "./browser-engine.js";
import { getEntry } from "./browser/runtime-table.js";
import type { BidiConnection } from "./bidi-client.js";
import type { CdpClient } from "./agent/cdp-transport.js";
import { NavigationBudget } from "./agent/cdp-navigation-budget.js";
import { BrowserLoadTimeoutError, BrowserNavigationError } from "./agent/cdp-navigation-errors.js";

export interface PageEvalOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Running engine first; edited launch intent only applies after a restart. */
export function getProfileEngineByDirId(dirId: string): BrowserEngine {
  const running = getEntry(dirId);
  if (running) return running.engine ?? "chromium";
  try {
    const cfg = getConfig() as any;
    return sanitizeBrowserEngine(cfg.browserProfiles?.[dirId]?.engine);
  } catch {
    return "chromium";
  }
}

/**
 * Evaluate an expression in the profile's top-level page. Firefox may report
 * no browsing context right after launch, so we fall back to an about:blank
 * navigation and retry once before failing.
 */
export async function evaluateInPage(
  port: number,
  engine: BrowserEngine,
  expression: string,
  opts: PageEvalOpts = {},
): Promise<any> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid debug port for ${engine}: ${JSON.stringify(port)}`);
  }
  if (engine === "chromium") {
    const { cdpConnect, cdpEvaluate } = await import("./local-agent.js");
    assertNotAborted(opts.signal);
    const client = await cdpConnect(port);
    try {
      assertNotAborted(opts.signal);
      const value = await cdpEvaluate(client, expression, opts.timeoutMs);
      assertNotAborted(opts.signal);
      return value;
    } finally {
      try { (client as any).ws?.close?.(); } catch (error) { throw new Error("In-page connection cleanup failed", { cause: error }); }
    }
  }

  const { connectBidi, getRegisteredFirefoxSession, bidiEvaluateInContext, bidiGetTopContext, bidiNavigate } = await import("./bidi-client.js");

  // A launched profile holds the one allowed BiDi session (the one carrying
  // the managed preload). Route through it so capture sees the same injected
  // world the profile actually presents; fall back to a short-lived session
  // only when no live session is registered (e.g. pre-launch diagnostics).
  assertNotAborted(opts.signal);
  const live = getRegisteredFirefoxSession(port);
  if (live) {
    assertNotAborted(opts.signal);
    try {
      const context = await bidiGetTopContext(live, opts.timeoutMs ?? 8000);
      assertNotAborted(opts.signal);
      const value = await bidiEvaluateInContext(live, expression, context, opts.timeoutMs ?? 15000);
      assertNotAborted(opts.signal);
      return value;
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      if (!/no browsing contexts/.test(String(e?.message || e))) throw e;
      await bidiNavigate(live, "about:blank", null, opts.timeoutMs ?? 15000);
      const context = await bidiGetTopContext(live, opts.timeoutMs ?? 8000);
      assertNotAborted(opts.signal);
      const value = await bidiEvaluateInContext(live, expression, context, opts.timeoutMs ?? 15000);
      assertNotAborted(opts.signal);
      return value;
    }
  }

  const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: opts.timeoutMs ?? 15000 });
  try {
    assertNotAborted(opts.signal);
    try {
      const context = await bidiGetTopContext(conn, opts.timeoutMs ?? 8000);
      assertNotAborted(opts.signal);
      const value = await bidiEvaluateInContext(conn, expression, context, opts.timeoutMs ?? 15000);
      assertNotAborted(opts.signal);
      return value;
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      if (!/no browsing contexts/.test(String(e?.message || e))) throw e;
      await bidiNavigate(conn, "about:blank", null, opts.timeoutMs ?? 15000);
      const context = await bidiGetTopContext(conn, opts.timeoutMs ?? 8000);
      assertNotAborted(opts.signal);
      const value = await bidiEvaluateInContext(conn, expression, context, opts.timeoutMs ?? 15000);
      assertNotAborted(opts.signal);
      return value;
    }
  } finally {
    conn.close();
  }
}

export interface PageNavigationOpts extends PageEvalOpts {
  /** Default remains navigation acceptance, not full page load. */
  waitForLoad?: boolean;
  /** Caller-owned runtime/sender identity assertion, checked through every await. */
  assertCurrent?: () => void;
  /** When supplied, never open or borrow a different Firefox session. */
  expectedFirefoxSession?: BidiConnection | null;
}

/** One engine router for acceptance-only callers and explicit full-load callers. */
export async function navigateInPage(port: number, engine: BrowserEngine, url: string, opts: PageNavigationOpts = {}): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid debug port for ${engine}: ${JSON.stringify(port)}`);
  let borrowed: BidiConnection | undefined;
  let registeredSession: ((port: number) => BidiConnection | null) | undefined;
  const budget = new NavigationBudget(opts.timeoutMs ?? 15000, port,
    () => opts.waitForLoad ? new BrowserLoadTimeoutError() : new BrowserNavigationError("BROWSER_NAVIGATION_TIMEOUT", "In-page navigation timed out"),
    () => {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("In-page navigation cancelled");
      opts.assertCurrent?.();
      if (borrowed && registeredSession?.(port) !== borrowed) throw new BrowserNavigationError("BROWSER_NAVIGATION_SESSION_CHANGED", "Firefox navigation session was replaced or closed");
    });
  let ownedClient: CdpClient | undefined;
  let ownedBidi: BidiConnection | undefined;
  let disconnect: ((client: CdpClient) => void) | undefined;
  const cleanup = () => {
    if (ownedClient && disconnect) { const client = ownedClient; ownedClient = undefined; disconnect(client); }
    if (ownedBidi) { const conn = ownedBidi; ownedBidi = undefined; conn.close(); }
  };
  try {
    if (engine === "chromium") {
      const cdp = await budget.run(() => import("./agent/cdp-transport.js"));
      budget.check();
      disconnect = cdp.cdpDisconnect;
      const client = await budget.run(() => cdp.cdpConnect(port, port, budget.remaining()).then((connected) => {
        ownedClient = connected;
        try { budget.check(); return connected; }
        catch (error) { cleanup(); throw error; }
      }));
      budget.check();
      await budget.run(() => cdp.cdpNavigate(client, url, budget.remaining()));
      budget.check();
      if (opts.waitForLoad) await budget.run(() => cdp.cdpWaitForLoad(client, budget.remaining()));
      budget.check();
      return;
    }
    const bidi = await budget.run(() => import("./bidi-client.js"));
    budget.check();
    registeredSession = bidi.getRegisteredFirefoxSession;
    const live = registeredSession(port);
    if (opts.expectedFirefoxSession !== undefined && (!live || live !== opts.expectedFirefoxSession)) {
      throw new BrowserNavigationError("BROWSER_NAVIGATION_SESSION_CHANGED", "Firefox navigation has no matching managed session");
    }
    let conn: BidiConnection;
    if (live) { borrowed = live; conn = live; }
    else {
      conn = await budget.run(() => bidi.connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: budget.remaining(), signal: budget.signal }).then((connected) => {
        ownedBidi = connected;
        try { budget.check(); return connected; }
        catch (error) { cleanup(); throw error; }
      }));
    }
    budget.check();
    await budget.run(() => bidi.bidiNavigate(conn, url, null, budget.remaining(), opts.waitForLoad ? "complete" : "interactive"));
    budget.check();
  } catch (error) {
    budget.fail(error);
    throw error;
  } finally {
    budget.close();
    cleanup();
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("In-page evaluation cancelled");
}