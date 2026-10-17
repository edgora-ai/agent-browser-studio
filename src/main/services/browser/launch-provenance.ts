import { createHash } from "node:crypto";
import type { BrowserProfileMeta, ProxyConfig } from "../../types.js";
import { normalizeManagedSecureDnsUrl, resolveChromiumDnsPolicy } from "../browser-dns-policy.js";
import { getChromiumManagedGpuIdentity, type ChromiumGpuContext } from "../browser-fingerprint-config.js";
import { normalizeBrowserProcessPath, type BrowserLaunchProcess } from "../process-discovery.js";
import { LaunchBlockedError } from "./launch-guards.js";

// Chromium ignores unrecognized switches. Firefox must never receive this flag.
export const CHROMIUM_LAUNCH_STAMP_SWITCH = "--agent-browser-launch-stamp=";
export interface ChromiumLaunchProvenance {
  version: 1;
  requestHash: string;
  payloadHash: string;
}

interface LaunchRequestConfig {
  chromiumBin?: string;
  defaultProxy?: string | null;
  proxies?: Record<string, ProxyConfig>;
  managedSecureDnsUrl?: unknown;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return value === undefined || value === null || value === "" ? null : Number(value);
}

/** Cached configuration only: no decryption, health probe, rotation, or I/O. */
export function cachedChromiumProxy(meta: BrowserProfileMeta, cfg: LaunchRequestConfig): ProxyConfig | null {
  const mode = meta.proxyMode || (meta.proxyName ? "named" : "none");
  const name = mode === "default" ? cfg.defaultProxy : mode === "named" ? meta.proxyName : null;
  return name && cfg.proxies && Object.hasOwn(cfg.proxies, name) ? cfg.proxies[name] : null;
}

export function assertChromiumReuseDnsCompatible(meta: BrowserProfileMeta, cfg: LaunchRequestConfig): void {
  if (meta.fingerprintMode !== "off") return;
  const policy = resolveChromiumDnsPolicy(cachedChromiumProxy(meta, cfg), cfg.managedSecureDnsUrl);
  if (policy.route === "doh") {
    throw new Error("Explicit proxy DoH requires managed Chromium identity mode in this engine; fingerprint-off profiles use proxy-side DNS without identity overrides");
  }
}

function proxyRequest(proxy: ProxyConfig | null): unknown {
  if (!proxy) return null;
  return {
    type: proxy.type,
    host: proxy.host.trim().toLowerCase(),
    port: Number(proxy.port),
    bypassList: [...new Set((proxy.bypassList || []).map((entry) => entry.trim()).filter(Boolean))].sort(),
  };
}

/**
 * Hash startup identity intent, not display metadata, health timestamps, or
 * secrets. Auto geo results are bound separately in the actual native payload.
 * Off-mode OS/seed/hardware fields are inactive and deliberately ignored.
 */
