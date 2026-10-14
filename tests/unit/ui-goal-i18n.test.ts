// Node-only full-runtime regressions. DOM/IPC fixtures do not launch Electron.
import { describe, it, expect, vi } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "../..");
// Normalize only the in-memory mutation fixture, not either shipped mirror.
const SOURCE = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8").replace(/\r\n/g, "\n");
const LOCALES = ["en-US", "zh-CN"] as const;
type Locale = typeof LOCALES[number];
const TRANSLATIONS = [
  ["storage.cache-cleared", "Cache cleared", "缓存已清空"],
  ["storage.caches-cleared", "Caches cleared", "所有缓存已清空"],
  ["toast.profile.create-failed", "Profile creation failed", "创建配置失败"],
  ["sync.use-global", "Use global strategy", "使用全局策略"],
  ["toast.account.read-only", "Accounts are read-only for viewers", "查看者只能查看账号"],
  ["toast.account.updated", "Account updated", "账号已更新"],
  ["toast.account.added", "Account added", "账号已添加"],
  ["agent.chat-welcome.scope", "Select and start a running environment for browser actions. Without one, ask about available tools or recent automation rules and logs.", "执行浏览器操作前，请选择并启动一个环境。未选择环境时，可以询问可用工具或近期自动化规则与日志。"],
  ["agent.chat-suggest.scope-help", "Explain which actions need a browser environment", "说明哪些操作需要浏览器环境"],
  ["agent.chat-suggest.navigation", "Open a website in the selected running environment", "在已选择并运行的环境中打开网站"],
  ["agent.chat-suggest.automation", "Please list recent automation rules and logs", "请列出近期自动化规则与日志"],
  ["agent.conv.delete-failed", "Could not delete the conversation: ", "无法删除会话："],
  ["auto.schedule-load-failed", "Could not load schedule: ", "加载计划状态失败："],
  ["auto.schedule-unavailable", "Schedule unavailable", "计划状态不可用"],
] as const;

type TextNode = { nodeType: 3; textContent: string };
class Element {
  readonly nodeType = 1;
  childNodes: Array<Element | TextNode> = [];
  innerHTML = "";
  constructor(readonly attrs: Record<string, string> = {}) {}
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(node: Element | TextNode) { this.childNodes.push(node); return node; }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value: string) { this.childNodes = value ? [{ nodeType: 3, textContent: value }] : []; }
}
interface Runtime {
  t(key: string, fallback?: string): string;
  get(): Locale;
  set(locale: string): void;
  next(): Locale;
  apply(): void;
}
function loadRuntime(source: string, locale: Locale, elements: Element[] = []) {
  const storage = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const events: Array<{ type: string; detail: unknown }> = [];
  const setMainLanguage = vi.fn(async (_language: string) => {});
  const document = {
    documentElement: { lang: "" },
    querySelectorAll: (selector: string) => elements.filter(el => el.getAttribute(selector.slice(1, -1)) !== null),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    dispatchEvent: (event: { type: string; detail: unknown }) => { events.push(event); return true; },
    createTextNode: (textContent: string): TextNode => ({ nodeType: 3, textContent }),
  };
  const window = { agentBrowserAPI: { app: { setLanguage: setMainLanguage } } } as {
    agentBrowserAPI: { app: { setLanguage: typeof setMainLanguage } };
    i18n: Runtime;
    __uiGoalBundles?: Record<Locale, Record<string, string>>;
  };
  const context = {
    window, document, navigator: { language: locale },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    CustomEvent: class {
      detail: unknown;
      constructor(readonly type: string, options: { detail: unknown }) { this.detail = options.detail; }
    },
  };
  // Execute the entire shipped script, including merges, detection and DOM handlers.
  vm.runInNewContext(source, context, { filename: "i18n.js" });
  return { i18n: window.i18n, window, storage, listeners, events, document, setMainLanguage };
}
function effectiveBundles(source: string) {
  const marker = /^  \/\/ Expose(\r?\n)/gm;
  assert.equal([...source.matchAll(marker)].length, 1, "private dictionary exposure anchor must be unique");
  // Introspection only: capture the private dict after all real merges; no reimplementation.
  const exposed = source.replace(marker, (anchor, eol) => "  window.__uiGoalBundles = dict;" + eol + anchor);
  return loadRuntime(exposed, "en-US").window.__uiGoalBundles!;
}
function validateTranslations(source: string) {
  const bundles = effectiveBundles(source);
  for (const locale of LOCALES) {
    const { i18n } = loadRuntime(source, locale);
    for (const [key, en, zh] of TRANSLATIONS) {
      const expected = locale === "en-US" ? en : zh;
      assert.ok(Object.hasOwn(bundles[locale], key), `${locale}: missing own translation for ${key}`);
      assert.equal(bundles[locale][key], expected, `${locale}: effective value for ${key}`);
      assert.equal(i18n.t(key), expected, `${locale}: public runtime value for ${key}`);
      assert.equal(i18n.t(key, "__FALSE_FALLBACK__"), expected, `${locale}: fallback must not supply ${key}`);
    }
  }
}

