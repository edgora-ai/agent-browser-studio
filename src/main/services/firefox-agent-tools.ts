// ── Agent browser_* tools over WebDriver BiDi (Slice 79.3) ──
//
// The agent tool stack used to be Chromium-only CDP. Firefox speaks BiDi, so
// the same tool names (browser_navigate/evaluate/snapshot/click/type/…)
// dispatch here when the target debug port belongs to a Firefox profile.
// These run through the profile's long-lived BiDi session (the one that
// carries the managed preload scripts), so the agent operates on the SAME
// injected fingerprint world a real user session would see.
//
// Honest boundaries: interactions use native BiDi input actions (pointer
// actions / insertText) — equivalent to WebDriver-level synthesis, not the
// humanized CDP pointer paths; shadow-DOM piercing is not implemented; agent
// tool fidelity for edge cases (frames, uploads on exotic inputs) is lower
// than the Chromium stack and reported as errors rather than faked.

import type { BidiConnection } from "./bidi-client.js";
import {
  bidiGetTopContext,
  bidiEvaluateInContext,
  bidiNavigate,
  bidiCreateContext,
  bidiCaptureScreenshot,
  bidiPerformActions,
  bidiInsertText,
  bidiEvaluateSharedId,
  bidiSetFiles,
  bidiGetCookies,
} from "./bidi-client.js";

/** The in-page text snapshot expression shared by both engine tool stacks. */
export const TEXT_SNAPSHOT_EXPRESSION = `(() => {
  const els = document.querySelectorAll('a, button, input, select, textarea, h1, h2, h3, h4, h5, p, span, label, li, td, th, div[role]');
  const seen = new Set();
  const out = [];
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 100);
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '';
    const key = tag + id + text.slice(0,30);
    if (seen.has(key)) continue; seen.add(key);
    const href = el.href ? ' -> ' + el.href : '';
    const placeholder = el.placeholder ? ' placeholder="' + el.placeholder + '"' : '';
    const type = el.type ? ' type=' + el.type : '';
    out.push('<' + tag + id + cls + type + placeholder + '>' + text + href);
  }
  return out.join('\\n');
})()`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function topContext(conn: BidiConnection): Promise<string> {
  return bidiGetTopContext(conn, 8000);
}

function selectorExpression(selector: string, body: string): string {
  return `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; ${body} })()`;
}

// ── navigation / reading ──

export async function firefoxNavigate(conn: BidiConnection, url: string): Promise<any> {
  const context = await topContext(conn);
  await bidiNavigate(conn, url, context, 20000);
  return { url };
}

export async function firefoxEvaluate(conn: BidiConnection, expression: string): Promise<any> {
  const context = await topContext(conn);
  return bidiEvaluateInContext(conn, expression, context, 20000);
}

export async function firefoxTextSnapshot(conn: BidiConnection): Promise<string> {
  const context = await topContext(conn);
  const value = await bidiEvaluateInContext(conn, TEXT_SNAPSHOT_EXPRESSION, context, 20000);
  return typeof value === "string" ? value : "";
}

export async function firefoxGetText(conn: BidiConnection, selector: string): Promise<{ text: string }> {
  const context = await topContext(conn);
  const text = await bidiEvaluateInContext(
    conn,
    selectorExpression(selector, `return String(e.textContent || '').trim();`),
    context,
    20000,
  );
  return { text: typeof text === "string" ? text : "" };
}

export async function firefoxGetUrl(conn: BidiConnection): Promise<{ url: string }> {
  const context = await topContext(conn);
  const url = await bidiEvaluateInContext(conn, "location.href", context, 20000);
  return { url: typeof url === "string" ? url : "" };
}

export async function firefoxGetTitle(conn: BidiConnection): Promise<{ title: string }> {
  const context = await topContext(conn);
  const title = await bidiEvaluateInContext(conn, "document.title", context, 20000);
  return { title: typeof title === "string" ? title : "" };
}

export async function firefoxGetCookies(conn: BidiConnection): Promise<{ cookies: Array<{ name: string; domain: string }> }> {
  const cookies = await bidiGetCookies(conn, 10000);
  return { cookies: cookies.map((ck) => ({ name: ck.name, domain: ck.domain })) };
}

export async function firefoxNewTab(conn: BidiConnection, url?: string): Promise<{ targetId: string; url: string }> {
  const contextId = await bidiCreateContext(conn, 15000);
  if (url) await bidiNavigate(conn, url, contextId, 20000);
  return { targetId: contextId, url: url || "about:blank" };
}

export async function firefoxScreenshot(conn: BidiConnection): Promise<string | null> {
  return bidiCaptureScreenshot(conn, null, 20000);
}

// ── waiting ──

export async function firefoxWaitForSelector(conn: BidiConnection, selector: string, timeoutMs: number): Promise<{ found: boolean; selector: string }> {
  const context = await topContext(conn);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await bidiEvaluateInContext(
      conn,
      `!!document.querySelector(${JSON.stringify(selector)})`,
      context,
      8000,
    );
    if (found === true) return { found: true, selector };
    if (Date.now() > deadline) return { found: false, selector };
    await sleep(150);
  }
}

