// Friendly-error translation (UX-3): behavior tests for
// src/renderer/js/app/errors.js, plus a contract check that every catalog key
// resolves in BOTH languages — a missing key would silently fall back to the
// English inline copy and break the zh UI.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const REPO = path.resolve(__dirname, "..", "..");

function loadHelpers(language: string) {
  const i18nSrc = fs.readFileSync(path.join(REPO, "src/renderer/js/i18n.js"), "utf8");
  const errorsSrc = fs.readFileSync(path.join(REPO, "src/renderer/js/app/errors.js"), "utf8");
  const ctx: any = {
    console,
    CustomEvent: class {},
    document: { addEventListener() {}, dispatchEvent() {}, documentElement: { lang: "" }, querySelectorAll() { return []; } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(i18nSrc, ctx);
  (ctx as any).window.i18n.set(language);
  vm.runInContext(errorsSrc, ctx);
  return (ctx as any).window.agentBrowser.helpers;
}

function loadErrorsJs(language: string) {
  return loadHelpers(language).friendlyError;
}

describe("friendlyError translation", () => {
  it("strips the contextBridge wrapper and Error prefixes", () => {
    const fe = loadErrorsJs("zh-CN");
    const raw = "Error invoking remote method browser:launch: Error: inner cause";
    const out = fe(raw);
    expect(out).not.toContain("Error invoking remote method");
    expect(out).toContain("inner cause");
  });

  it("maps the proxy fail-closed error to actionable copy (zh + en)", () => {
    const raw = "Profile requires proxy \"work\" but it is not configured. Refusing to launch without it — a direct connection would expose your real IP. (proxy: work, last health check: never)";
    const zh = loadErrorsJs("zh-CN")(raw);
    expect(zh).toContain("代理");
    expect(zh).toContain("拒绝启动");
    const en = loadErrorsJs("en-US")(raw);
    expect(en).toContain("needs a working proxy");
    expect(en).toContain("Launch was refused");
  });

  it("maps connection failures to specific network copy", () => {
    const zh = loadErrorsJs("zh-CN");
    expect(zh("Error: connect ECONNREFUSED 127.0.0.1:7890")).toContain("连接被拒绝");
    expect(zh("Error: getaddrinfo ENOTFOUND api.example.com")).toContain("DNS");
    expect(zh("request timed out after 20000ms")).toContain("超时");
  });

  it("maps permission failures to role copy", () => {
    const zh = loadErrorsJs("zh-CN");
    expect(zh("account mutation denied by team policy: role viewer")).toContain("只读");
  });

  it("passes short human messages through unchanged", () => {
    const fe = loadErrorsJs("zh-CN");
    expect(fe("Cache cleared")).toBe("Cache cleared");
  });

  it("truncates stack-like residue to the message line", () => {
    const fe = loadErrorsJs("zh-CN");
    const out = fe("TypeError: cannot read properties of undefined\n    at Object.launch (browser-manager.js:1:1)\n    at handler (ipc.js:2:2)");
    expect(out).toContain("cannot read properties of undefined");
    expect(out).not.toContain("at Object.launch");
  });

  it("known failure classes expose a shortcut action", () => {
    const helpers = loadHelpers("zh-CN");
    const ex = helpers.friendlyErrorEx('Profile requires proxy "work" but it is not configured. Refusing to launch without it — a direct connection would expose your real IP.');
    expect(ex.text).toContain("代理");
    expect(ex.action).toBeTruthy();
    expect(ex.action.label).toContain("代理页");
    expect(typeof ex.action.go).toBe("function");
    // Unknown errors have no action.
    expect(helpers.friendlyErrorEx(" totally unrelated message ").action).toBeNull();
  });

  it("every catalog key resolves in both languages (no silent English fallback in zh)", () => {
    for (const language of ["zh-CN", "en-US"]) {
      const fe = loadErrorsJs(language);
      const catalog = fe.catalog as Array<[RegExp, string, string]>;
      expect(catalog.length).toBeGreaterThan(10);
      for (const [, key, fallback] of catalog) {
        const value = (window_i18n_value as any)(language, key, "__MISSING__");
        expect(value, `${language} missing key ${key}`).not.toBe("__MISSING__");
        expect(String(value).length).toBeGreaterThan(0);
        void fallback;
      }
    }
  });
});

// Small helper: re-load i18n.js per lookup with the requested language.
import * as vm2 from "node:vm";
function window_i18n_value(language: string, key: string, fallback: string): string {
  const i18nSrc = fs.readFileSync(path.join(REPO, "src/renderer/js/i18n.js"), "utf8");
  const ctx: any = {
    console,
    CustomEvent: class {},
    document: { addEventListener() {}, dispatchEvent() {}, documentElement: { lang: "" }, querySelectorAll() { return []; } },
  };
  ctx.window = ctx;
  vm2.createContext(ctx);
  vm2.runInContext(i18nSrc, ctx);
  (ctx as any).window.i18n.set(language);
  return (ctx as any).window.i18n.t(key, fallback);
}
