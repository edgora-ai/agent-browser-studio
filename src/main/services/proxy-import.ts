// Bulk proxy import/export (RoxyBrowser-style). Parses plain host:port lines,
// type://user:pass@host:port URIs (http/socks5/socks5h, IPv6 supported) and a
// name,type,host,port,username,password CSV header, then adds them to the
// local proxy store with dedupe + audit-friendly reports. Pure where possible
// so the parser is unit-testable.
import { addProxy, getConfig, getProxyList, getProxySecret } from "./config-manager.js";
import type { ProxyConfig } from "../types.js";

export interface ParsedProxy {
  name: string;
  config: ProxyConfig;
}

export interface ProxyImportReport {
  imported: string[];
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ line?: string; name?: string; error: string }>;
}

const PROXY_TYPES = new Set(["http", "socks5", "socks5h"]);

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function autoName(host: string, port: number): string {
  return sanitizeName(host + "-" + port) || "proxy-" + port;
}

function splitHostPort(s: string): { host: string; port: number } | null {
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0 || s[close + 1] !== ":") return null;
    const port = Number(s.slice(close + 2));
    const host = s.slice(1, close);
    return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
  }
  const lastColon = s.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const port = Number(s.slice(lastColon + 1));
  const host = s.slice(0, lastColon);
  return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
}

function decodeCred(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Parse one proxy line (URI form or plain host:port). Throws on invalid input. */
export function parseProxyLine(line: string): ParsedProxy {
  let s = String(line || "").trim();
  if (!s) throw new Error("empty line");
  let type: ProxyConfig["type"] = "http";
  const schemeEnd = s.indexOf("://");
  if (schemeEnd > 0) {
    const scheme = s.slice(0, schemeEnd).toLowerCase();
    if (scheme === "https") type = "http";
    else if (scheme === "http") type = "http";
    else if (scheme === "socks5") type = "socks5";
    else if (scheme === "socks5h") type = "socks5h";
    else throw new Error("unknown scheme " + JSON.stringify(scheme));
  s = s.slice(schemeEnd + 3);
}
  let username: string | undefined;
  let password: string | undefined;
  const at = s.lastIndexOf("@");
  if (at >= 0) {
    const creds = s.slice(0, at);
    s = s.slice(at + 1);
    const colon = creds.indexOf(":");
    if (colon >= 0) {
      username = decodeCred(creds.slice(0, colon));
      password = decodeCred(creds.slice(colon + 1));
    } else {
      username = decodeCred(creds);
    }
  }
  const hostPort = splitHostPort(s);
  if (!hostPort) throw new Error("expected host:port");
  const config: ProxyConfig = { type, host: hostPort.host, port: hostPort.port };
  if (username) config.username = username;
  if (password) config.password = password;
  return { name: autoName(hostPort.host, hostPort.port), config };
}

/** Split one CSV row, honoring double-quoted fields. */
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") { cur += "\""; i++; }
        else inQuote = false;
      } else cur += ch;
    } else if (ch === "\"") {
      inQuote = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const HEADER_KEYS = new Set(["name", "type", "host", "port", "username", "user", "password", "pass"]);

function looksLikeHeader(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((c) => HEADER_KEYS.has(c.toLowerCase())) &&
    (cells.some((c) => c.toLowerCase() === "host") || cells.some((c) => c.toLowerCase() === "name"));
}

/**
 * Parse a multi-line proxy list into named proxy specs. Returns per-line
 * failures so a single bad entry never aborts the batch.
 */
export function parseProxyText(text: string): { proxies: ParsedProxy[]; errors: Array<{ line: string; error: string }> } {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return { proxies: [], errors: [] };
  const firstCells = splitCsvRow(lines[0]);
  const header = looksLikeHeader(firstCells) ? firstCells.map((c) => c.toLowerCase()) : null;
  const proxies: ParsedProxy[] = [];
  const errors: Array<{ line: string; error: string }> = [];
  if (header) {
    const col = new Map<string, number>();
    header.forEach((c, i) => { if (!col.has(c)) col.set(c, i); });
    const cell = (cells: string[], key: string): string | undefined => {
      const i = col.get(key);
      return i !== undefined && i < cells.length ? cells[i].trim() : undefined;
    };
    for (const line of lines.slice(1)) {
      const cells = splitCsvRow(line);
      // A single-cell row is a URI line mixed into a CSV batch — parse it directly.
      if (cells.length === 1) {
        try {
          proxies.push(parseProxyLine(line));
        } catch (e: any) {
          errors.push({ line, error: e?.message || String(e) });
        }
        continue;
      }
      const nameRaw = cell(cells, "name") || "";
      const typeRaw = (cell(cells, "type") || "http").toLowerCase();
      const host = cell(cells, "host") || "";
      const port = Number(cell(cells, "port"));
      const username = cell(cells, "username") || cell(cells, "user") || undefined;
      const password = cell(cells, "password") || cell(cells, "pass") || undefined;
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push({ line, error: "invalid host/port" });
        continue;
      }
      if (!PROXY_TYPES.has(typeRaw)) {
        errors.push({ line, error: "unknown type " + JSON.stringify(typeRaw) });
        continue;
      }
      const config: ProxyConfig = { type: typeRaw as ProxyConfig["type"], host, port };
      if (username) config.username = username;
      if (password) config.password = password;
      const name = sanitizeName(nameRaw) || autoName(host, port);
      proxies.push({ name, config });
    }
  } else {
    for (const line of lines) {
      try {
        proxies.push(parseProxyLine(line));
      } catch (e: any) {
        errors.push({ line, error: e?.message || String(e) });
      }
    }
  }
  return { proxies, errors };
}

