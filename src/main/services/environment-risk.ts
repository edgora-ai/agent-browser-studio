// ── Host environment risk check ──
// Surfaces the anti-detection risks that live on the *host* rather than in the
// browser: DNS resolvers that leak the real location, Chinese-language fonts
// installed on the OS, SOCKS5 local DNS resolution, and non-standard rAF
// frame timing. These are the signals environment scanners (ping0.cc etc.)
// use to distinguish a real US machine from an anti-detect setup. Pure logic
// is injectable so it is unit-testable; network/runtime parts degrade to
// "unknown" instead of failing the whole check.

import * as dns from "node:dns";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedProfileProxy } from "../types.js";

export type EnvSeverity = "high" | "medium" | "info";

export interface EnvRiskFinding {
  severity: EnvSeverity;
  code: string;
  message: string;
  fix: string;
}

export interface EnvResolverInfo {
  address: string;
  label?: string;
  /** true when the resolver is a known Chinese public/ISP resolver. */
  isCn: boolean;
}

export interface EnvRafResult {
  samples: number;
  medianMs: number;
  meanMs: number;
  refreshHz: number;
  standard: boolean;
}

export interface EnvironmentRiskResult {
  ok: boolean; // true iff no high-severity findings
  hostPlatform: NodeJS.Platform;
  hostLocale: string;
  resolvers: EnvResolverInfo[];
  cnFonts: string[];
  proxy: {
    mode: string;
    type?: string;
    dnsLeakRisk: "low" | "high" | "none";
    note: string;
  };
  raf: EnvRafResult | null;
  findings: EnvRiskFinding[];
}

const KNOWN_RESOLVERS: Array<{ ip: string; label: string; isCn: boolean }> = [
  { ip: "8.8.8.8", label: "Google Public DNS", isCn: false },
  { ip: "8.8.4.4", label: "Google Public DNS", isCn: false },
  { ip: "1.1.1.1", label: "Cloudflare", isCn: false },
  { ip: "1.0.0.1", label: "Cloudflare", isCn: false },
  { ip: "9.9.9.9", label: "Quad9", isCn: false },
  { ip: "208.67.222.222", label: "OpenDNS", isCn: false },
  { ip: "208.67.220.220", label: "OpenDNS", isCn: false },
  { ip: "77.88.8.8", label: "Yandex DNS", isCn: false },
  { ip: "114.114.114.114", label: "114DNS (China Telecom)", isCn: true },
  { ip: "114.114.115.115", label: "114DNS (China Telecom)", isCn: true },
  { ip: "223.5.5.5", label: "AliDNS (Alibaba)", isCn: true },
  { ip: "223.6.6.6", label: "AliDNS (Alibaba)", isCn: true },
  { ip: "119.29.29.29", label: "DNSPod/Tencent", isCn: true },
  { ip: "180.76.76.76", label: "Baidu DNS", isCn: true },
  { ip: "101.226.4.6", label: "Shanghai Telecom DNS", isCn: true },
  { ip: "123.125.81.6", label: "Beijing Unicom DNS", isCn: true },
  { ip: "202.106.0.20", label: "Beijing Unicom DNS", isCn: true },
  { ip: "1.2.4.8", label: "CNNIC DNS", isCn: true },
  { ip: "210.2.4.8", label: "CNNIC DNS", isCn: true },
];

const CN_RESOLVER = new Set(KNOWN_RESOLVERS.filter((r) => r.isCn).map((r) => r.ip));

