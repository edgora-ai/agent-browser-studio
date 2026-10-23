// Firefox prefs are data, not JavaScript. Only user_pref(string, scalar) and
// Gecko comments are accepted; no vm/eval/import of user.js or prefs.js.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { FingerprintMode, ProxyConfig } from "../types.js";

export type FirefoxPrefValue = string | number | boolean;
/** Gecko strings are byte sequences, not necessarily UTF-8. Only parsed
 * originals may carry opaque bytes; caller-supplied managed values stay scalar. */
export interface FirefoxPrefBytes { kind: "bytes"; hex: string }
export type FirefoxStoredPrefValue = FirefoxPrefValue | FirefoxPrefBytes;
/** Engine-level WebRTC routing, independent from identity prefs. */
export interface FirefoxWebRtcPrefs {
  forceProxy: boolean;
  obfuscateHostAddresses: boolean;
  disablePeerConnectionApi: boolean;
}
export interface FirefoxUserJsOpts {
  proxy?: ProxyConfig | null;
  dohUrl?: string | null;
  locale?: string | null;
  allowThirdPartyCookies?: boolean;
  /** Only the exact fingerprint-pref family produced by firefox-fingerprint.ts. */
  extraPrefs?: Record<string, FirefoxPrefValue> | null;
  /** Production launch always supplies the resolved policy; null keeps legacy defaults. */
  webrtcRouting?: FirefoxWebRtcPrefs | null;
  /** Whether a proxy route is configured; disambiguates "no proxy" from "real". */
  proxyRouting?: boolean;
  /** Explicit extra keys for isolated test/acceptance profiles. Not exposed by
   * product callers; still restricted to the exact types in TYPES. */
  testOnlyPrefs?: Record<string, FirefoxPrefValue> | null;
  /**
   * Policy lineage for the ICE prefs. A fresh request hash alone can disable
   * reuse indefinitely when the previous preference value was the opposite
   * routing boolean: after the launch, prefs.js holds exactly the new desired
   * value and the original user value is gone. The writer therefore persists a
   * hashed checkpoint of the keys it owns (see webrtcCheckpointHash) so a new
   * requested policy can be compared with what was actually applied.
   */
  webrtcCheckpointHash?: string | null;
  fingerprintMode?: FingerprintMode;
  useGpu?: boolean;
  /** true/omitted leaves Gecko's sandbox default alone; false is unsupported. */
  sandboxPermission?: boolean;
  colorScheme?: "system" | "dark" | "light";
}
export interface FirefoxUserJsWriteResult {
  managedKeys: string[];
  releasedKeys: string[];
  migratedLegacy: boolean;
  /** The old writer overwrote user.js: earlier user values cannot be recovered. */
  legacyBaselineUnavailable: string[];
}
export class FirefoxPrefsError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FirefoxPrefsError";
  }
}
function refuse(code: string, message: string): never { throw new FirefoxPrefsError(code, message); }

// Keep this allowlist aligned with buildFirefox{Native,}FingerprintPrefs, not
// approximate prefixes. In particular, the native key ends in ".config".
const FINGERPRINT_TYPES = {
  "general.useragent.override": "string",
  "general.useragent.site_specific_overrides": "boolean",
  "dom.maxHardwareConcurrency": "number",
  "intl.accept_languages": "string",
  "webgl.disabled": "boolean",
  "webgl.override-unmasked-vendor": "string",
  "webgl.override-unmasked-renderer": "string",
  "privacy.donottrackheader.enabled": "boolean",
  "privacy.donottrackheader.value": "number",
  "media.peerconnection.ice.obfuscate_host_addresses": "boolean",
  "media.peerconnection.ice.proxy_only": "boolean",
  "agent.browser.fingerprint.config": "string",
} as const;
export const FIREFOX_FINGERPRINT_PREF_KEYS: readonly string[] = Object.freeze(Object.keys(FINGERPRINT_TYPES));
const TYPES: Record<string, "string" | "boolean" | "number"> = {
  ...FINGERPRINT_TYPES,
  "focusmanager.testmode": "boolean", "layout.testing.top-level-always-active": "boolean",
  "dom.min_background_timeout_value": "number", "dom.min_background_timeout_value_without_budget_throttling": "number",
  "dom.timeout.enable_budget_timer_throttling": "boolean", "browser.startup.homepage": "string",
  "browser.newtabpage.enabled": "boolean", "layers.acceleration.disabled": "boolean", "gfx.webrender.disabled": "boolean",
  "layout.css.prefers-color-scheme.content-override": "number", "ui.systemUsesDarkTheme": "boolean", "extensions.activeThemeID": "string",
  "network.cookie.cookieBehavior": "number", "network.proxy.type": "number",
  "network.proxy.http": "string", "network.proxy.http_port": "number", "network.proxy.ssl": "string", "network.proxy.ssl_port": "number",
  "network.proxy.socks": "string", "network.proxy.socks_port": "number", "network.proxy.socks_version": "number",
  "network.proxy.socks_remote_dns": "boolean", "network.proxy.no_proxies_on": "string",
  "network.proxy.username": "string", "network.proxy.password": "string",
  "media.peerconnection.enabled": "boolean",
  "network.proxy.allow_hijacking_localhost": "boolean", "media.peerconnection.ice.loopback": "boolean",
  "places.history.enabled": "boolean", "toolkit.telemetry.enabled": "boolean",
  "datareporting.healthreport.uploadEnabled": "boolean", "browser.safebrowsing.enabled": "boolean",
  "network.trr.mode": "number", "network.trr.uri": "string", "intl.locale.requested": "string",
  "app.update.auto": "boolean", "browser.shell.checkDefaultBrowser": "boolean", "browser.startup.page": "number",
};
const SANDBOX = "security.sandbox.content.level";
const LEGACY_HEADER = "// Agent Browser Studio managed Firefox preferences (RoxyFirefox-aligned, regenerated at launch).\n";
const HEADER = "// Agent Browser Studio managed Firefox preferences (owned keys; regenerated at launch).\n";
const BEGIN = "// BEGIN Agent Browser Studio managed Firefox preferences v1\n";
const END = "// END Agent Browser Studio managed Firefox preferences v1\n";
const MAX_BYTES = 8 * 1024 * 1024;
// Preserve U+FEFF in values/bytes; only the parser may skip one file-leading
// BOM, matching Gecko's parser (never strip a BOM from a preference value).
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sorted = <T>(map: ReadonlyMap<string, T>): [string, T][] => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
// Internal file text is a lossless one-code-unit-per-byte carrier. Never decode
// entire prefs files as UTF-8: Gecko accepts arbitrary comment/string bytes.
const utf8Bytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
function decodedString(bytes: Buffer): string | FirefoxPrefBytes {
  try { return decoder.decode(bytes); } catch { return { kind: "bytes", hex: bytes.toString("hex") }; }
}
function equalValue(a: FirefoxStoredPrefValue | null | undefined, b: FirefoxStoredPrefValue | null | undefined): boolean {
  return a === b || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && a.hex === b.hex);
}

