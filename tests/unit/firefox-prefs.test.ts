import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFirefoxUserJs, writeFirefoxUserJs } from "../../src/main/services/browser-engine.js";
import { FIREFOX_FINGERPRINT_PREF_KEYS, parseFirefoxPrefs } from "../../src/main/services/firefox-prefs.js";
import { buildFirefoxFingerprintPrefs, buildFirefoxNativeFingerprintPrefs } from "../../src/main/services/firefox-fingerprint.js";
import { buildBrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";

// Wrap the native ESM namespace (not the filesystem) so individual real I/O
// calls can be fault-injected without adding production test hooks.
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
afterEach(() => vi.restoreAllMocks());
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "firefox-prefs-test-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
function profile(): string {
  const dir = path.join(root, String(++counter));
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}
const pref = (key: string, value: string | number | boolean) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});\n`;
const identity = {
  "general.useragent.override": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) Gecko/20100101 Firefox/154.0",
  "general.useragent.site_specific_overrides": false,
  "dom.maxHardwareConcurrency": 8,
  "intl.accept_languages": "en-US,en",
  "webgl.disabled": false,
  "privacy.donottrackheader.enabled": true,
  "privacy.donottrackheader.value": 1,
  "media.peerconnection.ice.obfuscate_host_addresses": true,
  "media.peerconnection.ice.proxy_only": true,
};
const stateName = ".agent-browser-firefox-prefs.json";
const lockName = ".agent-browser-firefox-prefs.lock";
function read(dir: string, name = "user.js"): string { return fs.readFileSync(path.join(dir, name), "utf8"); }
function seed(dir: string, name: string, text: string): void { fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 }); }

// Exact historical program output, not a guessed list of Firefox defaults.
function legacy(extra: Record<string, string | number | boolean> = identity): string {
  return "// Agent Browser Studio managed Firefox preferences (RoxyFirefox-aligned, regenerated at launch).\n" +
    Object.entries(extra).map(([key, value]) => pref(key, value)).join("") +
    pref("focusmanager.testmode", true) + pref("layout.testing.top-level-always-active", true) +
    pref("dom.min_background_timeout_value", 0) + pref("dom.min_background_timeout_value_without_budget_throttling", 0) +
    pref("dom.timeout.enable_budget_timer_throttling", false) + pref("browser.startup.homepage", "about:home") +
    pref("browser.newtabpage.enabled", true) + pref("layers.acceleration.disabled", false) +
    pref("gfx.webrender.disabled", false) + pref("security.sandbox.content.level", 0) +
    pref("layout.css.prefers-color-scheme.content-override", 2) + pref("extensions.activeThemeID", "default-theme@mozilla.org") +
    pref("network.proxy.type", 1) + pref("network.proxy.http", "proxy.example") + pref("network.proxy.http_port", 8080) +
    pref("network.proxy.ssl", "proxy.example") + pref("network.proxy.ssl_port", 8080) +
    pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1, ::1") +
    pref("network.proxy.username", "u") + pref("network.proxy.password", "old-secret") +
    pref("network.trr.mode", 3) + pref("network.trr.uri", "https://dns.example/dns-query") +
    pref("intl.locale.requested", "en-US") + pref("app.update.auto", false) +
    pref("browser.shell.checkDefaultBrowser", false) + pref("browser.startup.page", 0);
}

describe("Firefox managed prefs safety", () => {
  it("tracks exactly the real fallback/native fingerprint generator keys", () => {
    const config = buildBrowserFingerprintConfig({ fingerprintSeed: 4242, platform: "macos", locale: "en-US" } as any, "154.0", null, "firefox");
    const fallback = buildFirefoxFingerprintPrefs({ ...config, doNotTrack: true } as any, "154.0");
    const native = buildFirefoxNativeFingerprintPrefs({ ...config, doNotTrack: true } as any, "154.0");
    expect(Object.keys(native).sort()).toEqual([...FIREFOX_FINGERPRINT_PREF_KEYS].sort());
    expect(Object.keys(native).filter(key => !(key in fallback))).toEqual(["agent.browser.fingerprint.config"]);
    const dir = profile(); writeFirefoxUserJs(dir, { extraPrefs: native, locale: "en-US" });
    writeFirefoxUserJs(dir, { extraPrefs: fallback, locale: "en-US" });
    const result = writeFirefoxUserJs(dir, { fingerprintMode: "off" });
    expect(result.releasedKeys).toEqual([...Object.keys(fallback), "intl.locale.requested"].sort());
    for (const name of ["user.js", "prefs.js"]) {
      const persisted = new Map(parseFirefoxPrefs(read(dir, name)).map(row => [row.key, row.value]));
      for (const key of Object.keys(native)) expect(persisted.has(key)).toBe(false);
      expect(persisted.has("intl.locale.requested")).toBe(false);
    }
  });

  it("accepts native user-pref syntax including comments, signed int32 and UTF-8 byte escapes", () => {
    const rows = parseFirefoxPrefs("# header\ruser_pref(/* key */ 'a', + /* sign */ 2147483647);\r\n" +
      "user_pref('b', -2147483648); user_pref('text', '\\xC3\\xA9\\uD83D\\uDE00\\n\\r\\\\\\\"\\\''); /* end */");
    expect(rows.map(row => [row.key, row.value])).toEqual([["a", 2147483647], ["b", -2147483648], ["text", 'é😀\n\r\\"\'']]);
    expect(() => parseFirefoxPrefs('user_pref("a", 2147483648);')).toThrow();
    expect(() => parseFirefoxPrefs('user_pref("a", -2147483649);')).toThrow();
    expect(parseFirefoxPrefs('user_pref("a", "\\xFF");')[0].value).toEqual({ kind: "bytes", hex: "ff" });
    expect(() => parseFirefoxPrefs('user_pref("a.b", 1); user_pref("a\\u002eb", 2);')).toThrow();
  });

  it("preserves BOM characters inside strings and a legal leading file BOM", () => {
    const value = String.fromCharCode(0xfeff) + "keep";
    expect(parseFirefoxPrefs('user_pref("custom", "\\uFEFFkeep");')[0].value).toBe(value);
    const dir = profile(), text = value[0] + pref("custom.keep", true);
    seed(dir, "user.js", text); writeFirefoxUserJs(dir, {});
    expect(read(dir).startsWith(text)).toBe(true);
  });

  it("round-trips hostile-looking strings as values, not injected statements", () => {
    const password = 'quote"\n); user_pref("evil", true); //\t\b\f\\u0000😀';
    const text = buildFirefoxUserJs({ proxy: { type: "socks5h", host: "::1", port: 1080, password } });
    const persisted = new Map(parseFirefoxPrefs(text).map(row => [row.key, row.value]));
    expect(persisted.get("network.proxy.password")).toBe(password);
    expect(persisted.get("network.proxy.socks_version")).toBe(5);
    expect(persisted.has("evil")).toBe(false);
  });

  it("is byte-stable on repeated writes and does not re-adopt owned values as user originals", () => {
    const dir = profile();
    const opts = { extraPrefs: identity, locale: "en-US", allowThirdPartyCookies: true, colorScheme: "dark" as const };
    writeFirefoxUserJs(dir, opts);
    const initial = [read(dir), read(dir, "prefs.js"), read(dir, stateName)];
    for (let i = 0; i < 3; i++) {
      writeFirefoxUserJs(dir, opts);
      expect([read(dir), read(dir, "prefs.js"), read(dir, stateName)]).toEqual(initial);
    }
    writeFirefoxUserJs(dir, { fingerprintMode: "off", colorScheme: "system" });
    for (const file of ["user.js", "prefs.js"]) {
      expect(read(dir, file)).not.toContain("general.useragent.override");
      expect(read(dir, file)).not.toContain("ui.systemUsesDarkTheme");
      expect(read(dir, file)).not.toContain("network.cookie.cookieBehavior");
      expect(read(dir, file)).not.toContain("intl.locale.requested");
    }
  });

  it("defers restoring saved proxy values until the managed proxy is released", () => {
    const dir = profile();
    seed(dir, "prefs.js", pref("network.proxy.http", "personal-proxy.example") + pref("custom.keep", 9));
    writeFirefoxUserJs(dir, { proxy: { type: "http", host: "managed-proxy.example", port: 8080 } });
    writeFirefoxUserJs(dir, { proxy: { type: "socks5", host: "socks.example", port: 1080 } });
    const persisted = new Map(parseFirefoxPrefs(read(dir, "prefs.js")).map(row => [row.key, row.value]));
    expect(persisted.get("network.proxy.http")).toBe("");
    expect(persisted.get("custom.keep")).toBe(9);
    writeFirefoxUserJs(dir, { proxy: null });
    expect(new Map(parseFirefoxPrefs(read(dir, "prefs.js")).map(row => [row.key, row.value])).get("network.proxy.http")).toBe("personal-proxy.example");
  });

  it("allows unrelated edits outside the managed block but refuses conflicting edits", () => {
    const dir = profile(); writeFirefoxUserJs(dir, { extraPrefs: identity });
    fs.appendFileSync(path.join(dir, "user.js"), pref("custom.later", true));
    writeFirefoxUserJs(dir, { extraPrefs: identity });
    expect(read(dir)).toContain('"custom.later", true');
    const changed = read(dir, "prefs.js").replace(pref("dom.maxHardwareConcurrency", 8), pref("dom.maxHardwareConcurrency", 16));
    seed(dir, "prefs.js", changed); const user = read(dir), state = read(dir, stateName);
    expect(() => writeFirefoxUserJs(dir, { fingerprintMode: "off" })).toThrow(/ownership|changed/i);
    expect(read(dir, "prefs.js")).toBe(changed); expect(read(dir)).toBe(user); expect(read(dir, stateName)).toBe(state);
  });

  it("rejects an edited managed block, missing state, or duplicate state members", () => {
    const dir = profile(); writeFirefoxUserJs(dir, { extraPrefs: identity });
    const user = read(dir), state = read(dir, stateName);
    seed(dir, "user.js", user.replace(pref("dom.maxHardwareConcurrency", 8), pref("dom.maxHardwareConcurrency", 16)));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/state|ownership/i);
    seed(dir, "user.js", user); fs.unlinkSync(path.join(dir, stateName));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/state|ownership/i);
    seed(dir, stateName, state.replace('"version":1', '"version":1,"version":1'));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/state|ownership/i);
  });

  it("does not infer historic ownership from only a copied header or a partial file", () => {
    const dir = profile(); const text = legacy().split("\n").slice(0, 8).join("\n") + "\n";
    seed(dir, "user.js", text); seed(dir, "prefs.js", pref("security.sandbox.content.level", 0));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/legacy|ownership/i);
    expect(read(dir)).toBe(text);
  });

  it("refuses residual legacy-family keys that are no longer represented in user.js", () => {
    const dir = profile(); seed(dir, "user.js", legacy({}));
    const persisted = pref("general.useragent.override", identity["general.useragent.override"]);
    seed(dir, "prefs.js", persisted);
    expect(() => writeFirefoxUserJs(dir, { fingerprintMode: "off" })).toThrow(/ownership|legacy/i);
    expect(read(dir, "prefs.js")).toBe(persisted);
  });

  it("reports legacy loss honestly and migrates the historical disabled-sandbox branch", () => {
    const dir = profile(); const text = legacy().replace(pref("security.sandbox.content.level", 0), pref("security.sandbox.content.level", -1));
    seed(dir, "user.js", text); seed(dir, "prefs.js", pref("security.sandbox.content.level", -1));
    const result = writeFirefoxUserJs(dir, { fingerprintMode: "off" });
    expect(result.migratedLegacy).toBe(true);
    expect(result.releasedKeys).toContain("security.sandbox.content.level");
    expect(result.legacyBaselineUnavailable).toContain("security.sandbox.content.level");
    expect(JSON.stringify(result)).not.toContain("old-secret");
    expect(read(dir, "prefs.js")).not.toContain("security.sandbox.content.level");
  });

  it("refuses invalid tokens and hard-linked prefs without reading linked contents", () => {
    const dir = profile(); fs.writeFileSync(path.join(dir, "prefs.js"), Buffer.from([0xff, 0xfe]));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/malformed|syntax/i);
    fs.unlinkSync(path.join(dir, "prefs.js"));
    const target = path.join(root, `hardlink-${++counter}`); fs.writeFileSync(target, "sentinel");
    fs.linkSync(target, path.join(dir, "prefs.js"));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/hardlink|regular/i);
    expect(fs.readFileSync(target, "utf8")).toBe("sentinel");
  });

  it.each(["user.js", "prefs.js", stateName])("never opens a symlinked %s", (name) => {
    const dir = profile(), target = path.join(root, `absent-symlink-target-${++counter}`);
    fs.symlinkSync(target, path.join(dir, name));
    const open = vi.spyOn(fs, "openSync");
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/symlink|regular/i);
    expect(open.mock.calls.some(args => args[0] === path.join(dir, name) || args[0] === target)).toBe(false);
  });

  it("seals existing public-mode files and creates new profile directories privately", () => {
    const dir = path.join(root, `fresh-${++counter}`, "profile");
    writeFirefoxUserJs(dir, {});
    fs.chmodSync(path.join(dir, "user.js"), 0o644); fs.chmodSync(path.join(dir, "prefs.js"), 0o644); fs.chmodSync(path.join(dir, stateName), 0o644);
    writeFirefoxUserJs(dir, {});
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      for (const file of ["user.js", "prefs.js", stateName]) expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps custom filenames safe and never permits a second owner for prefs.js", () => {
    const dir = profile(); writeFirefoxUserJs(dir, {}, "automation.js");
    expect(fs.existsSync(path.join(dir, "automation.js"))).toBe(true);
    expect(() => writeFirefoxUserJs(dir, {}, "user.js")).toThrow(/state|ownership/i);
    expect(() => writeFirefoxUserJs(dir, {}, "prefs.js")).toThrow();
  });

  it("defers sandbox defaults to Gecko and explicitly rejects disabling it", () => {
    expect(buildFirefoxUserJs({})).not.toContain("security.sandbox.content.level");
    expect(buildFirefoxUserJs({ sandboxPermission: true })).not.toContain("security.sandbox.content.level");
    expect(() => buildFirefoxUserJs({ sandboxPermission: false })).toThrow(/sandbox/i);
  });

  it.each([
    { sandboxPermission: false },
    { sandboxPermission: 0 },
    { useGpu: "true" },
    { allowThirdPartyCookies: "false" },
    { fingerprintMode: "invalid" },
    { fingerprintMode: "off", extraPrefs: identity },
    { extraPrefs: JSON.parse('{"__proto__":false}') },
    { proxy: { type: "http", host: "%%%%", port: 8080 } },
    { extraPrefs: { "security.sandbox.content.level": 0 } },
    { extraPrefs: { "unknown.preference": true } },
    { extraPrefs: { "dom.maxHardwareConcurrency": Number.NaN } },
    { extraPrefs: { "dom.maxHardwareConcurrency": Number.POSITIVE_INFINITY } },
    { extraPrefs: { "dom.maxHardwareConcurrency": 1.5 } },
    { extraPrefs: { "dom.maxHardwareConcurrency": 2 ** 32 } },
    { extraPrefs: { "webgl.disabled": "false" } },
    { proxy: { type: "http", host: "proxy.example", port: 0 } },
    { proxy: { type: "http", host: "proxy.example", port: 65536 } },
    { proxy: { type: "unknown", host: "proxy.example", port: 8080 } },
    { dohUrl: "javascript:alert(1)" },
    { colorScheme: "unknown" },
    { locale: "en-US\x00hidden" },
    { locale: "\ud800" },
  ])("rejects invalid or out-of-scope input before touching a profile (%j)", (opts) => {
    const dir = path.join(root, `invalid-${++counter}`);
    expect(() => writeFirefoxUserJs(dir, opts as any)).toThrow();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes valid Gecko escapes rather than JSON-only tab/backspace escapes", () => {
    const text = buildFirefoxUserJs({ proxy: { type: "http", host: "proxy.example", port: 8080, password: 'quote"\n); user_pref("evil", true); //\t\b\f' } });
    expect(text).toContain("\\u0009");
    expect(text).not.toContain("\\t");
    expect(text).not.toContain("\\b");
    expect(text).not.toContain("\\f");
  });

  it("preserves legal unrelated user.js and prefs.js content, comments and escapes", () => {
    const dir = profile();
    const user = "# User-owned settings\r\n/* keep */ user_pref('custom.label', 'a\\x41\\u4e2d'); // tail\r\n";
    const prefs = "// Mozilla User Preferences\nuser_pref(\"browser.zoom.siteSpecific\", false);\n";
    seed(dir, "user.js", user); seed(dir, "prefs.js", prefs);
    writeFirefoxUserJs(dir, { useGpu: true });
    expect(read(dir)).toContain(user);
    expect(read(dir, "prefs.js")).toContain(prefs);
    expect(JSON.parse(read(dir, stateName)).version).toBe(1);
    if (process.platform !== "win32") {
      for (const file of ["user.js", "prefs.js", stateName]) expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(dir, lockName))).toBe(false);
  });

  it("restores prior user identity/locale values when managed becomes off", () => {
    const dir = profile();
    seed(dir, "user.js", pref("general.useragent.override", "personal-UA") + pref("intl.locale.requested", "fr") + pref("custom.user", true));
    seed(dir, "prefs.js", pref("general.useragent.override", "saved-UA") + pref("intl.locale.requested", "de") + pref("custom.saved", 42));
    writeFirefoxUserJs(dir, { extraPrefs: identity, locale: "en-US" });
    writeFirefoxUserJs(dir, { fingerprintMode: "off" } as any);
    expect(read(dir)).toContain(pref("general.useragent.override", "personal-UA").trim());
    expect(read(dir)).toContain(pref("intl.locale.requested", "fr").trim());
    expect(read(dir, "prefs.js")).toContain(pref("general.useragent.override", "saved-UA").trim());
    expect(read(dir, "prefs.js")).toContain(pref("intl.locale.requested", "de").trim());
    expect(read(dir)).toContain('"custom.user", true');
    expect(read(dir, "prefs.js")).toContain('"custom.saved", 42');
    for (const key of Object.keys(identity).filter(key => key !== "general.useragent.override")) {
      expect(read(dir)).not.toContain(JSON.stringify(key));
      expect(read(dir, "prefs.js")).not.toContain(JSON.stringify(key));
    }
  });

  it("removes only owned persisted HTTP credentials and DoH URI on SOCKS/direct switches", () => {
    const dir = profile();
    writeFirefoxUserJs(dir, { proxy: { type: "http", host: "proxy.example", port: 8080, username: "u", password: "old-secret" }, dohUrl: "https://dns.example/dns-query" });
    writeFirefoxUserJs(dir, { proxy: { type: "socks5", host: "socks.example", port: 1080 } });
    for (const name of ["user.js", "prefs.js"]) {
      const text = read(dir, name);
      const prefs = new Map(parseFirefoxPrefs(text).map(row => [row.key, row.value]));
      for (const protocol of ["http", "ssl"]) {
        expect(prefs.get(`network.proxy.${protocol}`)).toBe("");
        expect(prefs.get(`network.proxy.${protocol}_port`)).toBe(0);
      }
      expect(prefs.get("network.proxy.password")).toBe("");
      expect(prefs.has("network.trr.uri")).toBe(false);
      expect(text).not.toContain("old-secret");
      expect(text).toContain('"network.proxy.socks", "socks.example"');
    }
    writeFirefoxUserJs(dir, {});
    for (const name of ["user.js", "prefs.js"]) expect(read(dir, name)).not.toContain('"network.proxy.socks"');
    expect(read(dir, stateName)).not.toContain("old-secret");
  });

  it("releases the actual native config key and optional DNT prefs when no longer generated", () => {
    const dir = profile();
    writeFirefoxUserJs(dir, { extraPrefs: { ...identity, "agent.browser.fingerprint.config": "native-snapshot" } });
    const { "privacy.donottrackheader.enabled": _enabled, "privacy.donottrackheader.value": _value, ...fallback } = identity;
    writeFirefoxUserJs(dir, { extraPrefs: fallback });
    for (const name of ["user.js", "prefs.js"]) {
      expect(read(dir, name)).not.toContain('"agent.browser.fingerprint.config"');
      expect(read(dir, name)).not.toContain('"privacy.donottrackheader.enabled"');
      expect(read(dir, name)).toContain('"media.peerconnection.ice.proxy_only", true');
    }
  });

  it("migrates exact historical program overrides without deleting other saved prefs", () => {
    const dir = profile();
    seed(dir, "user.js", legacy());
    seed(dir, "prefs.js", legacy().split("\n").filter(line => !line.startsWith("//")).join("\n") + pref("custom.saved", "keep"));
    writeFirefoxUserJs(dir, { fingerprintMode: "off", useGpu: true } as any);
    for (const name of ["user.js", "prefs.js"]) {
      const text = read(dir, name);
      for (const key of [...Object.keys(identity), "security.sandbox.content.level", "intl.locale.requested", "network.proxy.password", "network.trr.uri"]) expect(text).not.toContain(JSON.stringify(key));
    }
    expect(read(dir, "prefs.js")).toContain('"custom.saved", "keep"');
    expect(fs.existsSync(path.join(dir, stateName))).toBe(true);
  });

  it("does not guess ownership of a modified legacy sandbox value", () => {
    const dir = profile(); const user = legacy();
    const saved = pref("security.sandbox.content.level", 2);
    seed(dir, "user.js", user); seed(dir, "prefs.js", saved);
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/ownership|conflict|changed/i);
    expect(read(dir)).toBe(user); expect(read(dir, "prefs.js")).toBe(saved);
  });

  it("refuses an unsafe unowned sandbox override instead of silently launching weakened", () => {
    const dir = profile(); const saved = pref("security.sandbox.content.level", 0);
    seed(dir, "prefs.js", saved);
    expect(() => writeFirefoxUserJs(dir, { sandboxPermission: true })).toThrow(/sandbox/i);
    expect(read(dir, "prefs.js")).toBe(saved);
    expect(fs.existsSync(path.join(dir, "user.js"))).toBe(false);
  });

  it.each([
    'user_pref("custom", true); globalThis.__firefoxPrefsExecuted = true;',
    'user_pref("custom", (() => true)());',
    'user_pref("custom", true); user_pref("custom", false);',
    'user_pref("custom", NaN);',
    'user_pref("custom", 0.5);',
    'user_pref("custom", true',
    '/* unterminated',
    'user_pref("custom", "\\u0000");',
    'user_pref("custom", "\\ud800");',
  ])("refuses malformed/ambiguous prefs as data, never executes them (%s)", (text) => {
    const dir = profile(); seed(dir, "prefs.js", text);
    expect(() => writeFirefoxUserJs(dir, {})).toThrow();
    expect(read(dir, "prefs.js")).toBe(text);
    expect((globalThis as any).__firefoxPrefsExecuted).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "user.js"))).toBe(false);
  });

  it("refuses a malformed ownership record without touching either prefs file", () => {
    const dir = profile(); writeFirefoxUserJs(dir, { extraPrefs: identity });
    const user = read(dir); const saved = read(dir, "prefs.js");
    seed(dir, stateName, '{"version":1');
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/state|ownership/i);
    expect(read(dir)).toBe(user); expect(read(dir, "prefs.js")).toBe(saved);
  });

  it("refuses an interrupted transaction instead of treating partial writes as success", () => {
    const dir = profile(); seed(dir, lockName, "pending\n");
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/transaction|lock/i);
    expect(read(dir, lockName)).toBe("pending\n");
    expect(fs.existsSync(path.join(dir, "user.js"))).toBe(false);
  });

  it("rejects custom filename traversal and refuses symlinks without opening their targets", () => {
    const dir = profile();
    expect(() => writeFirefoxUserJs(dir, {}, "../escape.js")).toThrow();
    const target = path.join(root, "symlink-target"); seed(root, "symlink-target", "sentinel\n");
    fs.symlinkSync(target, path.join(dir, "user.js"));
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/symlink|regular|link/i);
    expect(fs.readFileSync(target, "utf8")).toBe("sentinel\n");
    const link = path.join(root, "linked-profile"); fs.symlinkSync(dir, link, "dir");
    expect(() => writeFirefoxUserJs(link, {})).toThrow(/symlink|directory|link/i);
  });
});

describe("Firefox prefs independent-review regressions", () => {
  const prefMap = (dir: string, file = "prefs.js") => new Map(parseFirefoxPrefs(read(dir, file)).map(row => [row.key, row.value]));

  it("holds personal HTTP/SSL host+port baselines inactive until the managed proxy is released", () => {
    const dir = profile();
    const personal = pref("network.proxy.http", "personal.example") + pref("network.proxy.http_port", 3128) +
      pref("network.proxy.ssl", "personal.example") + pref("network.proxy.ssl_port", 3128) + pref("custom.keep", 9);
    seed(dir, "prefs.js", personal);
    writeFirefoxUserJs(dir, { proxy: { type: "http", host: "managed-http.example", port: 8080 } });
    writeFirefoxUserJs(dir, { proxy: { type: "socks5", host: "managed-socks.example", port: 1080 } });
    for (const file of ["user.js", "prefs.js"]) {
      const prefs = prefMap(dir, file);
      // nsProtocolProxyService picks usable HTTP/SSL before the SOCKS fallback.
      expect(prefs.get("network.proxy.type")).toBe(1);
      for (const protocol of ["http", "ssl"]) {
        expect(prefs.get(`network.proxy.${protocol}`)).toBe("");
        expect(prefs.get(`network.proxy.${protocol}_port`)).toBe(0);
      }
      expect(prefs.get("network.proxy.socks")).toBe("managed-socks.example");
      expect(prefs.get("network.proxy.socks_port")).toBe(1080);
    }
    const state = JSON.parse(read(dir, stateName));
    expect(state.entries.find((entry: any) => entry.key === "network.proxy.http").prefs).toBe("personal.example");
    expect(state.entries.find((entry: any) => entry.key === "network.proxy.http_port").prefs).toBe(3128);
    // Gecko may omit the neutral endpoint defaults too, not just booleans.
    let omitted = read(dir, "prefs.js");
    for (const protocol of ["http", "ssl"]) omitted = omitted.replace(pref(`network.proxy.${protocol}`, ""), "").replace(pref(`network.proxy.${protocol}_port`, 0), "");
    seed(dir, "prefs.js", omitted);
    writeFirefoxUserJs(dir, { proxy: null });
    const released = prefMap(dir);
    expect(released.get("network.proxy.type")).toBe(0);
    for (const protocol of ["http", "ssl"]) {
      expect(released.get(`network.proxy.${protocol}`)).toBe("personal.example");
      expect(released.get(`network.proxy.${protocol}_port`)).toBe(3128);
    }
    expect(released.get("custom.keep")).toBe(9);
    expect(JSON.parse(read(dir, stateName)).entries.some((entry: any) => entry.key === "network.proxy.http")).toBe(false);
  });

  it("shields an already configured personal SOCKS proxy while managing HTTP", () => {
    const dir = profile();
    seed(dir, "user.js", pref("network.proxy.socks", "personal-socks.example") + pref("network.proxy.socks_port", 3128));
    seed(dir, "prefs.js", pref("network.proxy.socks", "saved-socks.example") + pref("network.proxy.socks_port", 3128));
    writeFirefoxUserJs(dir, { proxy: { type: "http", host: "managed-http.example", port: 8080 } });
    for (const file of ["user.js", "prefs.js"]) {
      expect(prefMap(dir, file).get("network.proxy.socks")).toBe("");
      expect(prefMap(dir, file).get("network.proxy.socks_port")).toBe(0);
    }
    writeFirefoxUserJs(dir, { proxy: null });
    expect(prefMap(dir, "user.js").get("network.proxy.socks")).toBe("personal-socks.example");
    expect(prefMap(dir).get("network.proxy.socks")).toBe("saved-socks.example");
  });

  it("restores and keeps the original baseline after Gecko omits a managed default value", () => {
    const dir = profile(); seed(dir, "prefs.js", pref("webgl.disabled", true) + pref("custom.keep", 42));
    for (let cycle = 0; cycle < 2; cycle++) {
      writeFirefoxUserJs(dir, { extraPrefs: { "webgl.disabled": false } });
      const saved = read(dir, "prefs.js").replace(pref("webgl.disabled", false), "");
      seed(dir, "prefs.js", saved); // Gecko drops false, the engine default, on save.
      expect(prefMap(dir).has("webgl.disabled")).toBe(false);
      writeFirefoxUserJs(dir, { fingerprintMode: "off" });
      expect(prefMap(dir).get("webgl.disabled")).toBe(true);
      expect(prefMap(dir).get("custom.keep")).toBe(42);
      expect(JSON.parse(read(dir, stateName)).entries.some((entry: any) => entry.key === "webgl.disabled")).toBe(false);
    }
  });

  it("preserves unrelated opaque byte strings and Latin1 comment bytes exactly", () => {
    const dir = profile();
    const user = Buffer.concat([Buffer.from("// user "), Buffer.from([0xa9]), Buffer.from('\nuser_pref("custom.opaque", "\\xFF");\n')]);
    const saved = Buffer.concat([Buffer.from("/* saved "), Buffer.from([0xa9]), Buffer.from(' */\nuser_pref("custom.raw", "'), Buffer.from([0xff]), Buffer.from('");\n')]);
    fs.writeFileSync(path.join(dir, "user.js"), user, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "prefs.js"), saved, { mode: 0o600 });
    writeFirefoxUserJs(dir, {});
    for (const [file, original] of [["user.js", user], ["prefs.js", saved]] as const) {
      const bytes = fs.readFileSync(path.join(dir, file));
      expect(bytes.subarray(0, original.length).equals(original)).toBe(true);
    }
    expect(new Map(parseFirefoxPrefs(fs.readFileSync(path.join(dir, "user.js"))).map(row => [row.key, row.value])).get("custom.opaque")).toEqual({ kind: "bytes", hex: "ff" });
    expect(new Map(parseFirefoxPrefs(fs.readFileSync(path.join(dir, "prefs.js"))).map(row => [row.key, row.value])).get("custom.raw")).toEqual({ kind: "bytes", hex: "ff" });
    const before = [fs.readFileSync(path.join(dir, "user.js")), fs.readFileSync(path.join(dir, "prefs.js"))];
    writeFirefoxUserJs(dir, {});
    expect(fs.readFileSync(path.join(dir, "user.js")).equals(before[0])).toBe(true);
    expect(fs.readFileSync(path.join(dir, "prefs.js")).equals(before[1])).toBe(true);
    expect(JSON.parse(read(dir, stateName)).entries.some((entry: any) => entry.key.startsWith("custom."))).toBe(false);
  });

  it("persists managed UTF-8 once and restores Unicode baselines without mojibake", () => {
    const dir = profile();
    seed(dir, "user.js", pref("general.useragent.override", "自用 UA 😀"));
    seed(dir, "prefs.js", pref("intl.locale.requested", "中文"));
    writeFirefoxUserJs(dir, { extraPrefs: identity, locale: "ja-JP", proxy: { type: "http", host: "proxy.example", port: 8080, username: "用户", password: "秘密😀" } });
    const bytes = fs.readFileSync(path.join(dir, "prefs.js"));
    expect(bytes.includes(Buffer.from("秘密😀", "utf8"))).toBe(true);
    expect(new Map(parseFirefoxPrefs(bytes).map(row => [row.key, row.value])).get("network.proxy.password")).toBe("秘密😀");
    expect(JSON.parse(read(dir, stateName)).entries.find((entry: any) => entry.key === "intl.locale.requested").prefs).toBe("中文");
    writeFirefoxUserJs(dir, { fingerprintMode: "off", proxy: null });
    expect(prefMap(dir).get("intl.locale.requested")).toBe("中文");
    expect(prefMap(dir, "user.js").get("general.useragent.override")).toBe("自用 UA 😀");
  });

  it("keeps different opaque keys distinct rather than merging UTF-8 replacements", () => {
    const dir = profile();
    const source = Buffer.from('user_pref("\\xFF", 1);\nuser_pref("\\xFE", 2);\nuser_pref("\\u00FF", 3);\n');
    fs.writeFileSync(path.join(dir, "prefs.js"), source, { mode: 0o600 });
    const parsed = parseFirefoxPrefs(source);
    expect(new Set(parsed.map(row => row.key)).size).toBe(3);
    expect(() => parseFirefoxPrefs('user_pref("\\xFF", 1); user_pref("\\xff", 2);')).toThrow(/ambiguous/i);
    writeFirefoxUserJs(dir, {});
    expect(fs.readFileSync(path.join(dir, "prefs.js")).subarray(0, source.length).equals(source)).toBe(true);
  });

  it("rolls back opaque string and Latin1 comment bytes without a lossy decode", () => {
    const dir = profile();
    const source = Buffer.concat([Buffer.from("// "), Buffer.from([0xa9]), Buffer.from('\nuser_pref("custom.raw", "'), Buffer.from([0xff]), Buffer.from('");\n')]);
    fs.writeFileSync(path.join(dir, "prefs.js"), source, { mode: 0o600 });
    writeFirefoxUserJs(dir, {});
    const before = ["user.js", "prefs.js", stateName].map(file => fs.readFileSync(path.join(dir, file)));
    const rename = fs.renameSync; let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++calls === 2) throw Object.assign(new Error("injected byte rollback failure"), { code: "EIO" });
      rename(from, to);
    });
    expect(() => writeFirefoxUserJs(dir, { locale: "en-US" })).toThrow(/injected byte/i);
    for (const [index, file] of ["user.js", "prefs.js", stateName].entries()) expect(fs.readFileSync(path.join(dir, file)).equals(before[index])).toBe(true);
  });

  it("records and restores an opaque byte baseline without converting ff to UTF-8 c3bf", () => {
    const dir = profile(); seed(dir, "prefs.js", 'user_pref("general.useragent.override", "\\xFF");\n');
    writeFirefoxUserJs(dir, { extraPrefs: identity });
    const entry = JSON.parse(read(dir, stateName)).entries.find((entry: any) => entry.key === "general.useragent.override");
    expect(entry.prefs).toEqual({ kind: "bytes", hex: "ff" });
    // The admitted original value may still be present; compare its byte
    // identity after re-reading JSON, not JavaScript object reference identity.
    seed(dir, "prefs.js", read(dir, "prefs.js").replace(pref("general.useragent.override", identity["general.useragent.override"]), 'user_pref("general.useragent.override", "\\xFF");\n'));
    writeFirefoxUserJs(dir, { extraPrefs: identity });
    writeFirefoxUserJs(dir, { fingerprintMode: "off" });
    expect(prefMap(dir).get("general.useragent.override")).toEqual({ kind: "bytes", hex: "ff" });
    expect(read(dir, "prefs.js")).toContain('"\\xff"');
  });
});

describe("Firefox prefs transaction failures", () => {
  const persisted = (dir: string) => [read(dir), read(dir, "prefs.js"), read(dir, stateName)];
  const ioError = () => Object.assign(new Error("injected I/O failure"), { code: "EIO" });
  function expectClean(dir: string): void {
    expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp") || name === lockName)).toEqual([]);
  }

  it.each([1, 2, 3])("rolls back an atomic rename failure at commit step %i", (failAt) => {
    const dir = profile(); writeFirefoxUserJs(dir, { extraPrefs: identity });
    const before = persisted(dir), rename = fs.renameSync; let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++calls === failAt) throw ioError();
      return rename(from, to);
    });
    expect(() => writeFirefoxUserJs(dir, { fingerprintMode: "off" })).toThrow(/I\/O/i);
    expect(persisted(dir)).toEqual(before); expectClean(dir);
  });

  it.each(["throw", "short-success"])("never publishes a partial staged write (%s)", (fault) => {
    const dir = profile(); writeFirefoxUserJs(dir, { extraPrefs: identity });
    const before = persisted(dir), write = fs.writeFileSync; let fdWrites = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: any[]) => {
      if (typeof args[0] === "number" && ++fdWrites === 2) {
        write(args[0], String(args[1]).slice(0, 9), args[2]);
        if (fault === "throw") throw ioError();
        return;
      }
      return Reflect.apply(write, fs, args);
    }) as typeof fs.writeFileSync);
    expect(() => writeFirefoxUserJs(dir, { fingerprintMode: "off" })).toThrow(/I\/O|staged/i);
    expect(persisted(dir)).toEqual(before); expectClean(dir);
  });

  it("does not publish files whose private permissions could not be set", () => {
    const dir = profile(); writeFirefoxUserJs(dir, {}); const before = persisted(dir);
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
    expect(() => writeFirefoxUserJs(dir, { locale: "en-US" })).toThrow(/permission/i);
    expect(persisted(dir)).toEqual(before); expectClean(dir);
  });

  it("aborts when fsync fails before any replacement", () => {
    const dir = profile(); writeFirefoxUserJs(dir, {}); const before = persisted(dir);
    const sync = fs.fsyncSync; let files = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isFile() && ++files === 2) throw ioError();
      sync(fd);
    });
    expect(() => writeFirefoxUserJs(dir, { locale: "en-US" })).toThrow(/I\/O/i);
    expect(persisted(dir)).toEqual(before); expectClean(dir);
  });

  it("preserves a concurrent user edit instead of overwriting or rolling it back", () => {
    const dir = profile(); writeFirefoxUserJs(dir, {});
    const before = persisted(dir), edit = before[0] + pref("custom.concurrent", true);
    const rename = fs.renameSync; let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++calls === 1) seed(dir, "user.js", edit);
      return rename(from, to);
    });
    expect(() => writeFirefoxUserJs(dir, { locale: "en-US" })).toThrow(/changed|concurrent/i);
    expect(read(dir)).toBe(edit); expect(read(dir, "prefs.js")).toBe(before[1]); expect(read(dir, stateName)).toBe(before[2]); expectClean(dir);
  });

  it("retains a blocking transaction marker when rollback cannot finish", () => {
    const dir = profile(); writeFirefoxUserJs(dir, {}); const rename = fs.renameSync; let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++calls >= 2) throw ioError();
      return rename(from, to);
    });
    expect(() => writeFirefoxUserJs(dir, { locale: "en-US" })).toThrow(/rollback was incomplete/i);
    expect(fs.existsSync(path.join(dir, lockName))).toBe(true);
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/transaction lock/i);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, lockName)).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite a post-commit external edit while trying to recover", () => {
    const dir = profile(); writeFirefoxUserJs(dir, {}); const rename = fs.renameSync; let calls = 0;
    const external = pref("custom.external", "must survive");
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const result = rename(from, to);
      if (++calls === 3) seed(dir, "prefs.js", external);
      return result;
    });
    expect(() => writeFirefoxUserJs(dir, { locale: "en-US" })).toThrow(/rollback was incomplete/i);
    expect(read(dir, "prefs.js")).toBe(external);
    expect(fs.existsSync(path.join(dir, lockName))).toBe(true);
    expect(() => writeFirefoxUserJs(dir, {})).toThrow(/transaction lock/i);
  });
});