/** Classify a resolver address (known public/ISP tables + heuristic CN ranges). */
export function classifyResolver(address: string): EnvResolverInfo {
  const known = KNOWN_RESOLVERS.find((r) => r.ip === address);
  if (known) return { address, label: known.label, isCn: known.isCn };
  // Heuristic: well-known Chinese ISP resolver prefixes (first 3 octets).
  const CN_ISP_PREFIXES = [
    "202.96","202.97","202.98","202.99","61.144","61.49","61.135","61.148","61.155","61.157","61.164","61.177","61.183","61.184","61.185","61.186","61.187","61.188","61.191",
    "210.21","210.22","211.98","211.99","211.136","211.137","211.138","211.139","211.140","211.141","211.142","211.143",
    "218.30","219.146","219.147","219.148","219.150","219.151","219.152","220.181","222.72","222.73","222.74","222.75","222.76","222.77","222.78","222.79","222.80","222.81","222.82","222.83","222.84","222.85","222.86","222.87","222.88","222.89",
    "58.20","58.21","58.22","58.23","58.24","101.225","101.226","101.227","101.228","101.229",
    "112.24","112.25","112.26","112.27","112.28","112.29","112.30","112.31","112.32","112.33","112.34","112.35","112.36","112.37","112.38","112.39",
    "113.10","113.11","113.12","113.13","113.14","113.15","113.16","113.17","113.18","113.19",
    "114.24","114.25","114.26","114.27","114.28","114.29","114.30","114.31","114.32","114.33","114.34","114.35","114.36","114.37","114.38","114.39",
    "115.23","115.24","115.25","115.26","115.27","115.28","115.29","115.30","115.31","115.32","115.33","115.34","115.35","115.36","115.37","115.38","115.39",
    "119.12","119.13","119.14","119.15","119.16","119.17","119.18","119.19","119.20","119.21","119.22","119.23","119.24","119.25","119.26","119.27","119.28","119.29",
    "120.13","120.14","120.15","120.16","120.17","120.18","120.19","123.12","123.13","123.14","123.15","123.16","123.17","123.18","123.19",
    "124.11","124.12","124.13","124.14","124.15","124.16","124.17","124.18","124.19","125.30","125.31","125.32","125.33","125.34","125.35","125.36","125.37","125.38","125.39",
  ];
  const isCn = CN_ISP_PREFIXES.some((prefix) => address.startsWith(prefix + "."));
  return { address, isCn };
}

/** Read the system's configured DNS resolver addresses. */
export function getDnsResolvers(): string[] {
  try {
    return dns.getServers().filter((a) => typeof a === "string" && a.includes(".")).slice(0, 12);
  } catch (e) {
    return [];
  }
}

const CN_FONT_MARKERS: Array<{ match: RegExp; name: string }> = [
  { match: /simsun/i, name: "SimSun (宋体)" },
  { match: /simhei/i, name: "SimHei (黑体)" },
  { match: /msyh|yahei|微软雅黑/i, name: "Microsoft YaHei (微软雅黑)" },
  { match: /simkai|kaiti|楷体/i, name: "KaiTi (楷体)" },
  { match: /simfang|fangsong|仿宋/i, name: "FangSong (仿宋)" },
  { match: /dengxian|等线/i, name: "DengXian (等线)" },
  { match: /pingfang|苹方/i, name: "PingFang SC (苹方)" },
  { match: /stheit|heiti/i, name: "STHeiti (黑体-简)" },
  { match: /songti|宋体/i, name: "Songti SC (宋体-简)" },
  { match: /hiragino.*gb|冬青黑/i, name: "Hiragino Sans GB" },
  { match: /huawen|华文/i, name: "华文字体 (Huawen)" },
  { match: /founder|方正/i, name: "方正字体 (Founder)" },
  { match: /nanum.*cjk|noto.*cjk.*sc/i, name: "Noto Sans CJK SC" },
];

const FONT_EXT_RE = /\.(?:ttf|ttc|otf)$/i;

function fontSearchDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === "darwin") {
    dirs.push("/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(os.homedir(), "Library", "Fonts"));
  } else if (process.platform === "win32") {
    const windir = process.env.WINDIR || "C:\\Windows";
    dirs.push(path.join(windir, "Fonts"));
  } else {
    dirs.push("/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local", "share", "fonts"));
  }
  return dirs;
}

function listFontFiles(dir: string, depth: number): string[] {
  if (depth > 2) return [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const files: string[] = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) files.push(...listFontFiles(full, depth + 1));
    else if (ent.isFile() && FONT_EXT_RE.test(ent.name)) files.push(ent.name);
  }
  return files;
}

/** Detect Chinese-language font names installed on the host (injectable dirs). */
export function scanSystemFonts(dirs?: string[]): string[] {
  const scan = dirs || fontSearchDirs();
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of scan) {
    for (const file of listFontFiles(dir, 0)) {
      for (const marker of CN_FONT_MARKERS) {
        if (marker.match.test(file) && !seen.has(marker.name)) {
          seen.add(marker.name);
          found.push(marker.name);
          break;
        }
      }
    }
  }
  return found.sort();
}

/** Pure proxy DNS-leak classification. */
export function proxyDnsLeak(proxy: Pick<ResolvedProfileProxy, "mode"> & { config?: { type?: string } | null }): { mode: string; type?: string; dnsLeakRisk: "low" | "high" | "none"; note: string } {
  if (proxy.mode === "none" || !proxy.config) {
    return { mode: proxy.mode, dnsLeakRisk: "none", note: "直连：系统 DNS 即出口解析（无代理隔离，出口 IP 与 DNS 均来自本机）" };
  }
  const type = proxy.config.type;
  if (type === "socks5") {
    return { mode: proxy.mode, type, dnsLeakRisk: "high", note: "SOCKS5 由本地解析 DNS，真实 DNS 流量可见；请改用 socks5h 让代理端解析" };
  }
  return { mode: proxy.mode, type, dnsLeakRisk: "low", note: "HTTP/SOCKS5h 由代理端解析 DNS，泄漏风险低" };
}

