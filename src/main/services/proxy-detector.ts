import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ProxyConfig } from "../types.js";
import { getConfig } from "./config-manager.js";

export interface ProxyDetectionResult {
  success: boolean;
  exitIp: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  regionName: string | null;
  city: string | null;
  timezone: string | null;
  lat: number | null;
  lon: number | null;
  isp: string | null;
  org: string | null;
  as: string | null;
  /** true when the exit IP belongs to a hosting/IDC/datacenter (e.g. Oracle/AWS/Azure cloud). */
  hosting: boolean | null;
  /** true when the exit IP is flagged as a public proxy/VPN/anonymizer. */
  isProxy: boolean | null;
  provider: string | null;
  latencyMs: number | null;
  error: string | null;
}

function emptyResult(success: boolean, error?: string): ProxyDetectionResult {
  return {
    success,
    exitIp: null,
    country: null,
    countryCode: null,
    region: null,
    regionName: null,
    city: null,
    timezone: null,
    lat: null,
    lon: null,
    isp: null,
    org: null,
    as: null,
    hosting: null,
    isProxy: null,
    provider: null,
    latencyMs: null,
    error: error || null,
  };
}

// Known hosting/IDC/cloud ASNs (conservative set — public cloud & datacenter
// providers that platforms treat as high-risk for account warming). Matched
// against the exit IP's ASN so hosting is detectable even from providers that
// don't return an explicit `hosting` field (ipwho.is free endpoint).
const HOSTING_ASNS = new Set<number>([
  31898, // Oracle Cloud
  16509, 14618, 8987, 9059, 8068, 8069, // Amazon / AWS
  396982, 396983, 396984, 146824, 206194, 15169, // Google / GCP
  8075, 12076, 8070, 8071, 8072, 8073, 8074, // Microsoft / Azure
  14061, 19871, // DigitalOcean
  20473, // Vultr / Choopa
  63949, 20940, // Linode / Akamai
  24940, // Hetzner
  16276, // OVH
  12876, // Scaleway
  51167, // Contabo
  8560, // IONOS / 1&1
  26347, // DreamHost
  13335, 209242, // Cloudflare
  37963, 45102, 45062, // Alibaba / Aliyun
  45090, 132203, // Tencent Cloud
  136907, 55990, // Huawei Cloud
  199524, // G-Core
  55286, // UpCloud
  29802, // HCC
  63199, // CDN77
  212238, // Datacamp / CDN77
  49392, // Choopa (secondary)
  46606, 46604, // Unified Layer (Bluehost/HostGator)
  46475, // HostGator / Bluehost (LIMESTONENETWORKS)
  43959, // CloudSigma
  42610, // iWeb / Quebec
  395954, // Hostwinds
  36444, // Aruba / Cloud Italia
  35913, // DediPath
  33324, // HostDime
  32748, // Steadfast
  32475, // SingleHop
  32097, // WholeSale Internet
  30083, // GoDaddy
  29873, // Newfold / Bluehost
  26496, // GoDaddy (AS-26496-GODADDY)
  25184, // NFOrce
  21859, // Zenlayer
  201838, // Zenlayer
  204428, // Zenlayer
  207990, // Zenlayer
  213230, // Zenlayer
  14745, // Internap
]);

const HOSTING_ORG_HINTS = [
  "oracle cloud", "oracle corporation", "amazon", "amazonaws", "aws ",
  "microsoft azure", "azure ", "google cloud", "google llc", "digitalocean",
  "linode", "vultr", "hetzner", "ovh", "scaleway", "ionos", "contabo",
  "alibaba", "aliyun", "tencent cloud", "huawei cloud", "cloudflare",
  "g-core", "upcloud", "phoenixnap", "datacamp", "unified layer",
  "limestonenetworks", "hostgator", "bluehost", "dreamhost", "cloudsigma",
  "hostwinds", "aruba", "dedipath", "hostdime", "steadfast", "singlehop",
  "wholesale internet", "godaddy", "newfold", "zenlayer", "internap",
  "idc", "datacenter", "data center", "hosting", "colocation", "dedicated server",
];

/**
 * Classify an exit identity as hosting/IDC or public-proxy from offline ASN /
 * org hints. Conservative: only known cloud/datacenter ASNs and explicit
 * hosting/IDC org names match, so residential ISPs are never mislabeled.
 */
export function classifyHosting(identity: { as?: string | null; org?: string | null; isp?: string | null }): { hosting: boolean; isProxy: boolean } {
  const asnMatch = identity.as?.match(/AS(\d+)/i);
  const asn = asnMatch ? Number(asnMatch[1]) : null;
  if (asn && HOSTING_ASNS.has(asn)) return { hosting: true, isProxy: false };
  const haystack = [identity.org, identity.isp].filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return { hosting: false, isProxy: false };
  for (const hint of HOSTING_ORG_HINTS) {
    if (haystack.includes(hint)) return { hosting: true, isProxy: false };
  }
  return { hosting: false, isProxy: false };
}

