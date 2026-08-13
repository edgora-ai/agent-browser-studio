import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyResolver, scanSystemFonts, proxyDnsLeak, classifyRaf,
  checkEnvironmentRisk, shouldBlockEnvironmentRisk, summarizeEnvFindings, classifyCnFontDisplayName,
} from "../../src/main/services/environment-risk.js";

const TMP = path.join(os.tmpdir(), "agent-browser-envrisk-test-" + Date.now());

describe("environment risk — DNS resolvers", () => {
  it("classifies known Chinese vs foreign resolvers", () => {
    expect(classifyResolver("223.5.5.5").isCn).toBe(true);
    expect(classifyResolver("114.114.114.114").isCn).toBe(true);
    expect(classifyResolver("8.8.8.8").isCn).toBe(false);
    expect(classifyResolver("1.1.1.1").isCn).toBe(false);
  });

  it("heuristic-tags common Chinese ISP resolver prefixes", () => {
    expect(classifyResolver("202.96.128.86").isCn).toBe(true);
    expect(classifyResolver("61.144.56.100").isCn).toBe(true);
    expect(classifyResolver("9.9.9.9").isCn).toBe(false);
  });
});

describe("environment risk — font scanning", () => {
  let fontDir: string;
  beforeEach(() => {
    fontDir = path.join(TMP, "fonts");
    fs.mkdirSync(fontDir, { recursive: true });
    for (const f of ["simsun.ttc", "msyh.ttc", "Arial.ttf", "Helvetica.ttc", "PingFang.ttc"]) {
      fs.writeFileSync(path.join(fontDir, f), "");
    }
  });
  afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("detects Chinese fonts from filenames", () => {
    const found = scanSystemFonts([fontDir]);
    expect(found.some((n) => n.includes("SimSun"))).toBe(true);
    expect(found.some((n) => n.includes("YaHei"))).toBe(true);
    expect(found.some((n) => n.includes("PingFang"))).toBe(true);
    expect(found.some((n) => n.includes("Arial") || n.includes("Helvetica"))).toBe(false);
  });

  it("returns empty for an empty font dir", () => {
    const empty = path.join(TMP, "empty");
    fs.mkdirSync(empty, { recursive: true });
    expect(scanSystemFonts([empty])).toEqual([]);
  });

  it("classifies scanned CN font display names into leak-signal categories", () => {
    expect(classifyCnFontDisplayName("SimSun (宋体)")).toBe("windows-only");
    expect(classifyCnFontDisplayName("Microsoft YaHei (微软雅黑)")).toBe("windows-only");
    expect(classifyCnFontDisplayName("STHeiti (黑体-简)")).toBe("macos-universal");
    expect(classifyCnFontDisplayName("PingFang SC (苹方)")).toBe("macos-universal");
    expect(classifyCnFontDisplayName("Arial")).toBeNull();
  });
});

describe("environment risk — proxy DNS leak", () => {
  it("treats SOCKS5 as low risk under the managed bridge", () => {
    const r = proxyDnsLeak({ mode: "named", config: { type: "socks5", host: "1.2.3.4", port: 1080 } } as any);
    expect(r.dnsLeakRisk).toBe("low");
  });
  it("treats HTTP / socks5h as low risk", () => {
    expect(proxyDnsLeak({ mode: "named", config: { type: "http", host: "1.2.3.4", port: 8080 } } as any).dnsLeakRisk).toBe("low");
    expect(proxyDnsLeak({ mode: "named", config: { type: "socks5h", host: "1.2.3.4", port: 1080 } } as any).dnsLeakRisk).toBe("low");
  });
  it("treats direct connection as no-proxy isolation", () => {
    expect(proxyDnsLeak({ mode: "none", config: null } as any).dnsLeakRisk).toBe("none");
  });
});