export function chromiumLaunchRequestHash(
  meta: BrowserProfileMeta,
  cfg: LaunchRequestConfig,
  opts: { headless?: boolean; binaryOverride?: string | null; gpuContext?: ChromiumGpuContext } = {},
): string {
  const mode = meta.fingerprintMode === "off" ? "off" : "managed";
  const proxy = cachedChromiumProxy(meta, cfg);
  const locale = text(meta.locale);
  const timezone = text(meta.timezone);
  const webrtcMode = meta.webrtcMode || (text(meta.webrtcIp) ? "altered" : "auto");
  const geoMode = meta.geolocationMode || "real";
  const dnsTemplate = proxy ? text(cfg.managedSecureDnsUrl) : null;
  const configuredBinary = cfg.chromiumBin && cfg.chromiumBin !== "auto" ? cfg.chromiumBin : opts.binaryOverride;
  const gpuIdentity = mode === "managed" && meta.engine !== "firefox"
    ? getChromiumManagedGpuIdentity(meta, opts.gpuContext) : null;
  return hash({
    version: 1,
    engine: meta.engine === "firefox" ? "firefox" : "chromium",
    mode,
    browserVersion: text(meta.browserVersion),
    binaryOverride: configuredBinary ? normalizeBrowserProcessPath(configuredBinary) : null,
    headless: opts.headless === true,
    identity: mode === "off" ? null : {
      platform: meta.platform || "windows",
      seed: Number(meta.fingerprintSeed || 12345),
      timezone: timezone ? new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone : null,
      locale: locale ? Intl.getCanonicalLocales(locale)[0] : null,
      webrtcMode,
      webrtcIp: webrtcMode === "auto" || webrtcMode === "altered" ? text(meta.webrtcIp) : null,
      geolocation: geoMode === "custom"
        ? [geoMode, optionalNumber(meta.geolocationLatitude), optionalNumber(meta.geolocationLongitude), optionalNumber(meta.geolocationAccuracy) ?? 50]
        : [geoMode],
      gpuVendor: text(meta.gpuVendor),
      gpuRenderer: text(meta.gpuRenderer),
      hardware: [meta.hardwareConcurrency, meta.deviceMemory, meta.screenWidth, meta.screenHeight, meta.storageQuota, meta.taskbarHeight].map(optionalNumber),
      fontsDir: text(meta.fontsDir) ? normalizeBrowserProcessPath(meta.fontsDir!.trim()) : null,
      renderScaleMode: meta.renderScaleMode || "native",
      // Omit this extension for unchanged policies so off and native-only
      // platforms retain their existing request hashes.
      ...(gpuIdentity ? { gpuIdentity } : {}),
    },
    dns: {
      proxyMode: meta.proxyMode || (meta.proxyName ? "named" : "none"),
      unresolvedProxy: proxy ? null : (meta.proxyMode === "default" ? cfg.defaultProxy || null : meta.proxyName || null),
      proxy: proxyRequest(proxy),
      // Fallback configuration affects possible startup DNS routes, not secrets.
      fallbacks: (proxy?.fallbacks || []).map((name) => proxyRequest(cfg.proxies && Object.hasOwn(cfg.proxies, name) ? cfg.proxies[name] : null)),
      template: dnsTemplate ? normalizeManagedSecureDnsUrl(dnsTemplate) || "invalid" : null,
    },
  });
}

export function restartRequired(reason: string): LaunchBlockedError {
  return new LaunchBlockedError(
    "restart-required",
    `Browser restart required: ${reason}. Explicitly stop this profile's browser and launch it again to apply and verify the current startup inputs. No running browser was stopped, replaced, or adopted. The launch stamp records inputs, not physical GPU compatibility.`,
  );
}

export function parseChromiumLaunchStamp(value: string): ChromiumLaunchProvenance | null {
  const match = /^v1\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(value);
  return match ? { version: 1, requestHash: match[1], payloadHash: match[2] } : null;
}

function relevantPayloadArgument(arg: string): boolean {
  const key = arg.split("=", 1)[0];
  return key.startsWith("--fingerprint") || [
    "--agent-browser-fingerprint-config", "--roxy-fingerprint-config", "--user-agent", "--lang",
    "--window-size", "--window-position", "--force-device-scale-factor",
    "--enable-features", "--disable-features", "--host-resolver-rules",
    "--agent-browser-local-dns-policy", "--agent-browser-proxy-bootstrap-host",
    "--proxy-server", "--proxy-bypass-list", "--no-proxy-server", "--proxy-auto-detect",
    "--proxy-pac-url", "--proxy-pac-mandatory", "--disable-quic", "--enable-quic",
    "--ignore-certificate-errors-spki-list", "--origin-to-force-quic-on",
    "--user-data-dir", "--remote-debugging-port",
  ].includes(key);
}

/** Bind the exact native config/UA and related identity/DNS switches, not a GPU claim. */
export function chromiumLaunchPayloadHash(args: readonly string[], mode: "managed" | "off"): string {
  const relevant = args.filter(relevantPayloadArgument);
  // Owned launches use a native auth file or bridge, never URL userinfo. Do
  // not hash inline credentials from an unknown/tampered command line.
  if (relevant.some((arg) => /^(?:--proxy-server|--proxy-pac-url)=/.test(arg) && arg.includes("@"))) {
    throw restartRequired("proxy startup arguments contain unsupported inline credentials");
  }
  const keys = relevant.map((arg) => arg.split("=", 1)[0]);
  if (new Set(keys).size !== keys.length) throw restartRequired("duplicate startup payload switches");
  const nativeArgs = relevant.filter((arg) => /^--(?:agent-browser|roxy)-fingerprint-config(?:=|$)/.test(arg));
  const userAgents = relevant.filter((arg) => arg.startsWith("--user-agent="));
  if (mode === "off") {
    if (relevant.some((arg) => arg.startsWith("--fingerprint") || /^--(?:agent-browser|roxy)-fingerprint-config/.test(arg) || /^--(?:user-agent|lang|window-size|window-position|force-device-scale-factor)(?:=|$)/.test(arg))) {
      throw restartRequired("fingerprint-off process still carries managed identity switches");
    }
  } else {
    if (nativeArgs.length !== 1 || userAgents.length !== 1) throw restartRequired("missing or ambiguous native identity payload/UA");
    const encoded = nativeArgs[0].slice(nativeArgs[0].indexOf("=") + 1);
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 131072) throw new Error("invalid payload encoding");
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      const payload = JSON.parse(decoded);
      if (Buffer.from(decoded).toString("base64url") !== encoded || JSON.stringify(payload) !== decoded ||
          payload.schemaVersion !== 1 || !Number.isInteger(payload.seed) || payload.seed < 1 ||
          !["Win32", "MacIntel", "Linux armv81"].includes(payload.platform) ||
          typeof payload.userAgent !== "string" || !payload.userAgent ||
          userAgents[0] !== `--user-agent=${payload.userAgent}`) throw new Error("invalid payload identity");
    } catch {
      throw restartRequired("malformed or unsupported native identity payload/UA");
    }
  }
  return hash({ version: 1, mode, args: [...relevant].sort() });
}