function validString(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return Buffer.byteLength(value) <= MAX_BYTES;
}
function scalar(value: unknown): value is FirefoxPrefValue {
  return typeof value === "boolean" || (typeof value === "string" && validString(value)) ||
    (typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647);
}
function storedValue(value: unknown): value is FirefoxStoredPrefValue {
  if (scalar(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as FirefoxPrefBytes;
  if (Object.keys(value).sort().join(",") !== "hex,kind" || candidate.kind !== "bytes" || typeof candidate.hex !== "string" ||
      candidate.hex.length > MAX_BYTES * 2 || !/^(?:[0-9a-f]{2})+$/.test(candidate.hex)) return false;
  const bytes = Buffer.from(candidate.hex, "hex");
  // NUL is disallowed by Gecko, and UTF-8 originals have a scalar canonical
  // representation. This tag is only for genuinely opaque byte strings.
  return !bytes.includes(0) && typeof decodedString(bytes) !== "string";
}
function geckoString(value: string): string {
  // JSON's \t/\b/\f escapes are NOT in Gecko's prefs grammar.
  return '"' + value.replace(/["\\\p{Cc}\p{Zl}\p{Zp}]/gu, c => {
    if (c === '"' || c === "\\") return "\\" + c;
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  }) + '"';
}
function statement(key: string, value: FirefoxStoredPrefValue): string {
  const encoded = typeof value === "string" ? geckoString(value) : typeof value === "object"
    ? '"' + value.hex.replace(/../g, byte => "\\x" + byte) + '"' : String(value);
  return `user_pref(${geckoString(key)}, ${encoded});\n`;
}
function serialize(prefs: ReadonlyMap<string, FirefoxStoredPrefValue>): string { return sorted(prefs).map(([k, v]) => statement(k, v)).join(""); }
function put(prefs: Map<string, FirefoxPrefValue>, key: string, value: unknown): void {
  if (!Object.hasOwn(TYPES, key) || !scalar(value) || typeof value !== TYPES[key]) {
    refuse("FIREFOX_PREFS_INVALID_INPUT", `Invalid or unsupported Firefox preference ${JSON.stringify(key)}.`);
  }
  prefs.set(key, value);
}
function managedPrefs(opts: FirefoxUserJsOpts): Map<string, FirefoxPrefValue> {
  if (!opts || typeof opts !== "object") refuse("FIREFOX_PREFS_INVALID_INPUT", "Firefox preference options must be an object.");
  if (opts.fingerprintMode !== undefined && opts.fingerprintMode !== "managed" && opts.fingerprintMode !== "off") {
    refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox fingerprintMode.");
  }
  for (const key of ["useGpu", "sandboxPermission", "allowThirdPartyCookies"] as const) {
    if (opts[key] !== undefined && typeof opts[key] !== "boolean") refuse("FIREFOX_PREFS_INVALID_INPUT", `Invalid Firefox ${key}.`);
  }
  if (opts.sandboxPermission === false) refuse("FIREFOX_SANDBOX_DISABLE_UNSUPPORTED", "Disabling the Firefox content sandbox is unsupported; keep sandboxPermission true or omitted.");
  const prefs = new Map<string, FirefoxPrefValue>();
  if (opts.extraPrefs != null) {
    if (typeof opts.extraPrefs !== "object" || Array.isArray(opts.extraPrefs)) refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox extraPrefs.");
    for (const [key, value] of Object.entries(opts.extraPrefs)) {
      if (opts.fingerprintMode === "off" || !Object.hasOwn(FINGERPRINT_TYPES, key)) refuse("FIREFOX_PREFS_INVALID_INPUT", `Fingerprint preference is out of scope: ${JSON.stringify(key)}.`);
      put(prefs, key, value);
    }
  }
  // Routing is not identity. It applies in off mode too, and overrides the
  // historical identity defaults (both true) when the user chose Real/Disabled.
  // When routing removes a key that an earlier launch owned, prefs.js must be
  // scrubbed explicitly; ownership of those legacy keys comes from prior state
  // entries, so no permanent "delete marker" is written here.
  if (opts.webrtcRouting != null) {
    const routing = opts.webrtcRouting;
    if (typeof routing !== "object" || Array.isArray(routing)
        || typeof routing.forceProxy !== "boolean" || typeof routing.obfuscateHostAddresses !== "boolean"
        || typeof routing.disablePeerConnectionApi !== "boolean") refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox WebRTC routing preferences.");
    if (typeof opts.proxyRouting !== "boolean") refuse("FIREFOX_PREFS_INVALID_INPUT", "Firefox WebRTC routing requires an explicit proxy state.");
    if (opts.webrtcCheckpointHash != null && !/^[a-f0-9]{64}$/.test(opts.webrtcCheckpointHash)) refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox WebRTC routing checkpoint.");
    if (routing.disablePeerConnectionApi) {
      prefs.delete("media.peerconnection.ice.obfuscate_host_addresses");
      prefs.delete("media.peerconnection.ice.proxy_only");
      put(prefs, "media.peerconnection.enabled", false);
    } else if (routing.forceProxy) {
      prefs.delete("media.peerconnection.enabled");
      put(prefs, "media.peerconnection.ice.obfuscate_host_addresses", routing.obfuscateHostAddresses);
      put(prefs, "media.peerconnection.ice.proxy_only", true);
    } else {
      // Explicit Real: native routing, so no managed ICE routing/obfuscation.
      // Without a proxy, write the routing keys false instead of deleting, so
      // a previous owned True can be retired from prefs.js on this write.
      prefs.delete("media.peerconnection.enabled");
      if (opts.proxyRouting) {
        prefs.delete("media.peerconnection.ice.obfuscate_host_addresses");
        prefs.delete("media.peerconnection.ice.proxy_only");
      } else {
        put(prefs, "media.peerconnection.ice.obfuscate_host_addresses", false);
        put(prefs, "media.peerconnection.ice.proxy_only", false);
      }
    }
    // Record what was actually applied, not just what was requested. Store a
    // one-way digest so user/original preference values never leak from state.
    if (opts.webrtcCheckpointHash) {
      const applied = JSON.stringify({
        v: 1, enabled: prefs.get("media.peerconnection.enabled") ?? null,
        proxyOnly: prefs.get("media.peerconnection.ice.proxy_only") ?? null,
        obfuscate: prefs.get("media.peerconnection.ice.obfuscate_host_addresses") ?? null,
      });
      if (createHash("sha256").update(applied).digest("hex") !== opts.webrtcCheckpointHash) {
        refuse("FIREFOX_PREFS_INVALID_INPUT", "Firefox WebRTC routing checkpoint does not match the applied preferences.");
      }
    }
  }
  const base = {
    "focusmanager.testmode": true, "layout.testing.top-level-always-active": true,
    "dom.min_background_timeout_value": 0, "dom.min_background_timeout_value_without_budget_throttling": 0,
    "dom.timeout.enable_budget_timer_throttling": false, "browser.startup.homepage": "about:home", "browser.newtabpage.enabled": true,
    "layers.acceleration.disabled": !opts.useGpu, "gfx.webrender.disabled": !opts.useGpu,
    "app.update.auto": false, "browser.shell.checkDefaultBrowser": false, "browser.startup.page": 0,
  };
  for (const [k, v] of Object.entries(base)) put(prefs, k, v);
  // Do not pin a platform-specific sandbox level. Gecko 154 defaults: macOS 3,
  // Windows 9, Linux 6; GetEffectiveContentSandboxLevel may clamp 0, not restore
  // the default. Only attributable legacy 0/-1 overrides are removed below.
  if (opts.allowThirdPartyCookies === true) put(prefs, "network.cookie.cookieBehavior", 0);
  const scheme = opts.colorScheme ?? "system";
  if (!["system", "dark", "light"].includes(scheme)) refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox colorScheme.");
  put(prefs, "layout.css.prefers-color-scheme.content-override", scheme === "system" ? 2 : scheme === "dark" ? 0 : 1);
  if (scheme !== "system") put(prefs, "ui.systemUsesDarkTheme", scheme === "dark");
  put(prefs, "extensions.activeThemeID", scheme === "system" ? "default-theme@mozilla.org" : `firefox-compact-${scheme}@mozilla.org`);
  const proxy = opts.proxy;
  put(prefs, "network.proxy.type", proxy == null ? 0 : 1);
  if (proxy != null) {
    if (!["http", "socks5", "socks5h"].includes(proxy.type) || typeof proxy.host !== "string" || !proxy.host ||
        !validString(proxy.host) || /[\s\\/"'`;()#?@]/.test(proxy.host) ||
        !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox proxy type, host or port.");
    try {
      const host = proxy.host.includes(":") && !proxy.host.startsWith("[") ? `[${proxy.host}]` : proxy.host;
      if (!new URL(`http://${host}:${proxy.port}`).hostname) throw new Error("host");
    } catch { refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox proxy host."); }
    // A manual proxy is one ownership group. Gecko checks usable HTTP/SSL
    // fields before falling back to SOCKS (and flags can prefer SOCKS), so
    // merely restoring/removing the other protocol's host is not isolation.
    // Hold every baseline until proxy=null; explicitly neutralize inactive
    // endpoints, bypasses and credentials while any managed proxy is active.
    const proxyDefaults = {
      "network.proxy.http": "", "network.proxy.http_port": 0,
      "network.proxy.ssl": "", "network.proxy.ssl_port": 0,
      "network.proxy.socks": "", "network.proxy.socks_port": 0,
      "network.proxy.socks_version": 5, "network.proxy.socks_remote_dns": false,
      // Existing product loopback bypass policy, not a deployment address.
      "network.proxy.no_proxies_on": "localhost, 127.0.0.1, ::1",
      "network.proxy.username": "", "network.proxy.password": "",
    };
    for (const [key, value] of Object.entries(proxyDefaults)) put(prefs, key, value);
    if (proxy.type === "http") {
      for (const type of ["http", "ssl"]) { put(prefs, `network.proxy.${type}`, proxy.host); put(prefs, `network.proxy.${type}_port`, proxy.port); }
    } else {
      put(prefs, "network.proxy.socks", proxy.host); put(prefs, "network.proxy.socks_port", proxy.port);
      put(prefs, "network.proxy.socks_remote_dns", true);
    }
    for (const field of ["username", "password"] as const) {
      if (proxy[field] !== undefined && (typeof proxy[field] !== "string" || !validString(proxy[field]))) refuse("FIREFOX_PREFS_INVALID_INPUT", `Invalid Firefox proxy ${field}.`);
    }
    if (proxy.username || proxy.password) { put(prefs, "network.proxy.username", proxy.username || ""); put(prefs, "network.proxy.password", proxy.password || ""); }
  }
  if (opts.dohUrl != null && opts.dohUrl !== "") {
    if (typeof opts.dohUrl !== "string" || !validString(opts.dohUrl) || /[\x00-\x20\x7f]/.test(opts.dohUrl)) refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox DoH URL.");
    let url: URL;
    try { url = new URL(opts.dohUrl); } catch { refuse("FIREFOX_PREFS_INVALID_INPUT", "Invalid Firefox DoH URL."); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) refuse("FIREFOX_PREFS_INVALID_INPUT", "Firefox DoH requires an HTTPS endpoint without userinfo or fragment.");
    put(prefs, "network.trr.mode", 3); put(prefs, "network.trr.uri", opts.dohUrl);
  } else put(prefs, "network.trr.mode", 5);
  if (opts.locale != null && opts.locale !== "") put(prefs, "intl.locale.requested", opts.locale);
  // Applied last: isolated test profiles may need to override a managed default
  // such as the loopback proxy bypass. Product callers never pass this field.
  for (const [key, value] of Object.entries(opts.testOnlyPrefs ?? {})) put(prefs, key, value);
  return prefs;
}
export function buildFirefoxUserJs(opts: FirefoxUserJsOpts): string { return HEADER + serialize(managedPrefs(opts)); }

export interface FirefoxPrefStatement { key: string; value: FirefoxStoredPrefValue; start: number; end: number }
/** Data-only Gecko grammar. Offsets address original bytes. Opaque key identities
 * use a NUL-prefixed internal marker (NUL cannot be a real Gecko key), so they
 * cannot alias a managed ASCII key or a different lossy UTF-8 replacement. */
function parseBytes(text: string, label = "Firefox prefs"): FirefoxPrefStatement[] {
  let i = text.startsWith("\xef\xbb\xbf") ? 3 : 0;
  const bad = (): never => refuse("FIREFOX_PREFS_SYNTAX", `Malformed or ambiguous ${label} at offset ${i}; files were not executed.`);
  if (text.length > MAX_BYTES || text.includes("\0")) bad();
  function skip(): void {
    for (;;) {
      while (/[\t\v\f \r\n]/.test(text[i] ?? "!") && i < text.length) i++;
      if (text[i] === "#" || text.startsWith("//", i)) { while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++; }
      else if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); if (end < 0) bad(); i = end + 2; }
      else return;
    }
  }
  function take(token: string): void { skip(); if (!text.startsWith(token, i)) bad(); i += token.length; }
  function string(): string | FirefoxPrefBytes {
    skip(); const quote = text[i++]; if (quote !== '"' && quote !== "'") bad();
    const chunks: Buffer[] = []; let rawStart = i;
    while (i < text.length) {
      const c = text[i++];
      if (c === quote || c === "\\") {
        chunks.push(Buffer.from(text.slice(rawStart, i - 1), "latin1"));
        if (c === quote) return decodedString(Buffer.concat(chunks));
        const escape = text[i++];
        if (["'", '"', "\\", "n", "r"].includes(escape)) chunks.push(Buffer.from(escape === "n" ? "\n" : escape === "r" ? "\r" : escape));
        else if (escape === "x" || escape === "u") {
          const length = escape === "x" ? 2 : 4; const hex = text.slice(i, i + length);
          if (hex.length !== length || !/^[\da-f]+$/i.test(hex)) bad(); i += length;
          const code = parseInt(hex, 16); if (code === 0) bad();
          if (escape === "x") chunks.push(Buffer.from([code]));
          else if (code >= 0xd800 && code <= 0xdbff) {
            if (!text.startsWith("\\u", i) || !/^[\da-f]{4}$/i.test(text.slice(i + 2, i + 6))) bad();
            const low = parseInt(text.slice(i + 2, i + 6), 16); if (low < 0xdc00 || low > 0xdfff) bad(); i += 6;
            chunks.push(Buffer.from(String.fromCharCode(code, low)));
          } else { if (code >= 0xdc00 && code <= 0xdfff) bad(); chunks.push(Buffer.from(String.fromCharCode(code))); }
        } else bad();
        rawStart = i;
      }
    }
    return bad();
  }
  const statements: FirefoxPrefStatement[] = []; const keys = new Set<string>();
  skip();
  while (i < text.length) {
    const start = i; take("user_pref"); take("("); const name = string(); take(","); skip();
    const key = typeof name === "string" ? name : `\0bytes:${name.hex}`;
    let value: FirefoxStoredPrefValue;
    if (text[i] === '"' || text[i] === "'") value = string();
    else if (text.startsWith("true", i)) { value = true; i += 4; }
    else if (text.startsWith("false", i)) { value = false; i += 5; }
    else {
      const sign = text[i] === "-" || text[i] === "+" ? text[i++] : ""; skip();
      const digits = /^[0-9]+/.exec(text.slice(i))?.[0] ?? bad(); i += digits.length;
      value = Number(sign + digits); if (!scalar(value)) bad();
    }
    take(")"); take(";");
    if (keys.has(key)) bad(); keys.add(key); statements.push({ key, value, start, end: i }); skip();
  }
  return statements;
}
/** Strings are UTF-8 source text; Buffer inputs preserve literal byte values
 * and non-UTF-8 comments. No decoding policy is guessed for whole files. */
export function parseFirefoxPrefs(input: string | Buffer, label = "Firefox prefs"): FirefoxPrefStatement[] {
  if (typeof input === "string" && !validString(input)) refuse("FIREFOX_PREFS_SYNTAX", `Malformed ${label}; files were not executed.`);
  return parseBytes(typeof input === "string" ? utf8Bytes(input) : input.toString("latin1"), label);
}
const values = (rows: FirefoxPrefStatement[]) => new Map(rows.map(row => [row.key, row.value]));
function remove(text: string, rows: FirefoxPrefStatement[], keys: Set<string>): string {
  let result = "", cursor = 0;
  for (const row of rows) {
    if (!keys.has(row.key)) continue;
    let start = row.start, end = row.end;
    const lineStart = Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("\r", start - 1)) + 1;
    const tail = /^[\t ]*(?:\r\n|\r|\n|$)/.exec(text.slice(end));
    if (/^[\t ]*$/.test(text.slice(lineStart, start)) && tail) { start = lineStart; end += tail[0].length; }
    result += text.slice(cursor, start); cursor = end;
  }
  return result + text.slice(cursor);
}
function append(text: string, addition: string): string { return text + (text && !/[\r\n]$/.test(text) ? "\n" : "") + addition; }
function block(prefs: Map<string, FirefoxPrefValue>): string { return BEGIN + HEADER + serialize(prefs) + END; }
interface Owned { key: string; value: FirefoxPrefValue; user: FirefoxStoredPrefValue | null; prefs: FirefoxStoredPrefValue | null }
interface State { version: 1; file: string; entries: Owned[] }
function stateText(state: State): string { return JSON.stringify(state) + "\n"; }
function readState(text: string, file: string): State {
  try {
    const parsed = JSON.parse(decoder.decode(Buffer.from(text, "latin1")));
    if (parsed.version !== 1 || parsed.file !== file || !Array.isArray(parsed.entries) || parsed.entries.length > Object.keys(TYPES).length) throw new Error("schema");
    let previous = "";
    const entries: Owned[] = parsed.entries.map((entry: Owned) => {
      if (!entry || !Object.hasOwn(TYPES, entry.key) || entry.key <= previous || !scalar(entry.value) || typeof entry.value !== TYPES[entry.key] ||
          (entry.user !== null && !storedValue(entry.user)) || (entry.prefs !== null && !storedValue(entry.prefs))) throw new Error("entry");
      previous = entry.key;
      return { key: entry.key, value: entry.value, user: entry.user, prefs: entry.prefs };
    });
    const state: State = { version: 1, file, entries };
    // Canonical bytes reject duplicate JSON members, unexpected fields, and
    // manual partial edits; the state itself is never an arbitrary key oracle.
    if (utf8Bytes(stateText(state)) !== text) throw new Error("canonical");
    return state;
  } catch { refuse("FIREFOX_PREFS_STATE_INVALID", "Invalid Firefox prefs ownership state; preserve it and reconcile the stopped profile before retrying."); }
}
function legacyEntries(text: string, rows: FirefoxPrefStatement[]): Owned[] {
  const bad = (): never => refuse("FIREFOX_PREFS_OWNERSHIP_AMBIGUOUS", "Legacy Firefox user.js is not complete, unmodified program output; ownership cannot be inferred.");
  const prefs = new Map<string, FirefoxPrefValue>(rows.map(row => {
    if (!scalar(row.value)) bad();
    return [row.key, row.value as FirefoxPrefValue];
  }));
  if (text !== utf8Bytes(LEGACY_HEADER + rows.map(row => `user_pref(${JSON.stringify(row.key)}, ${JSON.stringify(row.value)});\n`).join(""))) bad();
  if (![0, -1].includes(prefs.get(SANDBOX) as number)) bad();
  const extras = Object.fromEntries([...prefs].filter(([key]) => Object.hasOwn(FINGERPRINT_TYPES, key)));
  // Historical output always carried both ICE keys true; explicit Real may
  // legitimately contain false, so require presence, not a fixed value.
  const legacyIdentityKeys = ["general.useragent.override", "general.useragent.site_specific_overrides", "dom.maxHardwareConcurrency", "intl.accept_languages", "webgl.disabled", "media.peerconnection.ice.obfuscate_host_addresses", "media.peerconnection.ice.proxy_only"];
  if (Object.keys(extras).length && legacyIdentityKeys.some(key => !Object.hasOwn(extras, key))) bad();
  if (Object.hasOwn(extras, "privacy.donottrackheader.enabled") !== Object.hasOwn(extras, "privacy.donottrackheader.value")) bad();
  const fixedFingerprintValues = {
    "general.useragent.site_specific_overrides": false, "webgl.disabled": false,
    "privacy.donottrackheader.enabled": true, "privacy.donottrackheader.value": 1,
  };
  if (Object.entries(fixedFingerprintValues).some(([key, value]) => Object.hasOwn(extras, key) && extras[key] !== value)) bad();
  if (Object.hasOwn(extras, "dom.maxHardwareConcurrency") && !(typeof extras["dom.maxHardwareConcurrency"] === "number" && extras["dom.maxHardwareConcurrency"] > 0)) bad();
  let proxy: ProxyConfig | undefined;
  if (prefs.get("network.proxy.type") === 1) {
    const type = prefs.has("network.proxy.http") ? "http" : "socks5";
    proxy = { type, host: prefs.get(`network.proxy.${type === "http" ? "http" : "socks"}`) as string, port: prefs.get(`network.proxy.${type === "http" ? "http" : "socks"}_port`) as number };
    if (prefs.has("network.proxy.username")) { proxy.username = prefs.get("network.proxy.username") as string; proxy.password = prefs.get("network.proxy.password") as string; }
  }
  let expected: Map<string, FirefoxPrefValue>;
  try {
    const scheme = prefs.get("layout.css.prefers-color-scheme.content-override");
    expected = managedPrefs({ extraPrefs: extras, proxy, dohUrl: prefs.get("network.trr.uri") as string | undefined,
      locale: prefs.get("intl.locale.requested") as string | undefined, useGpu: prefs.get("layers.acceleration.disabled") === false,
      colorScheme: scheme === 2 ? "system" : scheme === 0 ? "dark" : "light", allowThirdPartyCookies: prefs.has("network.cookie.cookieBehavior") });
  } catch { return bad(); }
  // The historical generator did not shield inactive protocols or emit
  // empty credentials. Recognize only the fields that old code actually wrote.
  const legacyProxyKeys = new Set(proxy?.type === "http"
    ? ["network.proxy.http", "network.proxy.http_port", "network.proxy.ssl", "network.proxy.ssl_port", "network.proxy.no_proxies_on"]
    : ["network.proxy.socks", "network.proxy.socks_port", "network.proxy.socks_remote_dns"]);
  legacyProxyKeys.add("network.proxy.type");
  if (proxy?.username || proxy?.password) { legacyProxyKeys.add("network.proxy.username"); legacyProxyKeys.add("network.proxy.password"); }
  for (const key of expected.keys()) if (key.startsWith("network.proxy.") && !legacyProxyKeys.has(key)) expected.delete(key);
  expected.set(SANDBOX, prefs.get(SANDBOX)!);
  if (expected.size !== prefs.size || [...expected].some(([key, value]) => prefs.get(key) !== value)) bad();
  return [...prefs].map(([key, value]) => ({ key, value, user: null, prefs: null }));
}

interface Snapshot { name: string; text: string | null; stat: fs.Stats | null }
function lstat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function same(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink; }
function directory(dir: string, create: boolean): fs.Stats {
  const absolute = path.resolve(dir); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stat = lstat(current);
    if (!stat && create) { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) refuse("FIREFOX_PREFS_UNSAFE_PATH", "Firefox profile path must contain only real directories, not symlinks.");
  }
  return fs.lstatSync(absolute);
}
function snapshot(dir: string, name: string): Snapshot {
  const file = path.join(dir, name); const stat = lstat(file);
  if (!stat) return { name, text: null, stat: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) refuse("FIREFOX_PREFS_UNSAFE_PATH", `${name} must be a bounded regular file without symlinks or hardlinks.`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(stat, fs.fstatSync(fd))) refuse("FIREFOX_PREFS_CHANGED", `${name} changed while opening it.`);
    // Bound the read itself, not just a post-read size check on a growing file.
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) { const n = fs.readSync(fd, buffer, count, buffer.length - count, null); if (n === 0) break; count += n; }
    if (count !== stat.size || !same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(file))) refuse("FIREFOX_PREFS_CHANGED", `${name} changed while reading it.`);
    return { name, text: buffer.subarray(0, count).toString("latin1"), stat };
  } finally { fs.closeSync(fd); }
}
function unchanged(dir: string, original: Snapshot): void {
  const current = snapshot(dir, original.name);
  if (current.text !== original.text || (!!current.stat !== !!original.stat) || (current.stat && original.stat && !same(current.stat, original.stat))) refuse("FIREFOX_PREFS_CHANGED", `${original.name} changed during the prefs transaction; stop concurrent writers.`);
}
function syncDir(dir: string): void {
  // Windows Node cannot open directory handles for fsync. File fsync and rename
  // still apply; this is not a claim of a power-loss-atomic multi-file commit.
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function stage(dir: string, name: string, text: string, temps: Set<string>): string {
  if (text.length > MAX_BYTES) refuse("FIREFOX_PREFS_TOO_LARGE", "Firefox prefs transaction exceeds its file size limit.");
  const temp = `.agent-browser-firefox-${randomUUID()}.tmp`;
  const fd = fs.openSync(path.join(dir, temp), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  temps.add(temp);
  try { fs.writeFileSync(fd, text, "latin1"); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const written = snapshot(dir, temp);
  if (written.text !== text || (process.platform !== "win32" && (written.stat!.mode & 0o777) !== 0o600)) refuse("FIREFOX_PREFS_WRITE_FAILED", `Could not verify staged ${name}.`);
  return temp;
}

/** Caller must hold the launch lock and use a stopped profile. The separate
 * exclusive transaction lock is never stale-broken: interruption or failed
 * rollback must be reconciled explicitly, not mistaken for a completed save.
 * Originals remain in memory for rollback; staged files are 0600 and renamed,
 * never truncated in place. Unknown/unrelated prefs retain their exact bytes. */
export function writeFirefoxUserJs(profileDir: string, opts: FirefoxUserJsOpts, file = "user.js"): FirefoxUserJsWriteResult {
  const desired = managedPrefs(opts); // validation precedes mkdir/any writes
  if (typeof profileDir !== "string" || !path.isAbsolute(profileDir) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(file) || file === "prefs.js" || file.length > 100) refuse("FIREFOX_PREFS_UNSAFE_PATH", "Firefox prefs require an absolute profile path and a simple user.js filename.");
  const dir = path.resolve(profileDir); const root = directory(dir, true);
  const assertDirectory = (): void => {
    const now = directory(dir, false);
    if (root.dev !== now.dev || root.ino !== now.ino || root.mode !== now.mode) refuse("FIREFOX_PREFS_CHANGED", "Firefox profile directory changed during the transaction.");
  };
  // One owner/lock per profile, including custom filenames: two independent
  // records must never claim the same persisted prefs.js keys.
  const stateName = ".agent-browser-firefox-prefs.json", lockName = ".agent-browser-firefox-prefs.lock";
  let lockFd: number;
  try { lockFd = fs.openSync(path.join(dir, lockName), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("FIREFOX_PREFS_TRANSACTION_INCOMPLETE", "Firefox prefs transaction lock exists; another writer or interrupted transaction needs reconciliation."); throw error; }
  const lockStat = fs.fstatSync(lockFd); const temps = new Set<string>();
  const committed: { original: Snapshot; next: string }[] = []; let retainLock = false;
  try {
    fs.writeFileSync(lockFd, '{"version":1,"operation":"firefox-prefs"}\n', "utf8"); fs.fsyncSync(lockFd); syncDir(dir);
    const user = snapshot(dir, file), saved = snapshot(dir, "prefs.js"), ownership = snapshot(dir, stateName);
    const userRows = parseBytes(user.text ?? "", file), savedRows = parseBytes(saved.text ?? "", "prefs.js");
    let external = user.text ?? "", previous: Owned[] = [], migratedLegacy = false;
    if (ownership.text !== null) {
      const state = readState(ownership.text, file); previous = state.entries;
      const expected = utf8Bytes(block(new Map(previous.map(entry => [entry.key, entry.value]))));
      const start = external.indexOf(BEGIN), end = external.indexOf(END);
      if (start < 0 || end < start || external.indexOf(BEGIN, start + 1) !== -1 || external.indexOf(END, end + 1) !== -1 || external.slice(start, end + END.length) !== expected) refuse("FIREFOX_PREFS_STATE_INVALID", "Firefox user.js managed block differs from its ownership state; reconcile changes before retrying.");
      external = external.slice(0, start) + external.slice(end + END.length);
    } else if (external.includes(BEGIN) || external.includes(END)) refuse("FIREFOX_PREFS_STATE_INVALID", "Firefox user.js has a managed block but its ownership state is missing.");
    else if (external.includes(LEGACY_HEADER.trimEnd())) {
      previous = legacyEntries(external, userRows); migratedLegacy = true; external = "";
      const owned = new Set(previous.map(entry => entry.key));
      if (savedRows.some(row => (Object.hasOwn(TYPES, row.key) || row.key === SANDBOX) && !owned.has(row.key))) refuse("FIREFOX_PREFS_OWNERSHIP_AMBIGUOUS", "Legacy prefs.js contains managed-family keys absent from legacy user.js; older ownership/baselines cannot be recovered safely.");
    }
    const externalRows = parseBytes(external, "user.js user settings"), externalValues = values(externalRows), savedValues = values(savedRows);
    const old = new Map(previous.map(entry => [entry.key, entry]));
    for (const entry of previous) {
      if (externalValues.has(entry.key)) refuse("FIREFOX_PREFS_STATE_INVALID", `User settings conflict with owned preference ${entry.key}.`);
      const value = savedValues.get(entry.key);
      if (value !== undefined && !equalValue(value, entry.value) && !equalValue(value, entry.prefs)) refuse("FIREFOX_PREFS_OWNERSHIP_AMBIGUOUS", `Persisted preference ${entry.key} changed outside its ownership record; preserve and reconcile it.`);
    }
    const changes = new Map<string, FirefoxStoredPrefValue | null>(), restoreUser = new Map<string, FirefoxStoredPrefValue>();
    for (const entry of previous) {
      if (!desired.has(entry.key)) {
        // A missing owned key is already an admitted state: Gecko omits
        // non-sticky values equal to its defaults when saving prefs.js.
        // Restore the baseline before retiring ownership in that state too.
        if (!savedValues.has(entry.key) || equalValue(savedValues.get(entry.key), entry.value)) changes.set(entry.key, entry.prefs);
        if (entry.user !== null) restoreUser.set(entry.key, entry.user);
      }
    }
    const entries: Owned[] = sorted(desired).map(([key, value]) => {
      changes.set(key, value);
      const original = old.get(key);
      // null is an observed absence, not a missing record. Never re-adopt our
      // own last persisted value as the user's original on a later launch.
      return { key, value, user: original ? original.user : externalValues.get(key) ?? null, prefs: original ? original.prefs : savedValues.get(key) ?? null };
    });
    const nextUser = append(append(remove(external, externalRows, new Set(desired.keys())), utf8Bytes(serialize(restoreUser))), utf8Bytes(block(desired)));
    const nextSaved = append(remove(saved.text ?? "", savedRows, new Set(changes.keys())), utf8Bytes(serialize(new Map([...changes].filter((row): row is [string, FirefoxStoredPrefValue] => row[1] !== null)))));
    for (const text of [nextUser, nextSaved]) {
      const sandbox = values(parseBytes(text)).get(SANDBOX);
      if (sandbox !== undefined && (typeof sandbox !== "number" || sandbox <= 0)) refuse("FIREFOX_SANDBOX_UNSAFE_OVERRIDE", "Unowned unsafe Firefox sandbox override remains; it was preserved, not silently removed or accepted.");
    }
    const plan = [
      { original: saved, next: nextSaved }, { original: user, next: nextUser },
      { original: ownership, next: utf8Bytes(stateText({ version: 1, file, entries })) },
    ];
    const staged = plan.map(item => ({ ...item, temp: stage(dir, item.original.name, item.next, temps) }));
    assertDirectory();
    for (const item of staged) unchanged(dir, item.original);
    for (const item of staged) {
      assertDirectory(); unchanged(dir, item.original);
      fs.renameSync(path.join(dir, item.temp), path.join(dir, item.original.name)); temps.delete(item.temp); committed.push(item);
    }
    syncDir(dir);
    for (const item of plan) if (snapshot(dir, item.original.name).text !== item.next) refuse("FIREFOX_PREFS_WRITE_FAILED", "Firefox prefs read-back verification failed.");
    return { managedKeys: entries.map(entry => entry.key), releasedKeys: previous.filter(entry => !desired.has(entry.key)).map(entry => entry.key).sort(), migratedLegacy, legacyBaselineUnavailable: migratedLegacy ? previous.map(entry => entry.key).sort() : [] };
  } catch (error) {
    try {
      for (const item of [...committed].reverse()) {
        assertDirectory();
        if (snapshot(dir, item.original.name).text !== item.next) refuse("FIREFOX_PREFS_CHANGED", "Concurrent Firefox prefs change prevents rollback.");
        if (item.original.text === null) fs.unlinkSync(path.join(dir, item.original.name));
        else { const temp = stage(dir, item.original.name, item.original.text, temps); fs.renameSync(path.join(dir, temp), path.join(dir, item.original.name)); temps.delete(temp); }
      }
      if (committed.length) {
        syncDir(dir);
        for (const item of committed) if (snapshot(dir, item.original.name).text !== item.original.text) refuse("FIREFOX_PREFS_WRITE_FAILED", "Firefox prefs rollback read-back verification failed.");
      }
    } catch (rollback) {
      retainLock = true;
      throw new FirefoxPrefsError("FIREFOX_PREFS_TRANSACTION_INCOMPLETE", "Firefox prefs rollback was incomplete; the transaction lock was retained. Do not launch until the stopped profile is reconciled.", { cause: new AggregateError([error, rollback]) });
    }
    throw error;
  } finally {
    fs.closeSync(lockFd);
    assertDirectory();
    for (const temp of temps) fs.unlinkSync(path.join(dir, temp));
    if (!retainLock) {
      const current = lstat(path.join(dir, lockName));
      if (!current || current.isSymbolicLink() || current.dev !== lockStat.dev || current.ino !== lockStat.ino) refuse("FIREFOX_PREFS_TRANSACTION_INCOMPLETE", "Firefox prefs transaction lock changed; reconciliation is required.");
      fs.unlinkSync(path.join(dir, lockName)); syncDir(dir);
    }
  }
}