describe("environment risk — rAF classification", () => {
  it("recognizes standard refresh rates", () => {
    expect(classifyRaf(16.67, 90).standard).toBe(true);
    expect(classifyRaf(16.67, 90).refreshHz).toBe(60);
    expect(classifyRaf(6.94, 120).refreshHz).toBe(144);
    expect(classifyRaf(6.94, 120).standard).toBe(true);
  });
  it("flags non-standard intervals", () => {
    const r = classifyRaf(9.2, 60);
    expect(r.standard).toBe(false);
    expect(r.refreshHz).not.toBe(60);
  });
  it("handles empty samples", () => {
    const r = classifyRaf(0, 0);
    expect(r.samples).toBe(0);
    expect(r.standard).toBe(false);
  });
});

describe("environment risk — assembled findings", () => {
  it("flags CN resolver + CN fonts for a non-CN profile on direct connection", () => {
    const res = checkEnvironmentRisk(
      { locale: "en-US", timezone: "America/New_York", platform: "windows" },
      {
        resolvers: ["223.5.5.5", "8.8.8.8"],
        fontDirs: [path.join(TMP, "cnfonts")],
        hostLocale: "en-US",
        proxy: { mode: "none", config: null } as any,
      },
    );
    // prep a CN font fixture
    fs.mkdirSync(path.join(TMP, "cnfonts"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "cnfonts", "simsun.ttc"), "");
    const res2 = checkEnvironmentRisk(
      { locale: "en-US" },
      { resolvers: ["223.5.5.5", "8.8.8.8"], fontDirs: [path.join(TMP, "cnfonts")], hostLocale: "en-US", proxy: { mode: "none", config: null } as any },
    );
    expect(res2.findings.some((f) => f.code === "dns-resolver-leak" && f.severity === "high")).toBe(true);
    expect(res2.findings.some((f) => f.code === "cn-fonts-exposed" && f.severity === "high")).toBe(true);
    expect(res2.ok).toBe(false);
    void res;
  });

  it("downgrades CN resolver + CN fonts to info for a CN profile", () => {
    const res = checkEnvironmentRisk(
      { locale: "zh-CN", timezone: "Asia/Shanghai", platform: "windows" },
      { resolvers: ["223.5.5.5"], hostLocale: "zh-CN", proxy: { mode: "none", config: null } as any },
    );
    expect(res.findings.some((f) => f.code === "dns-resolver-cn-matches" && f.severity === "info")).toBe(true);
    expect(res.findings.some((f) => f.severity === "high")).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("flags a Chinese host locale for a non-CN profile as medium", () => {
    const res = checkEnvironmentRisk(
      { locale: "en-US" },
      { resolvers: ["8.8.8.8"], hostLocale: "zh-CN", proxy: { mode: "none", config: null } as any },
    );
    expect(res.findings.some((f) => f.code === "host-locale-leak" && f.severity === "medium")).toBe(true);
  });

  it("does NOT flag a CN host resolver as a leak when a managed proxy takes over DNS", () => {
    for (const type of ["http", "socks5h", "socks5"]) {
      const res = checkEnvironmentRisk(
        { locale: "en-US" },
        { resolvers: ["223.5.5.5"], hostLocale: "en-US", proxy: { mode: "named", config: { type, host: "1.2.3.4", port: 1080 } } as any },
      );
      expect(res.findings.some((f) => f.code === "dns-resolver-leak" && f.severity === "high")).toBe(false);
      expect(res.findings.some((f) => f.code === "dns-resolver-proxy-takeover" && f.severity === "info")).toBe(true);
      expect(res.ok).toBe(true);
    }
  });

  it("does NOT flag SOCKS5 as a proxy DNS leak on managed engines", () => {
    const res = checkEnvironmentRisk(
      { locale: "en-US" },
      { resolvers: ["8.8.8.8"], hostLocale: "en-US", proxy: { mode: "named", config: { type: "socks5", host: "1.2.3.4", port: 1080 } } as any },
    );
    expect(res.findings.some((f) => f.code === "proxy-dns-leak")).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("does NOT flag macOS-universal fonts on a macOS profile", () => {
    const fontDir = path.join(TMP, "macfonts");
    fs.mkdirSync(fontDir, { recursive: true });
    fs.writeFileSync(path.join(fontDir, "STHeiti Light.ttc"), "");
    const res = checkEnvironmentRisk(
      { locale: "en-US", platform: "macOS" },
      { resolvers: ["8.8.8.8"], fontDirs: [fontDir], hostLocale: "en-US", proxy: { mode: "none", config: null } as any },
    );
    expect(res.findings.some((f) => f.code === "cn-fonts-exposed" && f.severity === "high")).toBe(false);
    expect(res.findings.some((f) => f.code === "cn-fonts-macos-universal")).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("uses runtime font exposure evidence to clear a host-only false positive", () => {
    const fontDir = path.join(TMP, "winfonts");
    fs.mkdirSync(fontDir, { recursive: true });
    fs.writeFileSync(path.join(fontDir, "simsun.ttc"), "");
    const opts = { resolvers: ["8.8.8.8"], fontDirs: [fontDir], hostLocale: "en-US", proxy: { mode: "none", config: null } as any };
    // Static host scan says the font is installed -> high. Runtime evidence that
    // nothing is actually loadable clears it.
    const staticRes = checkEnvironmentRisk({ locale: "en-US", platform: "windows" }, opts);
    expect(staticRes.findings.some((f) => f.code === "cn-fonts-exposed" && f.severity === "high")).toBe(true);
    const runtimeRes = checkEnvironmentRisk({ locale: "en-US", platform: "windows" }, { ...opts, exposedFonts: [] });
    expect(runtimeRes.findings.some((f) => f.code === "cn-fonts-exposed" && f.severity === "high")).toBe(false);
    expect(runtimeRes.ok).toBe(true);
    // If the same font IS actually loadable, the high finding stays.
    const exposedRes = checkEnvironmentRisk({ locale: "en-US", platform: "windows" }, { ...opts, exposedFonts: ["SimSun"] });
    expect(exposedRes.findings.some((f) => f.code === "cn-fonts-exposed" && f.severity === "high")).toBe(true);
  });
});

describe("environment risk — launch gate helpers", () => {
  function sampleResult(high: boolean, medium = false): any {
    const findings: any[] = [];
    if (high) findings.push({ severity: "high", code: "cn-fonts-exposed", message: "x", fix: "y" });
    if (medium) findings.push({ severity: "medium", code: "host-locale-leak", message: "x", fix: "y" });
    return { ok: !high, findings };
  }

  it("shouldBlockEnvironmentRisk only when enabled and high findings exist", () => {
    expect(shouldBlockEnvironmentRisk(sampleResult(true), true)).toBe(true);
    expect(shouldBlockEnvironmentRisk(sampleResult(true), false)).toBe(false);
    expect(shouldBlockEnvironmentRisk(sampleResult(true), undefined)).toBe(false);
    expect(shouldBlockEnvironmentRisk(sampleResult(false, true), true)).toBe(false);
    expect(shouldBlockEnvironmentRisk(sampleResult(false), true)).toBe(false);
  });

  it("summarizeEnvFindings filters by severity and caps output", () => {
    const findings = [
      { severity: "high", code: "a" },
      { severity: "high", code: "b" },
      { severity: "medium", code: "c" },
      { severity: "info", code: "d" },
    ];
    expect(summarizeEnvFindings(findings)).toBe("a, b, c, d");
    expect(summarizeEnvFindings(findings, "high")).toBe("a, b");
    expect(summarizeEnvFindings(findings, "medium")).toBe("c");
    const many = Array.from({ length: 12 }, (_, i) => ({ severity: "high", code: "f" + i }));
    expect(summarizeEnvFindings(many)).toBe("f0, f1, f2, f3, f4, f5, f6, f7 (+4 more)");
  });
});
