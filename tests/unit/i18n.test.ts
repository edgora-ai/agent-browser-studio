// i18n structural checks: zh-CN and en-US bundles must have identical key
// sets, and key strings referenced from the renderer must exist in both.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const I18N = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/i18n.js"), "utf-8");

function loadI18n() {
  const events: any[] = [];
  const els: any[] = [];
  // Minimal DOM stub: querySelectorAll returns an empty list; dispatchEvent no-ops.
  const dom = {
    documentElement: { lang: "" },
    querySelectorAll: () => [],
    addEventListener: () => {},
    dispatchEvent: () => true,
    createElement: () => ({ setAttribute() {}, appendChild() {}, innerHTML: "" }),
  };
  const ctx: any = {
    window: {
      agentBrowserAPI: { app: { setLanguage: () => Promise.resolve() } },
    },
    document: dom,
    navigator: { language: "en-US" },
    CustomEvent: class { detail: any; constructor(t: string, o: any) { this.detail = o?.detail; } },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout,
    console,
  };
  ctx.window.document = dom;
  ctx.window.navigator = ctx.navigator;
  ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(I18N, ctx);
  return ctx.window.i18n;
}

describe("i18n structure", () => {
  const i18n = loadI18n();

  it("exposes the i18n runtime", () => {
    expect(i18n).toBeTruthy();
    expect(typeof i18n.get).toBe("function");
    expect(typeof i18n.t).toBe("function");
  });

  it("zh-CN and en-US bundles have identical key sets", () => {
    // The dict is private; reach it via per-lang translation of synthetic keys:
    // build the key set by reflecting over the known locale list instead.
    // We approximate by reading the dict blocks from source to keep this a pure
    // structural check (the runtime does not expose the dict).
    const zh = extractBundleKeys(I18N, "zh-CN");
    const en = extractBundleKeys(I18N, "en-US");
    const zhOnly = zh.filter((k) => !en.includes(k));
    const enOnly = en.filter((k) => !zh.includes(k));
    expect(zhOnly, `keys only in zh-CN: ${zhOnly.join(", ")}`).toEqual([]);
    expect(enOnly, `keys only in en-US: ${enOnly.join(", ")}`).toEqual([]);
  });

  it("referenced keys exist in both bundles", () => {
    const zh = extractBundleKeys(I18N, "zh-CN");
    const en = extractBundleKeys(I18N, "en-US");
    for (const key of ["fp.hw.auto", "tab.automation", "tab.runs", "tab.activity", "tab.db", "wizard.step4.title", "wizard.step4.configure", "wizard.step4.finish"]) {
      expect(zh, `missing ${key} in zh-CN`).toContain(key);
      expect(en, `missing ${key} in en-US`).toContain(key);
    }
  });

  it("en-US fallback reads the same value for a known key", () => {
    // t() falls back to en-US then to the provided fallback arg.
    const v = i18n.t("fp.hw.auto", "FALLBACK");
    // Should resolve to a real translation, not the fallback, in en-US mode.
    expect(v).toBe("seed-generated hardware");
  });
});

/** Extract quoted keys from a locale block in the i18n.js source. */
function extractBundleKeys(source: string, locale: string): string[] {
  const start = source.indexOf(`"${locale}": {`);
  assert(start !== -1, `locale ${locale} block not found`);
  // Read the object body until the matching closing brace at depth 0.
  let i = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert(end !== -1, `unterminated ${locale} block`);
  const body = source.slice(start, end);
  // Match "some.key": at the start of an entry (key followed by colon).
  const keyRe = /^\s*"([A-Za-z0-9_.\-]+)"\s*:\s*"/gm;
  const keys = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) keys.add(m[1]);
  return Array.from(keys).sort();
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