function proxyFingerprint(config: ProxyConfig): string {
  return config.type + "://" + String(config.host).toLowerCase() + ":" + config.port;
}

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(base + "-" + n)) n++;
  return base + "-" + n;
}

export interface ImportOptions {
  /** Replace an existing proxy with the same name instead of skipping it. */
  replace?: boolean;
}

/** Add parsed proxies to the store with dedupe and a per-entry report. */
export function importProxies(parsed: ParsedProxy[], opts?: ImportOptions): ProxyImportReport {
  const cfg = getConfig() as any;
  const existingNames = new Set<string>(Object.keys(cfg.proxies || {}));
  const existingFingerprints = new Set<string>();
  for (const [name, p] of Object.entries(cfg.proxies || {})) {
    existingFingerprints.add(proxyFingerprint(p as ProxyConfig));
  }
  const report: ProxyImportReport = { imported: [], skipped: [], failed: [] };
  const seen = new Set<string>();
  for (const item of parsed) {
    const fp = proxyFingerprint(item.config);
    if (seen.has(fp) || existingFingerprints.has(fp)) {
      report.skipped.push({ name: item.name, reason: "duplicate " + fp });
      continue;
    }
    seen.add(fp);
    let name = item.name;
    if (existingNames.has(name) && !opts?.replace) {
      name = uniqueName(name, existingNames);
    }
    try {
      addProxy(name, item.config);
      existingNames.add(name);
      existingFingerprints.add(fp);
      report.imported.push(name);
    } catch (e: any) {
      report.failed.push({ name: item.name, error: e?.message || String(e) });
    }
  }
  return report;
}

function csvEscape(value: string): string {
  return /[,"\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

/**
 * Serialize the current proxy store as a CSV document.
 * Passwords are REDACTED by default — pass `{ includePasswords: true }` only
 * for an explicit user-confirmed migration export (the caller must audit it).
 */
export function exportProxiesCsv(opts?: { includePasswords?: boolean }): string {
  const includePasswords = opts?.includePasswords === true;
  const rows = getProxyList().map((p) => {
    const secret = getProxySecret(p.name);
    const cfg = (secret || p.config) as any;
    const password = includePasswords ? (cfg.password || "") : "";
    return [p.name, cfg.type || "http", cfg.host || "", String(cfg.port ?? ""), cfg.username || "", password]
      .map((v) => csvEscape(String(v))).join(",");
  });
  return ["name,type,host,port,username,password", ...rows].join("\n");
}