export function buildProxyUrl(config: ProxyConfig): string {
  return buildProxyUrlFor(config, config.type);
}

export function buildChromiumProxyUrl(config: ProxyConfig): string {
  return buildProxyUrlFor(config, config.type === "socks5h" ? "socks5" : config.type);
}

function buildProxyUrlFor(config: ProxyConfig, scheme: ProxyConfig["type"] | "socks5"): string {
  if (config.type !== "http" && config.type !== "socks5" && config.type !== "socks5h") {
    throw new Error(`Invalid proxy type: ${JSON.stringify(config.type)}`);
  }

  const host = String(config.host || "").trim();
  const isIp = net.isIP(host) !== 0;
  const isHostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/.test(host);
  if (!isIp && !isHostname) {
    throw new Error(`Invalid proxy host: ${JSON.stringify(config.host)}`);
  }

  const port = typeof config.port === "number" ? config.port : Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy port: ${JSON.stringify(config.port)}`);
  }

  const urlHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return `${scheme}://${urlHost}:${port}`;
}

export function writeCurlConfig(config: ProxyConfig): string {
  const filePath = path.join(os.tmpdir(), `agent-browser-proxy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.conf`);
  const lines = [`proxy = ${JSON.stringify(buildProxyUrl(config))}`];
  if (config.username) lines.push(`proxy-user = ${JSON.stringify(`${config.username}:${config.password || ""}`)}`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  return filePath;
}

/**
 * Resolve the proxy that outbound downloads should use, in priority order:
 *   1. explicit override (opts.proxyConfig)
 *   2. the app's configured default proxy (config.defaultProxy)
 *   3. standard proxy env vars (HTTPS_PROXY / https_proxy / ALL_PROXY / HTTP_PROXY)
 *   4. null → connect directly
 *
 * This makes extension (and other curl-based) downloads honor the proxy the
 * user configured in the Proxies tab, which is this product's core promise:
 * all outbound traffic stays behind the user's proxy.
 */
export function resolveDownloadProxy(opts: { proxyConfig?: ProxyConfig | null } = {}): ProxyConfig | null {
  if (opts.proxyConfig) return opts.proxyConfig;
  try {
    const cfg = getConfig();
    const name = cfg.defaultProxy;
    if (name && cfg.proxies && Object.prototype.hasOwnProperty.call(cfg.proxies, name)) {
      const p = cfg.proxies[name];
      if (p && p.host) return { ...p };
    }
  } catch (_) {
    /* config not ready — fall through to env */
  }
  const envProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return parseEnvProxy(envProxy);
  return null;
}

/** Parse a standard proxy URL, including bracketed IPv6 and encoded credentials. */
export function parseEnvProxy(raw: string): ProxyConfig | null {
  try {
    const parsed = new URL(raw.trim());
    const protocol = parsed.protocol.toLowerCase();
    const type: ProxyConfig["type"] = protocol === "socks5h:"
      ? "socks5h"
      : protocol === "socks5:"
        ? "socks5"
        : protocol === "http:" || protocol === "https:"
          ? "http"
          : (() => { throw new Error("unsupported proxy scheme"); })();
    if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) return null;
    const host = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : type === "http" ? 8080 : 1080;
    const config: ProxyConfig = {
      type,
      host,
      port,
      ...(parsed.username
        ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password || ""),
        }
        : {}),
    };
    buildProxyUrl(config);
    return config;
  } catch {
    return null;
  }
}

/**
 * Synchronously download `url` to `destPath` via curl, routing through the
 * resolved proxy (app default → env → direct). Credentials are passed via a
 * 0600 curl config file, never on the argv. Throws an Error whose message
 * names the URL and whether a proxy was in use, so the UI can report it.
 */
export function downloadFileWithCurl(
  url: string,
  destPath: string,
  opts: { timeoutMs?: number; proxyConfig?: ProxyConfig | null; bypassProxy?: boolean } = {},
): void {
  const timeout = opts.timeoutMs ?? 30000;
  const proxy = opts.bypassProxy ? null : resolveDownloadProxy({ proxyConfig: opts.proxyConfig });
  let confPath: string | null = null;
  try {
    const curlArgs = ["-fsSL", "-o", destPath, url];
    if (proxy) {
      confPath = writeCurlConfig(proxy);
      curlArgs.unshift("--config", confPath);
    }
    execFileSync("curl", curlArgs, { timeout });
  } catch (e: any) {
    const via = proxy ? ` via proxy ${buildProxyUrl(proxy)}` : " (direct connection)";
    throw new Error(`Download failed for ${url}${via}: ${e.message || String(e)}`);
  } finally {
    if (confPath) {
      try { fs.unlinkSync(confPath); } catch { /* ignore */ }
    }
  }
}