const STANDARD_REFRESH_HZ = [60, 75, 90, 120, 144, 165, 240];

/** Classify a measured median rAF interval into refresh rate; non-standard → suspicious. */
export function classifyRaf(medianMs: number, samples: number): EnvRafResult {
  if (samples <= 0 || !Number.isFinite(medianMs) || medianMs <= 0) {
    return { samples, medianMs: 0, meanMs: 0, refreshHz: 0, standard: false };
  }
  const refreshHz = Math.round(1000 / medianMs);
  const standard = STANDARD_REFRESH_HZ.some((hz) => Math.abs(refreshHz - hz) <= 2);
  return { samples, medianMs: Math.round(medianMs * 100) / 100, meanMs: 0, refreshHz, standard };
}

/** Comma-joined high/medium finding codes for audit/UI summaries. */
export function summarizeEnvFindings(findings: EnvRiskFinding[], severity?: EnvSeverity): string {
  const filtered = severity ? findings.filter((f) => f.severity === severity) : findings;
  return filtered.slice(0, 8).map((f) => f.code).join(", ") + (filtered.length > 8 ? " (+" + (filtered.length - 8) + " more)" : "");
}

/** Block decision: env-risk blocking is opt-in (blockOnEnvironmentRisk === true). */
export function shouldBlockEnvironmentRisk(result: EnvironmentRiskResult, enabled: boolean | undefined): boolean {
  return enabled === true && result.findings.some((f) => f.severity === "high");
}

export const RAF_MEASURE_EXPRESSION = `(async () => {
  const samples = [];
  const t0 = performance.now();
  let last = t0;
  await new Promise((resolve) => {
    function tick(now) {
      const dt = now - last;
      if (dt > 0) samples.push(dt);
      last = now;
      if (performance.now() - t0 < 1500 && samples.length < 240) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  const sorted = samples.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  return { samples: samples.length, median: Math.round(median * 100) / 100, mean: Math.round(mean * 100) / 100 };
})()`;

/** Measure rAF timing over a running profile via CDP. Returns null when unavailable. */
export async function measureRaf(cdpPort: number): Promise<EnvRafResult | null> {
  try {
    const { cdpConnect, cdpEvaluate } = await import("./local-agent.js");
    const client = await cdpConnect(cdpPort);
    try {
      const raw = await cdpEvaluate(client, RAF_MEASURE_EXPRESSION);
      const value = typeof raw === "string" ? JSON.parse(raw) : raw?.value || raw;
      const classified = classifyRaf(Number(value?.median) || 0, Number(value?.samples) || 0);
      return { ...classified, meanMs: Number(value?.mean) || 0 };
    } finally {
      try { (client as any).ws?.close?.(); } catch { /* ignore */ }
    }
  } catch (e) {
    return null;
  }
}

export interface EnvCheckOptions {
  /** Also measure rAF over a running profile (requires cdpPort). */
  runtime?: boolean;
  cdpPort?: number | null;
  /** Proxy override for unit tests (defaults to resolving from config). */
  proxy?: (Pick<ResolvedProfileProxy, "mode"> & { config?: { type?: string } | null }) | null;
  /** Host locale override for unit tests. */
  hostLocale?: string;
  /** Font dirs override for unit tests. */
  fontDirs?: string[];
  /** Resolver list override for unit tests. */
  resolvers?: string[];
}

