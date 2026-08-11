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
    provider: null,
    latencyMs: null,
    error: error || null,
  };
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
  const filePath = path.join(os.tmpdir(), `cloak-proxy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.conf`);
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
    provider: "ipwho.is",
    latencyMs,
    error: null,
  };
}

function fromIpapi(data: any, latencyMs: number): ProxyDetectionResult | null {
  if (!data || data.error) return null;
  const ip = data.ip;
  if (!ip || !data.timezone || !data.country_code) return null;
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
    provider: "ipapi.co",
    latencyMs,
    error: null,
  };
}

function fromIpApi(data: any, latencyMs: number): ProxyDetectionResult | null {
  if (!data || data.status === "fail") return null;
  const ip = data.query;
  if (!ip || !data.timezone || !data.countryCode) return null;
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
    provider: "ip-api.com",
    latencyMs,
    error: null,
  };
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
        url: "http://ip-api.com/json/?fields=status,message,query,country,countryCode,region,regionName,city,timezone,lat,lon,isp,org,as",
        timeoutSeconds: 2,
        parse: fromIpApi,
      },
    ];

    try {
      buildProxyUrl(config);
    } catch (e: any) {
      return emptyResult(false, e.message || "Invalid proxy config");
    }

    // Run all geo-IP queries concurrently
    const promises = providers.map(async (provider) => {
      const result = await curlJsonAsync(config, provider.url, provider.timeoutSeconds);
      if (result.error) {
        return { error: `${provider.url}: ${result.error}`, parsed: null };
      }
      const parsed = provider.parse(result.data, result.latencyMs);
      return { error: null, parsed };
    });

    const results = await Promise.all(promises);

    // Pick the first successful parse
    for (const res of results) {
      if (res.parsed) return res.parsed;
    }

    // Accumulate errors if all failed
    const errors = results.map((res, i) => res.error || `${providers[i].url}: missing IP/Geo data`);
    const summary = errors.map(error => {
      const provider = error.split(": ")[0].replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (/timed out|timeout|Operation timed out/i.test(error)) return `${provider}: timeout`;
      if (/Connection reset|Recv failure/i.test(error)) return `${provider}: connection reset`;
      if (/Could not resolve|Name or service not known/i.test(error)) return `${provider}: DNS failed`;
      return `${provider}: failed`;
    }).join("; ");

    return emptyResult(false, summary || "Proxy Geo-IP detection failed");
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