export async function firefoxWaitForLoad(conn: BidiConnection, timeoutMs: number): Promise<{ loaded: boolean }> {
  const context = await topContext(conn);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await bidiEvaluateInContext(conn, "document.readyState", context, 8000);
    if (state === "complete") return { loaded: true };
    if (Date.now() > deadline) return { loaded: false };
    await sleep(200);
  }
}

// ── input interactions (native BiDi input actions) ──

async function elementCenter(conn: BidiConnection, selector: string): Promise<{ x: number; y: number }> {
  const context = await topContext(conn);
  const point = await bidiEvaluateInContext(
    conn,
    selectorExpression(
      selector,
      `e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`,
    ),
    context,
    20000,
  );
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error(`Element not found: ${selector}`);
  }
  return { x: point.x, y: point.y };
}

function pointerActions(x: number, y: number, extra: Array<{ type: string; duration?: number; button?: number }>): any[] {
  return [{
    type: "pointer",
    id: "mouse",
    parameters: { pointerType: "mouse" },
    actions: [
      { type: "pointerMove", duration: 60, x, y, origin: "viewport" },
      ...extra,
    ],
  }];
}

export async function firefoxClick(conn: BidiConnection, selector: string): Promise<any> {
  const context = await topContext(conn);
  const { x, y } = await elementCenter(conn, selector);
  await bidiPerformActions(conn, context, pointerActions(x, y, [
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 90 },
    { type: "pointerUp", button: 0 },
  ]), 15000);
  return { success: true, native: true, x, y, selector };
}

export async function firefoxHover(conn: BidiConnection, selector: string): Promise<any> {
  const context = await topContext(conn);
  const { x, y } = await elementCenter(conn, selector);
  await bidiPerformActions(conn, context, pointerActions(x, y, [{ type: "pause", duration: 120 }]), 15000);
  return { success: true, native: true, x, y, selector };
}

export async function firefoxType(conn: BidiConnection, selector: string, text: string): Promise<any> {
  const context = await topContext(conn);
  const focused = await bidiEvaluateInContext(
    conn,
    selectorExpression(
      selector,
      `const tag = String(e.tagName || '').toUpperCase(); const editable = tag === 'INPUT' || tag === 'TEXTAREA' || e.isContentEditable; if (!editable) return false; e.focus(); return document.activeElement === e;`,
    ),
    context,
    20000,
  );
  if (focused !== true) throw new Error(`Element is not editable: ${selector}`);
  const inserted = await bidiInsertText(conn, context, text, 15000);
  return { success: inserted, native: true, selector, chars: text.length };
}

const KEY_VALUE_MAP: Record<string, string> = {
  "enter": "Enter", "tab": "Tab", "escape": "Escape", "backspace": "Backspace",
  "delete": "Delete", "arrowup": "ArrowUp", "arrowdown": "ArrowDown",
  "arrowleft": "ArrowLeft", "arrowright": "ArrowRight", "home": "Home", "end": "End",
  "pageup": "PageUp", "pagedown": "PageDown", "space": " ",
};

export async function firefoxPressKey(conn: BidiConnection, key: string, delayMs?: number): Promise<any> {
  const context = await topContext(conn);
  const value = KEY_VALUE_MAP[key.toLowerCase()] ?? (/^.$/u.test(key) ? key : null);
  if (!value) throw new Error(`Unsupported key for Firefox: ${key}`);
  const actions: any[] = [];
  if (delayMs) actions.push({ type: "pause", duration: Math.min(delayMs, 5000) });
  actions.push({ type: "keyDown", value }, { type: "keyUp", value });
  await bidiPerformActions(conn, context, [{ type: "key", id: "keyboard", actions }], 15000);
  return { success: true, native: true, key };
}

export async function firefoxScroll(conn: BidiConnection, direction: "up" | "down", amount = 500): Promise<any> {
  const context = await topContext(conn);
  const delta = direction === "up" ? -Math.abs(amount) : Math.abs(amount);
  await bidiEvaluateInContext(
    conn,
    `window.scrollBy(0, ${delta}); return true;`,
    context,
    15000,
  );
  return { success: true, direction, amount };
}

export async function firefoxSelect(conn: BidiConnection, selector: string, value: string): Promise<any> {
  const context = await topContext(conn);
  await bidiEvaluateInContext(
    conn,
    selectorExpression(
      selector,
      `e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value;`,
    ),
    context,
    20000,
  );
  return { success: true, selector, value };
}

export async function firefoxUploadFile(conn: BidiConnection, selector: string, filePath: string): Promise<any> {
  const context = await topContext(conn);
  const sharedId = await bidiEvaluateSharedId(
    conn,
    selectorExpression(selector, `return e;`),
    context,
    20000,
  );
  if (!sharedId) throw new Error(`Element not found: ${selector}`);
  const ok = await bidiSetFiles(conn, context, sharedId, [filePath], 20000);
  return { success: ok, selector, file: filePath };
}