export function stampChromiumLaunch(args: readonly string[], requestHash: string, mode: "managed" | "off"): ChromiumLaunchProvenance {
  if (args.some((arg) => arg.split("=", 1)[0] === CHROMIUM_LAUNCH_STAMP_SWITCH.slice(0, -1))) throw restartRequired("duplicate launch stamp");
  return { version: 1, requestHash, payloadHash: chromiumLaunchPayloadHash(args, mode) };
}

export function chromiumLaunchStampArg(stamp: ChromiumLaunchProvenance): string {
  return `${CHROMIUM_LAUNCH_STAMP_SWITCH}v1.${stamp.requestHash}.${stamp.payloadHash}`;
}

export function assertChromiumLaunchProvenance(
  args: readonly string[],
  requestHash: string,
  mode: "managed" | "off",
): ChromiumLaunchProvenance {
  const stamps = args.filter((arg) => arg.split("=", 1)[0] === CHROMIUM_LAUNCH_STAMP_SWITCH.slice(0, -1));
  if (stamps.length !== 1 || !stamps[0].startsWith(CHROMIUM_LAUNCH_STAMP_SWITCH)) throw restartRequired("missing legacy or duplicate launch stamp");
  const stamp = parseChromiumLaunchStamp(stamps[0].slice(CHROMIUM_LAUNCH_STAMP_SWITCH.length));
  if (!stamp) throw restartRequired("malformed or unknown launch stamp version");
  if (stamp.requestHash !== requestHash) throw restartRequired("startup identity request changed");
  if (stamp.payloadHash !== chromiumLaunchPayloadHash(args, mode)) throw restartRequired("native startup payload no longer matches its launch stamp");
  return stamp;
}

export function assertChromiumReuseEvidence(
  evidence: BrowserLaunchProcess,
  expected: { profileDir: string; executablePath: string; requestHash: string; mode: "managed" | "off"; pid?: number; port?: number; provenance?: ChromiumLaunchProvenance },
): ChromiumLaunchProvenance {
  if (evidence.malformed || evidence.engine !== "chromium" || evidence.args.some((arg) => /^--type(?:=|$)/.test(arg)) ||
      evidence.profileDirs.length !== 1 || normalizeBrowserProcessPath(evidence.profileDirs[0]) !== normalizeBrowserProcessPath(expected.profileDir) ||
      normalizeBrowserProcessPath(evidence.executablePath) !== normalizeBrowserProcessPath(expected.executablePath) ||
      evidence.cdpPorts.length !== 1 || evidence.cdpPorts[0] < 1 || evidence.cdpPorts[0] > 65535 ||
      (expected.pid !== undefined && evidence.pid !== expected.pid) || (expected.port !== undefined && evidence.cdpPorts[0] !== expected.port)) {
    throw restartRequired("process path, executable, engine, PID, or debugging port could not be uniquely verified");
  }
  const stamp = assertChromiumLaunchProvenance(evidence.args, expected.requestHash, expected.mode);
  if (expected.provenance && (expected.provenance.version !== stamp.version || expected.provenance.requestHash !== stamp.requestHash || expected.provenance.payloadHash !== stamp.payloadHash)) {
    throw restartRequired("cached process provenance does not match the live process");
  }
  return stamp;
}
