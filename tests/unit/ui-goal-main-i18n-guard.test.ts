// Node-only guard regressions against the actual main table; never import its module.
import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
// Reader mutations use logical LF text on both LF and CRLF checkouts.
const MAIN = fs.readFileSync(path.join(ROOT, "src/main/services/main-i18n.ts"), "utf8").replace(/\r\n/g, "\n");
const RENDERER = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const LOCALES = ["en-US", "zh-CN"] as const;
type Locale = typeof LOCALES[number];

// Independent required native UI inventory: do not let an equally empty/short
// locale pair pass. This is a minimum contract, not a hard-coded total: the
// complete current key sets/counts below come from the actual source AST, so
// new health/DNS/font keys cannot be omitted from the guard's reported scope.
const ARCHIVE_PLACEHOLDERS: Record<string, string[]> = {
  "archive.export.title": [], "archive.export.batch-title": [],
  "archive.import.title": [], "archive.import.batch-title": [],
  "archive.filter.backup": [], "archive.replace.title": [],
  "archive.replace.message": ["n"], "archive.replace.detail": ["files"],
  "archive.replace.confirm": [], "archive.cancel": [],
};
const REQUIRED_MAIN_KEYS = [
  ...["show", "running", "idle", "quit", "tooltip"].map(key => `tray.${key}`),
  ...["cooldown", "consecutive", "geo-drift", "ip-drift", "idc", "idc-org", "latency", "unchecked", "good"].map(key => `proxy.sug.${key}`),
  ...["no-result", "unavailable", "error", "host-ip", "mdns-only", "clean"].map(key => `webrtc.sum.${key}`),
  "proxy.rotate.reason-cooldown", "proxy.rotate.reason-poor",
  ...["remote-locks", "push-removes-profiles", "push-removes-proxies", "push-removes-extensions", "push-removes-accounts"].map(key => `sync.warn.${key}`),
  ...["pull-imports-profiles", "pull-imports-proxies", "pull-overwrites-conflicts"].map(key => `sync.note.${key}`),
  ...["done", "failed", "cancelled", "missed", "default-rule-name"].map(key => `notify.${key}`),
  ...Object.keys(ARCHIVE_PLACEHOLDERS),
];

function table(source: string) {
  const file = ts.createSourceFile("main-i18n.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = file.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(node => ts.isIdentifier(node.name) && node.name.text === "dict");
  assert.equal(declarations.length, 1);
  const dict = declarations[0].initializer;
  assert.ok(dict && ts.isObjectLiteralExpression(dict));
  return { file, dict };
}
function localeTable(source: string, locale: Locale) {
  const { file, dict } = table(source);
  const matches = dict.properties.filter(node => ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === locale);
  assert.equal(matches.length, 1);
  const node = matches[0] as ts.PropertyAssignment;
  assert.ok(ts.isObjectLiteralExpression(node.initializer));
  return { file, node, entries: node.initializer.properties };
}
function ownKeys(source: string, locale: Locale) {
  return new Set(localeTable(source, locale).entries.map(node => {
    assert.ok(ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name));
    return node.name.text;
  }));
}
function ownStrings(source: string, locale: Locale) {
  const values = new Map<string, string>();
  for (const node of localeTable(source, locale).entries) {
    assert.ok(ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer));
    // Read declaration order like object literals do; never import/evaluate the
    // main module or accidentally accept an inherited/fallback translation.
    values.set(node.name.text, node.initializer.text);
  }
  return values;
}
function placeholders(value: string) { return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort(); }

function omit(source: string, locale: Locale, key: string) {
  const { file, entries } = localeTable(source, locale);
  const matches = entries.filter(node => ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === key);
  assert.equal(matches.length, 1, "omission must target exactly one actual own property");
  const node = matches[0];
  const end = node.getEnd();
  assert.equal(source[end], ",");
  const mutant = source.slice(0, node.getStart(file)) + source.slice(end + 1);
  assert.equal(ownKeys(mutant, locale).has(key), false);
  assert.equal(ownKeys(mutant, locale).size, ownKeys(source, locale).size - 1);
  return mutant;
}
function changeTable(source: string, replacement: string) {
  const { file, dict } = table(source);
  return source.slice(0, dict.getStart(file)) + replacement + source.slice(dict.getEnd());
}
function appendEntry(source: string, locale: Locale, entry: string) {
  const { node } = localeTable(source, locale);
  const at = node.initializer.getEnd() - 1;
  return source.slice(0, at) + entry + ",\n" + source.slice(at);
}

