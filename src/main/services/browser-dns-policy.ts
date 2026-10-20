import { isIP } from "node:net";
import type { ProxyConfig } from "../types.js";
import type { SecureDnsConfig } from "./browser-fingerprint-config.js";
import { NATIVE_LOCAL_DNS_POLICY_SWITCH, NATIVE_PROXY_BOOTSTRAP_HOST_SWITCH } from "./native-proxy-auth.js";

export interface ChromiumDnsPolicy {
  route: "stock" | "proxy" | "doh";
  secureDns: SecureDnsConfig | null;
}

/** Validate the HTTPS URI templates supported by Chromium's DoH reader. */
export function normalizeManagedSecureDnsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const template = value.trim();
  if (!template || template.length > 1000 || /\s/.test(template)) return null;
  const expansion = template.match(/\{([?&])dns\}$/)?.[1];
  const urlText = template.replace(/\{[?&]dns\}$/, "");
  if (/[{}]/.test(urlText)) return null;
  try {
    const url = new URL(urlText);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return null;
    if ((expansion === "?" && url.search) || (expansion === "&" && !url.search)) return null;
    return template;
  } catch {
    return null;
  }
}

/** Block local target prefetch while a fixed HTTP/SOCKS proxy resolves at egress. */
export function buildRemoteDnsRule(proxyConnectHost: string, existing: string | null): string {
  const host = String(proxyConnectHost || "").trim();
  const excludes = Array.from(new Set(["localhost", "127.0.0.1", host].filter((value) => value && value !== "*")));
  const rule = `MAP * ^NOTFOUND${excludes.map((entry) => `, EXCLUDE ${entry}`).join("")}`;
  const entries = [rule, ...(existing || "").split(",")].map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(entries)].join(",");
}

function normalizeNativeProxyBootstrapHost(value: string): string {
  const invalid = () => new Error("Invalid proxy bootstrap host for native DNS policy");
  if (typeof value !== "string" || !value || value !== value.trim() || /[^\x21-\x7e]/.test(value)) throw invalid();
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const ipVersion = isIP(host);
  if (ipVersion === 6) return new URL(`http://[${host}]`).hostname.slice(1, -1);
  if (ipVersion === 4 && value === host) return host;
  if (value !== host || value.length > 253) throw invalid();
  const labels = (host.endsWith(".") ? host.slice(0, -1) : host).split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw invalid();
  try {
    if (new URL(`http://${host}`).hostname !== host.toLowerCase()) throw invalid();
  } catch {
    throw invalid();
  }
  return host.toLowerCase();
}

/** Use the restricted native policy only when the selected engine advertises it. */
export function buildProxyDnsArgs(
  proxyConnectHost: string,
  nativePolicySupported: boolean,
  existingResolverRules: string | null = null,
): string[] {
  if (!nativePolicySupported) {
    return [`--host-resolver-rules=${buildRemoteDnsRule(proxyConnectHost, existingResolverRules)}`];
  }
  if (existingResolverRules?.trim()) throw new Error("Native proxy DNS policy cannot be combined with arbitrary resolver rules");
  return [
    `${NATIVE_LOCAL_DNS_POLICY_SWITCH}=proxy-local-dns-deny`,
    `${NATIVE_PROXY_BOOTSTRAP_HOST_SWITCH}=${normalizeNativeProxyBootstrapHost(proxyConnectHost)}`,
  ];
}

/** Proxy-side resolution is the default; DoH is an explicit, strict choice. */
export function resolveChromiumDnsPolicy(
  proxy: ProxyConfig | null,
  managedSecureDnsUrl: unknown,
): ChromiumDnsPolicy {
  if (!proxy) return { route: "stock", secureDns: null };
  const requested = typeof managedSecureDnsUrl === "string" && managedSecureDnsUrl.trim().length > 0;
  if (!requested) return { route: "proxy", secureDns: null };
  const template = normalizeManagedSecureDnsUrl(managedSecureDnsUrl);
  if (!template) throw new Error("Invalid managed secure DNS URL: an HTTPS DoH template without credentials or fragments is required");
  return { route: "doh", secureDns: { enabled: true, templates: [template] } };
}