function spawnCurlWithProxy(config: ProxyConfig, args: string[]) {
  const configPath = writeCurlConfig(config);
  const child = spawn("curl", ["--config", configPath, ...args]);
  const cleanup = () => { try { fs.unlinkSync(configPath); } catch {} };
  child.on("close", cleanup);
  child.on("error", cleanup);
  return child;
}

function curlJsonAsync(config: ProxyConfig, url: string, timeoutSeconds: number): Promise<{ data: any | null; latencyMs: number; error: string | null }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawnCurlWithProxy(config, [
      "-sS", "--connect-timeout", "2", "--max-time", String(timeoutSeconds),
      url,
    ]);

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ data: null, latencyMs: Date.now() - startTime, error: "timeout" });
    }, (timeoutSeconds + 1) * 1000);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;
      if (code !== 0) {
        resolve({ data: null, latencyMs, error: (stderr || stdout || `curl exited ${code}`).trim() });
        return;
      }

      const output = stdout.trim();
      if (!output) {
        resolve({ data: null, latencyMs, error: "Empty Geo-IP response" });
        return;
      }

      try {
        resolve({ data: JSON.parse(output), latencyMs, error: null });
      } catch {
        const ipMatch = output.match(/\d+\.\d+\.\d+\.\d+/);
        if (ipMatch) resolve({ data: { ip: ipMatch[0] }, latencyMs, error: null });
        else resolve({ data: null, latencyMs, error: `Unrecognized Geo-IP response: ${output.slice(0, 100)}` });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ data: null, latencyMs: Date.now() - startTime, error: err.message || "Execution error" });
    });
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fromIpwhois(data: any, latencyMs: number): ProxyDetectionResult | null {
  if (!data || data.success === false) return null;
  const ip = data.ip || data.query;
  if (!ip || !data.timezone?.id || !data.country_code) return null;
  const classified = classifyHosting({ as: data.connection?.asn ? `AS${data.connection.asn}` : null, org: data.connection?.org, isp: data.connection?.isp });
  return {
    success: true,
    exitIp: ip,
    country: data.country || null,
    countryCode: data.country_code || null,
    region: data.region_code || null,
    regionName: data.region || null,
    city: data.city || null,
    timezone: data.timezone?.id || null,
    lat: numberOrNull(data.latitude),
    lon: numberOrNull(data.longitude),
    isp: data.connection?.isp || null,
    org: data.connection?.org || null,
    as: data.connection?.asn ? `AS${data.connection.asn}` : null,
    hosting: classified.hosting,
    isProxy: classified.isProxy,
    provider: "ipwho.is",
    latencyMs,
    error: null,
  };
}

function fromIpapi(data: any, latencyMs: number): ProxyDetectionResult | null {
  if (!data || data.error) return null;
  const ip = data.ip;
  if (!ip || !data.timezone || !data.country_code) return null;
  const classified = classifyHosting({ as: data.asn, org: data.org, isp: data.org });
  return {
    success: true,
    exitIp: ip,
    country: data.country_name || null,
    countryCode: data.country_code || null,
    region: data.region_code || null,
    regionName: data.region || null,
    city: data.city || null,
    timezone: data.timezone || null,
    lat: numberOrNull(data.latitude),
    lon: numberOrNull(data.longitude),
    isp: data.org || null,
    org: data.org || null,
    as: data.asn || null,
    hosting: classified.hosting,
    isProxy: classified.isProxy,
    provider: "ipapi.co",
    latencyMs,
    error: null,
  };
}

function fromIpApi(data: any, latencyMs: number): ProxyDetectionResult | null {
  if (!data || data.status === "fail") return null;
  const ip = data.query;
  if (!ip || !data.timezone || !data.countryCode) return null;
  const classified = classifyHosting({ as: data.as, org: data.org, isp: data.isp });
  return {
    success: true,
    exitIp: ip,
    country: data.country || null,
    countryCode: data.countryCode || null,
    region: data.region || null,
    regionName: data.regionName || null,
    city: data.city || null,
    timezone: data.timezone || null,
    lat: numberOrNull(data.lat),
    lon: numberOrNull(data.lon),
    isp: data.isp || null,
    org: data.org || null,
    as: data.as || null,
    // ip-api.com returns authoritative `hosting` / `proxy` flags; fall back to
    // the offline heuristic when the flags are absent.
    hosting: typeof data.hosting === "boolean" ? data.hosting : classified.hosting,
    isProxy: typeof data.proxy === "boolean" ? data.proxy : classified.isProxy,
    provider: "ip-api.com",
    latencyMs,
    error: null,
  };
}

