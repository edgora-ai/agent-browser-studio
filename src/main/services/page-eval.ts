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

export interface PageEvalOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Resolve the engine a profile was created with (defaults to chromium). */
export function getProfileEngineByDirId(dirId: string): BrowserEngine {
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
      return await cdpEvaluate(client, expression);
    } finally {
      try { (client as any).ws?.close?.(); } catch { /* ignore */ }
    }
  }

  const { connectBidi, bidiEvaluateInContext, bidiGetTopContext, bidiNavigate } = await import("./bidi-client.js");
  assertNotAborted(opts.signal);
  const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: opts.timeoutMs ?? 15000 });
  try {
    assertNotAborted(opts.signal);
    try {
      const context = await bidiGetTopContext(conn, opts.timeoutMs ?? 8000);
      return await bidiEvaluateInContext(conn, expression, context, opts.timeoutMs ?? 15000);
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      if (!/no browsing contexts/.test(String(e?.message || e))) throw e;
      await bidiNavigate(conn, "about:blank", null, opts.timeoutMs ?? 15000);
      const context = await bidiGetTopContext(conn, opts.timeoutMs ?? 8000);
      return await bidiEvaluateInContext(conn, expression, context, opts.timeoutMs ?? 15000);
    }
  } finally {
    conn.close();
  }
}

/** Navigate the profile's top-level page (Firefox: BiDi nothing; CDP: Runtime). */
export async function navigateInPage(port: number, engine: BrowserEngine, url: string, opts: PageEvalOpts = {}): Promise<void> {
  if (engine === "chromium") {
    const { cdpConnect, cdpNavigate, cdpDisconnect } = await import("./local-agent.js");
    const client = await cdpConnect(port);
    try {
      await cdpNavigate(client, url);
    } finally {
      cdpDisconnect(client);
    }
    return;
  }
  const { connectBidi, bidiNavigate } = await import("./bidi-client.js");
  const conn = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: opts.timeoutMs ?? 15000 });
  try {
    await bidiNavigate(conn, url, null, opts.timeoutMs ?? 15000);
  } finally {
    conn.close();
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("In-page evaluation cancelled");
}