describe("UI goal effective i18n", () => {
  const bundles = effectiveBundles(SOURCE);

  it("keeps root and renderer dictionary mirrors byte-identical", () => {
    expect(fs.readFileSync(path.join(ROOT, "i18n.js")).equals(fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js")))).toBe(true);
  });

  it.each(["\n", "\r\n"])("exposes the effective dictionary with %j line endings without weakening the unique anchor", eol => {
    const source = SOURCE.replace(/\n/g, eol);
    validateTranslations(source);
    expect(() => effectiveBundles(source + "  // Expose" + eol)).toThrow(/exposure anchor must be unique/);
    expect(() => effectiveBundles(source.replace(/^  \/\/ Expose\r?\n/m, ""))).toThrow(/exposure anchor must be unique/);
  });

  it.each(TRANSLATIONS)("resolves %s from each locale after every merge", (key, en, zh) => {
    for (const locale of LOCALES) {
      const { i18n } = loadRuntime(SOURCE, locale);
      const expected = locale === "en-US" ? en : zh;
      expect(i18n.get()).toBe(locale);
      expect(Object.hasOwn(bundles[locale], key), `${locale} must not borrow ${key} from English`).toBe(true);
      expect(bundles[locale][key]).toBe(expected);
      expect(i18n.t(key)).toBe(expected);
      expect(i18n.t(key, "__FALSE_FALLBACK__")).toBe(expected);
    }
  });

  it.each(["wizard", "license"])("has own EN/ZH translations for every literal %s call site", module => {
    const code = fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${module}.js`), "utf8");
    const keys = [...new Set([...code.matchAll(/\bt\(\s*['"]([\w.\-]+)['"]/g)].map(match => match[1]))];
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const { i18n } = loadRuntime(SOURCE, locale);
      for (const key of keys) {
        expect(Object.hasOwn(bundles[locale], key), `${module}: missing ${locale} ${key}`).toBe(true);
        expect(i18n.t(key, "__FALSE_FALLBACK__")).toBe(bundles[locale][key]);
      }
    }
  });

  it("covers the actual indirect chat keys without recommending null-scope environment listing", () => {
    const code = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/agent-chat.js"), "utf8");
    for (const key of ["agent.chat-welcome.scope", "agent.chat-suggest.scope-help", "agent.chat-suggest.navigation", "agent.chat-suggest.automation"]) {
      expect(code).toContain(JSON.stringify(key));
    }
    const rejected = "agent.chat-suggest.environments";
    expect(code).not.toContain(rejected);
    for (const locale of LOCALES) expect(Object.hasOwn(bundles[locale], rejected)).toBe(false);
  });

  it.each(LOCALES)("keeps prefix separators and unknown-key fallbacks in %s", locale => {
    const { i18n } = loadRuntime(SOURCE, locale);
    for (const key of ["agent.conv.delete-failed", "auto.schedule-load-failed"]) {
      expect(i18n.t(key) + "DETAIL").toMatch(locale === "en-US" ? /: DETAIL$/ : /：DETAIL$/);
    }
    expect(i18n.t("__unknown_ui_goal_key__", "EXPLICIT FALLBACK")).toBe("EXPLICIT FALLBACK");
    expect(i18n.t("__unknown_ui_goal_key__")).toBe("__unknown_ui_goal_key__");
  });

  it("preserves hydrated SVG children and all DOM label channels across language switches", () => {
    const iconHost = new Element({ "data-icon": "refresh", "data-i18n": "common.retry" });
    const svg = new Element();
    iconHost.appendChild(svg);
    iconHost.appendChild({ nodeType: 3, textContent: "old label" });
    const text = new Element({ "data-i18n": "storage.cache-cleared" });
    const html = new Element({ "data-i18n": "auto.schedule-unavailable", "data-i18n-html": "true" });
    const placeholder = new Element({ "data-i18n-placeholder": "wizard.default-name" });
    const title = new Element({ "data-i18n-title": "auto.schedule-unavailable" });
    const option = new Element({ "data-i18n-option": "sync.use-global" });
    const aria = new Element({ "data-i18n-aria-label": "agent.chat-suggest.scope-help" });
    const h = loadRuntime(SOURCE, "en-US", [iconHost, text, html, placeholder, title, option, aria]);
    h.listeners.get("DOMContentLoaded")!();
    expect(h.setMainLanguage).toHaveBeenLastCalledWith("en-US");
    for (const locale of ["en-US", "zh-CN", "en-US"] as const) {
      h.i18n.set(locale);
      expect(iconHost.childNodes[0] === svg, "hydrated SVG node must survive language changes").toBe(true);
      expect(iconHost.childNodes).toHaveLength(2);
      expect(iconHost.textContent).toBe(h.i18n.t("common.retry"));
      expect(text.textContent).toBe(h.i18n.t("storage.cache-cleared"));
      expect(html.innerHTML).toBe(h.i18n.t("auto.schedule-unavailable"));
      expect(placeholder.getAttribute("placeholder")).toBe(h.i18n.t("wizard.default-name"));
      expect(title.getAttribute("title")).toBe(h.i18n.t("auto.schedule-unavailable"));
      expect(option.textContent).toBe(h.i18n.t("sync.use-global"));
      expect(aria.getAttribute("aria-label")).toBe(h.i18n.t("agent.chat-suggest.scope-help"));
      expect(h.document.documentElement.lang).toBe(locale === "en-US" ? "en" : "zh-CN");
      expect(h.storage.get("agent-browser-studio-language")).toBe(locale);
      expect(h.setMainLanguage).toHaveBeenLastCalledWith(locale);
      expect(h.events.at(-1)).toMatchObject({ type: "agent-browser-language-change", detail: { language: locale } });
    }
  });

  it("falsifies a late English shadow even when the correct Chinese literal remains in source", () => {
    const marker = "  function detectLanguage() {";
    assert.equal(SOURCE.split(marker).length, 2);
    const mutant = SOURCE.replace(marker, '  dict["zh-CN"]["sync.use-global"] = "Use global strategy";\n' + marker);
    expect(mutant.includes('"sync.use-global": "使用全局策略"')).toBe(true);
    expect(loadRuntime(mutant, "zh-CN").i18n.t("sync.use-global")).toBe("Use global strategy");
    expect(() => validateTranslations(mutant)).toThrow(/zh-CN: effective value for sync.use-global/);
  });

  it("falsifies an English fallback masking a missing own Chinese entry", () => {
    const entry = '      "sync.use-global": "使用全局策略",\n';
    assert.equal(SOURCE.split(entry).length, 2);
    const mutant = SOURCE.replace(entry, "");
    expect(loadRuntime(mutant, "zh-CN").i18n.t("sync.use-global", "__FALSE_FALLBACK__")).toBe("Use global strategy");
    expect(() => validateTranslations(mutant)).toThrow(/zh-CN: missing own translation for sync.use-global/);
  });
});

const BACKUP_COPY = {
  "en-US": "Profiles contain real account data. Keep export backups on a separate disk or independently stored cloud/S3 backup. The local 7-day trash only protects against accidental deletion, not disk failure. Encrypted cookies and sessions may require signing in again on another machine.",
  "zh-CN": "配置包含真实账号数据。请把导出备份保存在另一块磁盘或独立存储的云端/S3。7 天本地回收站只防误删，不防磁盘故障。加密 Cookie 与会话换机后可能需要重新登录。",
} as const;

// Run the actual shipped guard against a private quoted dictionary fixture.
// Link the existing offline parser read-only; do not copy dependencies.
function checkParityFixture(source: string, strict = true) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-i18n-parity-"));
  try {
    for (const dir of ["scripts", "src/renderer/js", "node_modules"]) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "scripts/check-i18n.mjs"), path.join(fixture, "scripts/check-i18n.mjs"));
    const require = createRequire(path.join(ROOT, "package.json"));
    const parser = require.resolve("typescript");
    fs.symlinkSync(path.resolve(path.dirname(parser), ".."), path.join(fixture, "node_modules/typescript"), "junction");
    fs.writeFileSync(path.join(fixture, "src/renderer/js/i18n.js"), source);
    const result = spawnSync(process.execPath, [path.join(fixture, "scripts/check-i18n.mjs"), ...(strict ? ["--strict"] : [])], {
      cwd: fixture, encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: fixture, TMPDIR: fixture, TMP: fixture, TEMP: fixture,
        XDG_CONFIG_HOME: fixture, XDG_CACHE_HOME: fixture, XDG_DATA_HOME: fixture, XDG_STATE_HOME: fixture,
        M1_DATA_DIR: fixture, CI: "1", NO_COLOR: "1" },
    });
    assert.ifError(result.error);
    return { exit: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function injectAfterMerges(source: string, statement: string) {
  const marker = "  function detectLanguage() {";
  assert.equal(source.split(marker).length, 2);
  return source.replace(marker, statement + "\n" + marker);
}

// This does not claim linguistic correctness of every legacy translation.
// It checks all own keys and the runtime's actual last-merge winners.
describe("full merged renderer parity and scoped truthful copies", () => {
  it("checks own keys after all three merge layers, not only the first block", () => {
    const bundles = effectiveBundles(SOURCE);
    expect(Object.keys(bundles["en-US"]).sort()).toEqual(Object.keys(bundles["zh-CN"]).sort());
    for (const locale of LOCALES) {
      const { i18n } = loadRuntime(SOURCE, locale);
      for (const [key, value] of Object.entries(bundles[locale])) {
        expect(i18n.t(key, "__FALSE_FALLBACK__"), `${locale}: ${key}`).toBe(value);
      }
    }
  });

  it("reports real quoted locale input and the full effective key counts", () => {
    expect(SOURCE).toContain('"en-US": {');
    expect(SOURCE).toContain('"zh-CN": {');
    const result = checkParityFixture(SOURCE);
    expect(result.exit, result.output).toBe(0);
    const bundles = effectiveBundles(SOURCE);
    expect(result.output).toContain(`i18n key parity: zh=${Object.keys(bundles["zh-CN"]).length} en=${Object.keys(bundles["en-US"]).length}`);
  });

  it.each([
    ["en-US", '      "sync.use-global": "Use global strategy",\n', "missing in en"],
    ["zh-CN", '      "sync.use-global": "使用全局策略",\n', "missing in zh"],
  ])("rejects a missing own %s key from the final merge layer", (_locale, entry, diagnostic) => {
    assert.equal(SOURCE.split(entry).length, 2);
    const mutant = SOURCE.replace(entry, "");
    const result = checkParityFixture(mutant);
    expect(result.exit, result.output).toBe(1);
    expect(result.output).toContain(diagnostic + ": sync.use-global");
  });

  it.each([
    ["en-US", '      "sync.use-global": "Use global strategy",\n'],
    ["zh-CN", '      "sync.use-global": "使用全局策略",\n'],
  ])("also fails the default build guard for a missing own late-layer %s key", (_locale, entry) => {
    assert.equal(SOURCE.split(entry).length, 2);
    const result = checkParityFixture(SOURCE.replace(entry, ""), false);
    expect(result.exit, result.output).toBe(1);
    expect(result.output).toContain("key parity FAILED");
  });

  it("rejects a late shadow even though keys and the correct literal survive", () => {
    const mutant = injectAfterMerges(SOURCE, '  dict["zh-CN"]["sync.use-global"] = "Use global strategy";');
    expect(mutant).toContain('"sync.use-global": "使用全局策略"');
    expect(loadRuntime(mutant, "zh-CN").i18n.t("sync.use-global")).toBe("Use global strategy");
    const result = checkParityFixture(mutant);
    expect(result.exit, result.output).toBe(1);
    expect(result.output).toContain("i18n-effective-value");
    expect(result.output).toContain("zh-CN: sync.use-global");
  });

  it("fails closed when an own locale bundle is absent", () => {
    const result = checkParityFixture(injectAfterMerges(SOURCE, '  delete dict["zh-CN"];'));
    expect(result.exit, result.output).toBe(1);
    expect(result.output).toContain("i18n-parity-evaluation");
  });

  it.each(LOCALES)("uses truthful backup copy as an own %s translation and DOM label", locale => {
    const el = new Element({ "data-i18n": "backup.hint.body" });
    const { i18n } = loadRuntime(SOURCE, locale, [el]);
    const bundles = effectiveBundles(SOURCE);
    expect(Object.hasOwn(bundles[locale], "backup.hint.body")).toBe(true);
    expect(bundles[locale]["backup.hint.body"]).toBe(BACKUP_COPY[locale]);
    expect(i18n.t("backup.hint.body", "__FALSE_FALLBACK__")).toBe(BACKUP_COPY[locale]);
    i18n.apply();
    expect(el.textContent).toBe(BACKUP_COPY[locale]);
  });

  it("keeps the backup HTML fallback equal to the truthful English winner", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
    const matches = [...html.matchAll(/<div\b[^>]*data-i18n="backup\.hint\.body"[^>]*>([^<]*)<\/div>/g)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe(BACKUP_COPY["en-US"]);
    expect(html).toContain('id="backup-hint"');
    expect(html).toContain('data-cmd="dismissBackupHint"');
  });

  it.each([
    ["webrtc.diag.clear-title", "Clear history?", "清除历史？"],
    ["webrtc.diag.clear-confirm", "Clear this profile's WebRTC diagnostic history? This cannot be undone.", "清除该配置的 WebRTC 诊断历史？此操作无法撤销。"],
  ])("owns %s in both locales and matches the actual existing English call-site fallback", (key, en, zh) => {
    const profiles = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/profiles.js"), "utf8");
    expect(profiles).toContain(`t(${JSON.stringify(key)}, ${JSON.stringify(en)})`);
    const bundles = effectiveBundles(SOURCE);
    for (const locale of LOCALES) {
      expect(Object.hasOwn(bundles[locale], key)).toBe(true);
      expect(bundles[locale][key]).toBe(locale === "en-US" ? en : zh);
      expect(loadRuntime(SOURCE, locale).i18n.t(key, "__FALSE_FALLBACK__")).toBe(bundles[locale][key]);
    }
  });
});
