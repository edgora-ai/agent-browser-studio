import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyResolver, scanSystemFonts, proxyDnsLeak, classifyRaf,
  checkEnvironmentRisk,
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
});

describe("environment risk — proxy DNS leak", () => {
  it("flags SOCKS5 as high risk", () => {
    const r = proxyDnsLeak({ mode: "named", config: { type: "socks5", host: "1.2.3.4", port: 1080 } } as any);
    expect(r.dnsLeakRisk).toBe("high");
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
  it("flags CN resolver + CN fonts + SOCKS5 for a non-CN profile", () => {
    const res = checkEnvironmentRisk(
      { locale: "en-US", timezone: "America/New_York", platform: "windows" },
      {
        resolvers: ["223.5.5.5", "8.8.8.8"],
        fontDirs: [path.join(TMP, "cnfonts")],
        hostLocale: "en-US",
        proxy: { mode: "named", config: { type: "socks5", host: "1.2.3.4", port: 1080 } } as any,
      },
    );
    // prep a CN font fixture
    fs.mkdirSync(path.join(TMP, "cnfonts"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "cnfonts", "simsun.ttc"), "");
    const res2 = checkEnvironmentRisk(
      { locale: "en-US" },
      { resolvers: ["223.5.5.5", "8.8.8.8"], fontDirs: [path.join(TMP, "cnfonts")], hostLocale: "en-US", proxy: { mode: "named", config: { type: "socks5", host: "1.2.3.4", port: 1080 } } as any },
    );
    expect(res2.findings.some((f) => f.code === "dns-resolver-leak" && f.severity === "high")).toBe(true);
    expect(res2.findings.some((f) => f.code === "cn-fonts-exposed" && f.severity === "high")).toBe(true);
    expect(res2.findings.some((f) => f.code === "proxy-dns-leak" && f.severity === "high")).toBe(true);
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
});