/** Assemble the environment risk report for a profile. */
export function checkEnvironmentRisk(profile: {
  timezone?: string | null;
  locale?: string | null;
  platform?: string | null;
}, opts: EnvCheckOptions = {}): EnvironmentRiskResult {
  const hostLocale = opts.hostLocale ?? (typeof Intl !== "undefined" ? (Intl.DateTimeFormat().resolvedOptions().locale || "") : "");
  const resolvers = (opts.resolvers ?? getDnsResolvers()).map(classifyResolver);
  const cnFonts = scanSystemFonts(opts.fontDirs);
  const proxy = opts.proxy ? proxyDnsLeak(opts.proxy) : { mode: "unknown", dnsLeakRisk: "none" as const, note: "proxy unavailable" };

  const profileCountry = (profile.locale || "").match(/[-_]([a-zA-Z]{2})$/)?.[1]?.toUpperCase() || null;
  const profileIsCn = profileCountry === "CN" || profileCountry === null;
  const hostIsCnLocale = /^zh-/.test(hostLocale);

  const findings: EnvRiskFinding[] = [];
  const cnResolvers = resolvers.filter((r) => r.isCn);
  const foreignResolvers = resolvers.filter((r) => !r.isCn);
  if (cnResolvers.length) {
    if (profileIsCn) {
      findings.push({
        severity: "info",
        code: "dns-resolver-cn-matches",
        message: `DNS 解析器 ${cnResolvers.map((r) => r.address + (r.label ? " (" + r.label + ")" : "")).join(", ")} 为国内解析器，与中文 profile 一致`,
        fix: "无（与 profile 国家一致）",
      });
    } else {
      findings.push({
        severity: "high",
        code: "dns-resolver-leak",
        message: `DNS 解析器包含国内解析器 ${cnResolvers.map((r) => r.address + (r.label ? " (" + r.label + ")" : "")).join(", ")}，与 profile 出口国家不一致，平台可通过 DNS 探测定位真实区域`,
        fix: "把系统 DNS 改为 8.8.8.8 / 1.1.1.1 等海外解析器，或让代理接管 DNS（HTTP/socks5h）",
      });
    }
  } else if (!foreignResolvers.length) {
    findings.push({ severity: "info", code: "dns-resolver-unknown", message: "无法识别当前 DNS 解析器归属", fix: "手动核对系统 DNS 是否为海外解析器" });
  }

  if (cnFonts.length) {
    if (profileIsCn) {
      findings.push({ severity: "info", code: "cn-fonts-match", message: `检测到中文字体 ${cnFonts.join(", ")}，与中文 profile 一致`, fix: "无" });
    } else {
      findings.push({
        severity: "high",
        code: "cn-fonts-exposed",
        message: `本机装有中文字体 ${cnFonts.join(", ")}，但 profile 为非中文国家；Amazon/eBay 等风控会用字体表验证真实系统语言`,
        fix: "在非中文 profile 中使用字体目录隔离（fontsDir），或卸载/隐藏中文字体",
      });
    }
  }

  if (proxy.dnsLeakRisk === "high") {
    findings.push({
      severity: "high",
      code: "proxy-dns-leak",
      message: `当前代理为 SOCKS5，DNS 由本地解析（真实 DNS 流量不经过代理）`,
      fix: "把代理类型改为 socks5h（代理端解析 DNS），或改用 HTTP 代理",
    });
  }

  if (hostIsCnLocale && !profileIsCn) {
    findings.push({
      severity: "medium",
      code: "host-locale-leak",
      message: `宿主系统语言为 ${hostLocale}（中文环境），profile 却是非中文国家；操作系统级弹窗/默认行为可能暴露中文环境`,
      fix: "把操作系统语言切换为英文环境，或在纯英文虚拟机/容器中运行",
    });
  }

  let raf: EnvRafResult | null = null;
  if (opts.runtime && opts.cdpPort) {
    raf = null; // filled by caller after CDP measurement; see checkEnvironmentRiskRuntime
  }

  const ok = !findings.some((f) => f.severity === "high");
  return {
    ok,
    hostPlatform: process.platform,
    hostLocale,
    resolvers,
    cnFonts,
    proxy: { mode: proxy.mode, type: proxy.type, dnsLeakRisk: proxy.dnsLeakRisk, note: proxy.note },
    raf,
    findings,
  };
}

/** Runtime variant: measure rAF over CDP and append its finding. */
export async function checkEnvironmentRiskRuntime(profile: {
  timezone?: string | null;
  locale?: string | null;
  platform?: string | null;
}, cdpPort: number, opts: Omit<EnvCheckOptions, "runtime" | "cdpPort"> = {}): Promise<EnvironmentRiskResult> {
  const base = checkEnvironmentRisk(profile, { ...opts, runtime: false });
  const raf = await measureRaf(cdpPort);
  const result = { ...base, raf };
  if (raf && raf.samples > 0 && !raf.standard) {
    result.findings.push({
      severity: "medium",
      code: "raf-non-standard",
      message: `requestAnimationFrame 中位间隔 ${raf.medianMs}ms（≈${raf.refreshHz}Hz），不接近标准刷新率（60/90/120/144/240Hz），可能被识别为合成器或后台节流`,
      fix: "确认 profile 处于前台且无窗口遮挡/节流；若为虚拟机显卡，改用直通或独立显卡",
    });
    result.ok = result.ok && !result.findings.some((f) => f.severity === "high");
  } else if (raf && raf.samples === 0) {
    result.findings.push({ severity: "info", code: "raf-unmeasurable", message: "无法采样 rAF（页面可能被节流/隐藏）", fix: "把 profile 窗口切到前台后重试" });
  }
  return result;
}