// Each child uses the existing parser through a directory link, an inert renderer
// runtime, private main source and filtered environment. No dependency copies or
// Electron/provider/config imports.
function check(source: string | null, strict: boolean) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-main-i18n-parity-"));
  try {
    for (const dir of ["scripts", "src/renderer/js", "src/main/services", "node_modules", "home", "tmp", "xdg", "m1", "cache"]) {
      fs.mkdirSync(path.join(fixture, dir), { recursive: true });
    }
    fs.copyFileSync(path.join(ROOT, "scripts/check-i18n.mjs"), path.join(fixture, "scripts/check-i18n.mjs"));
    const require = createRequire(path.join(ROOT, "package.json"));
    const parser = require.resolve("typescript");
    fs.symlinkSync(path.resolve(path.dirname(parser), ".."), path.join(fixture, "node_modules/typescript"), "junction");
    fs.writeFileSync(path.join(fixture, "src/renderer/js/i18n.js"), RENDERER);
    if (source !== null) fs.writeFileSync(path.join(fixture, "src/main/services/main-i18n.ts"), source);
    const result = spawnSync(process.execPath, [path.join(fixture, "scripts/check-i18n.mjs"), ...(strict ? ["--strict"] : [])], {
      cwd: fixture, encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: path.join(fixture, "home"), TMPDIR: path.join(fixture, "tmp"), TMP: path.join(fixture, "tmp"), TEMP: path.join(fixture, "tmp"),
        XDG_CONFIG_HOME: path.join(fixture, "xdg"), XDG_CACHE_HOME: path.join(fixture, "cache"), XDG_DATA_HOME: path.join(fixture, "xdg"), XDG_STATE_HOME: path.join(fixture, "xdg"),
        M1_DATA_DIR: path.join(fixture, "m1"), npm_config_cache: path.join(fixture, "cache"), CI: "1", NO_COLOR: "1" },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { exit: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
function assertCounts(output: string, source: string) {
  expect(output).toContain(`main-process key parity: zh=${ownKeys(source, "zh-CN").size} en=${ownKeys(source, "en-US").size}`);
}

describe("native archive translation inventory", () => {
  it.each(LOCALES)("has effective own %s archive translations with the required interpolation fields", locale => {
    const values = ownStrings(MAIN, locale), other = ownStrings(MAIN, locale === "en-US" ? "zh-CN" : "en-US");
    expect(Object.keys(ARCHIVE_PLACEHOLDERS)).toHaveLength(10);
    for (const [key, expected] of Object.entries(ARCHIVE_PLACEHOLDERS)) {
      const value = values.get(key);
      expect(typeof value === "string" && value.trim().length > 0, `${locale} must own a nonempty translation for ${key}`).toBe(true);
      assert.equal(typeof value, "string");
      expect(value !== other.get(key), `${key} must not silently use the other locale`).toBe(true);
      expect(/\p{Script=Han}/u.test(value!), `${key} language`).toBe(locale === "zh-CN");
      expect(placeholders(value!), `${locale} ${key} interpolation contract`).toEqual(expected);
      expect(placeholders(other.get(key)!), `${key} locale placeholder parity`).toEqual(expected);
    }
  });
});

describe.each([false, true])("main own-key guard (strict=%s)", strict => {
  it("reports nonvacuous actual own counts without evaluating the main module", () => {
    const actualInventory = [...new Set(LOCALES.flatMap(locale => [...ownKeys(MAIN, locale)]))].sort();
    expect(REQUIRED_MAIN_KEYS).toHaveLength(45); // The original independent surface is still required.
    expect(new Set(REQUIRED_MAIN_KEYS).size, "the independent inventory must not inflate its count with duplicates").toBe(REQUIRED_MAIN_KEYS.length);
    expect(actualInventory.length).toBeGreaterThanOrEqual(REQUIRED_MAIN_KEYS.length);
    for (const key of REQUIRED_MAIN_KEYS) expect(actualInventory, `required native UI key ${key}`).toContain(key);
    for (const locale of LOCALES) {
      expect([...ownKeys(MAIN, locale)].sort()).toEqual(actualInventory);
      expect(ownKeys(MAIN, locale).size).toBe(actualInventory.length);
      expect(ownKeys(MAIN, locale).has("notify.done")).toBe(true);
      const values = ownStrings(MAIN, locale), other = ownStrings(MAIN, locale === "en-US" ? "zh-CN" : "en-US");
      for (const key of actualInventory) {
        expect(values.get(key)?.trim().length, `${locale}: nonempty own value ${key}`).toBeGreaterThan(0);
        expect(placeholders(values.get(key)!), `${locale}: all-key placeholder parity ${key}`).toEqual(placeholders(other.get(key)!));
      }
    }
    const source = MAIN + '\nconst unrelated = { dict: { "zh-CN": { "fake.key": "PRIVATE_VALUE_SENTINEL" } } };\nunrelated.dict;\nthrow new Error("MAIN_MODULE_MUST_NOT_EXECUTE");\n';
    const result = check(source, strict);
    expect(result.exit, result.output).toBe(0);
    assertCounts(result.output, MAIN);
    expect(result.output).not.toContain("MAIN_MODULE_MUST_NOT_EXECUTE");
  });

  it("includes newly added literal keys in actual counts and rejects either-locale omission without a fixed table size", () => {
    let expanded = MAIN;
    for (const locale of LOCALES) expanded = appendEntry(expanded, locale, '"health.future-own-key": "PRIVATE_VALUE_SENTINEL {n}"');
    for (const locale of LOCALES) expect(ownKeys(expanded, locale).size).toBe(ownKeys(MAIN, locale).size + 1);
    const good = check(expanded, strict);
    expect(good.exit, good.output).toBe(0); assertCounts(good.output, expanded);
    for (const locale of LOCALES) {
      const mutant = omit(expanded, locale, "health.future-own-key"), bad = check(mutant, strict);
      expect(bad.exit, bad.output).toBe(1); assertCounts(bad.output, mutant);
      expect(bad.output).toContain(`missing in ${locale === "en-US" ? "en" : "zh"}: health.future-own-key`);
      expect(bad.output).toContain("key parity FAILED"); expect(bad.output).not.toContain("PRIVATE_VALUE_SENTINEL");
    }
  });

  it.each(LOCALES.flatMap(locale => ["notify.done", "archive.replace.detail"].map(key => ({ locale, key }))))("rejects an actual own $locale $key omission even though the other locale retains it", ({ locale, key }) => {
    const mutant = omit(MAIN, locale, key);
    const other = locale === "en-US" ? "zh-CN" : "en-US";
    expect(ownKeys(mutant, other).has(key)).toBe(true);
    const result = check(mutant, strict);
    expect(result.exit, result.output).toBe(1);
    assertCounts(result.output, mutant);
    expect(result.output).toContain(`missing in ${locale === "en-US" ? "en" : "zh"}: ${key}`);
    expect(result.output).toContain("key parity FAILED");
    // Diagnostics identify keys/counts, never translation or module contents.
    expect(result.output).not.toContain("Scheduled task finished");
    expect(result.output).not.toContain("定时任务已完成");
  });

  it("keeps quoted, reordered, unindented locales and matching duplicates nonvacuous", () => {
    const { dict } = table(MAIN);
    const reversed = `{\n${[...dict.properties].reverse().map(node => node.getText().replace(/^"(en-US|zh-CN)"/, "'$1'")).join(",\n")}\n}`;
    let source = changeTable(MAIN, reversed).replace(/^ +/gm, "");
    for (const locale of LOCALES) source = appendEntry(source, locale, '"notify.done": "DUPLICATE_VALUE_SENTINEL"');
    source += '\nconst unrelated = { "zh-CN": { "notify.failed": "DECOY_VALUE" }, "en-US": { "notify.failed": "DECOY_VALUE", "decoy.key": "DECOY_VALUE" } };\n';
    const good = check(source, strict);
    expect(good.exit, good.output).toBe(0);
    assertCounts(good.output, MAIN);
    // A duplicated key in both locales must not inflate counts or mask another omission.
    const mutant = omit(source, "zh-CN", "notify.failed");
    const bad = check(mutant, strict);
    expect(bad.exit, bad.output).toBe(1);
    assertCounts(bad.output, mutant);
    expect(bad.output).toContain("missing in zh: notify.failed");
    expect(bad.output).not.toMatch(/DUPLICATE_VALUE_SENTINEL|DECOY_VALUE/);
  });

  it.each([
    ["absent declaration", MAIN.replace("const dict:", "const unrelated:")],
    ["nonliteral table", changeTable(MAIN, "loadSideEffectfulDictionary()")],
    ["empty locales", changeTable(MAIN, '{ "zh-CN": {}, "en-US": {} }')],
    ["missing locale", changeTable(MAIN, '{ "en-US": { "notify.done": "PRIVATE_VALUE_SENTINEL" } }')],
    ["extra locale", changeTable(MAIN, '{ "zh-CN": { "a": "x" }, "en-US": { "a": "x" }, "fr-FR": {} }')],
    ["duplicate locale", changeTable(MAIN, '{ "zh-CN": { "a": "x" }, "en-US": { "a": "x" }, "zh-CN": { "a": "x" } }')],
    ["spread entry", appendEntry(MAIN, "zh-CN", "...otherLocale")],
    ["computed key", appendEntry(MAIN, "zh-CN", '["private.key"]: "PRIVATE_VALUE_SENTINEL"')],
    ["prototype setter", appendEntry(MAIN, "zh-CN", '"__proto__": "PRIVATE_VALUE_SENTINEL"')],
    ["dynamic value", appendEntry(MAIN, "zh-CN", '"private.key": sideEffect()')],
    ["getter entry", appendEntry(MAIN, "zh-CN", 'get privateKey() { throw new Error("PRIVATE_VALUE_SENTINEL"); }')],
    ["mutable declaration", MAIN.replace("const dict:", "let dict:")],
    ["duplicate declaration", MAIN + '\nconst dict = {};\n'],
    ["late shadow", MAIN + '\ndict["zh-CN"]["notify.done"] = "PRIVATE_VALUE_SENTINEL";\n'],
    ["assign shadow", MAIN + '\nObject.assign(dict["zh-CN"], { "notify.done": "PRIVATE_VALUE_SENTINEL" });\n'],
    ["alias shadow", MAIN + '\nconst alias = dict; alias["zh-CN"]["notify.done"] = "PRIVATE_VALUE_SENTINEL";\n'],
    ["invalid syntax", MAIN + '\nconst broken = { "PRIVATE_VALUE_SENTINEL": ;\n'],
  ])("fails closed with content-free diagnostics for %s", (_name, source) => {
    const result = check(source, strict);
    expect(result.exit, result.output).toBe(1);
    expect(result.output).toContain("[main-i18n-parity-structure]");
    expect(result.output).not.toContain("PRIVATE_VALUE_SENTINEL");
    expect(result.output).not.toContain("i18n check passed");
  });

  it("preserves renderer-only fixture checking when no main module is present", () => {
    const result = check(null, strict);
    expect(result.exit, result.output).toBe(0);
    expect(result.output).toContain("i18n key parity:");
    expect(result.output).not.toContain("main-process key parity:");
  });
});

// Additive reader-shape checks: these inspect fixtures, never execute tMain.
describe.each([false, true])("bounded main bundle alias (strict=%s)", strict => {
  const anchor = '  const bundle = dict[currentLang] || dict["en-US"];\n';
  function insert(statement: string) {
    assert.equal(MAIN.split(anchor).length, 2);
    return MAIN.replace(anchor, anchor + "  " + statement + "\n");
  }

  it("accepts the read-only alias and both English/caller fallback branches with quotes and trivia", () => {
    const source = MAIN.replace(anchor, "  // Read-only selected bundle; no alias escape.\n  const bundle =\n    dict[currentLang] || dict['en-US'];\n")
      .replaceAll('dict["en-US"][key]', "dict['en-US'][key]");
    expect(source).toContain("return bundle[key]");
    expect(source).toContain("return dict['en-US'][key]");
    expect(source).toContain("return fallback !== undefined ? fallback : key");
    const result = check(source, strict);
    expect(result.exit, result.output).toBe(0);
    assertCounts(result.output, MAIN);
  });

  it("does not confuse unrelated bundle bindings or property names with the supported alias", () => {
    const source = MAIN + '\nfunction unrelated(bundle: Record<string, string>) { delete bundle["private.key"]; }\nconst other = { bundle: "PRIVATE_VALUE_SENTINEL" }; other.bundle;\n';
    const result = check(source, strict);
    expect(result.exit, result.output).toBe(0);
    assertCounts(result.output, MAIN);
    expect(result.output).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  it.each([
    ["independent supported-alias delete", insert('delete bundle["notify.done"];')],
    ["property assignment", insert('bundle["notify.done"] = "PRIVATE_VALUE_SENTINEL";')],
    ["property update", insert('bundle["notify.done"]++;')],
    ["mutating call", insert('Object.assign(bundle, { "notify.done": "PRIVATE_VALUE_SENTINEL" });')],
    ["method call", insert('bundle.clear();')],
    ["second alias", insert('const escaped = bundle; delete escaped["notify.done"];')],
    ["argument escape", insert('consume(bundle);')],
    ["return escape", insert('return bundle;')],
    ["property escape", insert('const escaped = { value: bundle };')],
    ["closure escape", insert('const escaped = () => bundle;')],
    ["nested binding shadow", insert('{ const bundle = {}; consume(bundle); }')],
    ["parameter binding shadow", MAIN.replace('tMain(key: string, fallback?: string)', 'tMain(key: string, fallback?: string, dict?: any)')],
    ["mutable alias", MAIN.replace(anchor, anchor.replace("const bundle", "let bundle"))],
    ["wrapped mutation", insert('(bundle)["notify.done"] = "PRIVATE_VALUE_SENTINEL";')],
  ])("rejects unsupported reader structure for %s without source diagnostics", (_name, source) => {
    const result = check(source, strict);
    expect(result.exit, result.output).toBe(1);
    expect(result.output).toContain("[main-i18n-parity-structure]  Main dictionary reader structure changed");
    expect(result.output).not.toMatch(/PRIVATE_VALUE_SENTINEL|consume|escaped|clear|notify.done|i18n check passed/);
  });
});