// Successful geo-IP detections are cached per proxy identity so repeat
// launches skip the network round-trip (profile launch speed optimization).
const DETECT_CACHE_TTL_MS = 10 * 60 * 1000;
const detectCache = new Map<string, { at: number; result: ProxyDetectionResult }>();

function detectCacheKey(config: ProxyConfig): string {
  return [config.type, String(config.host || ""), String(config.port || ""), String(config.username || "")].join("|");
}

function cachedDetection(config: ProxyConfig): ProxyDetectionResult | null {
  const cached = detectCache.get(detectCacheKey(config));
  if (!cached) return null;
  if (Date.now() - cached.at > DETECT_CACHE_TTL_MS) {
    detectCache.delete(detectCacheKey(config));
    return null;
  }
  return cached.result;
}

function rememberDetection(config: ProxyConfig, result: ProxyDetectionResult): void {
  if (!result.success || !result.exitIp) return;
  detectCache.set(detectCacheKey(config), { at: Date.now(), result });
}

/** Test-only hooks for the geo-IP detection cache. */
export function rememberProxyDetectionForTests(config: ProxyConfig, result: ProxyDetectionResult): void {
  rememberDetection(config, result);
}

export function cachedProxyDetectionForTests(config: ProxyConfig): ProxyDetectionResult | null {
  return cachedDetection(config);
}

export function resetProxyDetectionCacheForTests(): void {
  detectCache.clear();
}

export const proxyDetector = {
  async detect(config: ProxyConfig): Promise<ProxyDetectionResult> {
    const providers = [
      {
        url: "https://ipwho.is/",
        timeoutSeconds: 2,
        parse: fromIpwhois,
      },
      {
        url: "https://ipapi.co/json/",
        timeoutSeconds: 2,
        parse: fromIpapi,
      },
      {
        // R8 P1-6: ip-api.com supports HTTPS — never send the exit-IP lookup
        // (which reveals the user's proxy egress) over plaintext HTTP.
        url: "https://ip-api.com/json/?fields=status,message,query,country,countryCode,region,regionName,city,timezone,lat,lon,isp,org,as,proxy,hosting",
        timeoutSeconds: 2,
        parse: fromIpApi,
      },
    ];

    try {
      buildProxyUrl(config);
    } catch (e: any) {
      return emptyResult(false, e.message || "Invalid proxy config");
    }

    // Repeat launches of the same proxy reuse the last successful detection.
    const cached = cachedDetection(config);
    if (cached) return cached;

    // Fire all geo-IP queries concurrently and settle on the FIRST success
    // (Promise.any) instead of waiting for the slowest provider.
    const attempts = providers.map(async (provider) => {
      const result = await curlJsonAsync(config, provider.url, provider.timeoutSeconds);
      if (result.error) throw new Error(`${provider.url}: ${result.error}`);
      const parsed = provider.parse(result.data, result.latencyMs);
      if (!parsed) throw new Error(`${provider.url}: missing IP/Geo data`);
      return parsed;
    });

    try {
      const parsed = await Promise.any(attempts);
      rememberDetection(config, parsed);
      return parsed;
    } catch (e: any) {
      const errors: string[] = Array.isArray(e?.errors) ? e.errors.map((x: any) => String(x?.message || x)) : [String(e?.message || e)];
      const summary = errors.map(error => {
        const provider = error.split(": ")[0].replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (/timed out|timeout|Operation timed out/i.test(error)) return `${provider}: timeout`;
        if (/Connection reset|Recv failure/i.test(error)) return `${provider}: connection reset`;
        if (/Could not resolve|Name or service not known/i.test(error)) return `${provider}: DNS failed`;
        return `${provider}: failed`;
      }).join("; ");
      return emptyResult(false, summary || "Proxy Geo-IP detection failed");
    }
  },

  ping(config: ProxyConfig): Promise<{ success: boolean; latencyMs: number | null; error: string | null }> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      try {
        buildProxyUrl(config);
        const child = spawnCurlWithProxy(config, [
          "-s", "--max-time", "4",
          "https://www.google.com",
          "-o", "/dev/null", "-w", "%{http_code}",
        ]);

        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          resolve({ success: false, latencyMs: null, error: "timeout" });
        }, 5000);

        let stdout = "";
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            resolve({ success: false, latencyMs: null, error: `curl exited ${code}` });
            return;
          }
          const httpCode = stdout.trim();
          if (httpCode && httpCode !== "000") {
            resolve({ success: true, latencyMs: Date.now() - startTime, error: null });
          } else {
            resolve({ success: false, latencyMs: null, error: `HTTP ${httpCode || "no response"}` });
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ success: false, latencyMs: null, error: err.message || "Execution error" });
        });
      } catch (e: any) {
        resolve({ success: false, latencyMs: null, error: e.message || "Unknown error" });
      }
    });
  },
};
