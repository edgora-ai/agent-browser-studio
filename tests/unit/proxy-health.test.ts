// Unit tests for proxy health tracking (score / risk / drift / cooldown / bindings).
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-proxy-health-test");

vi.mock("electron", () => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const TEST_DATA = nodePath.join(nodeOs.tmpdir(), "agent-browser-proxy-health-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        return "/tmp";
      },
    },
  };
});

import { addProxy, reloadConfig, saveConfig, getConfig } from "../../src/main/services/config-manager.js";
import {
  recordProxyDetection,
  computeScore,
  riskFromScore,
  listProxyHealth,
  clearProxyHealth,
  proxyHealthSummary,
  computeBindings,
} from "../../src/main/services/proxy-health.js";

const BASE = {
  success: true,
  exitIp: "1.2.3.4",
  countryCode: "US",
  timezone: "America/New_York",
  provider: "test",
  latencyMs: 120,
  isp: "Test ISP",
  org: "Test Org",
  as: "AS123",
  error: null,
};

describe("proxy health", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    addProxy("p1", { type: "http", host: "127.0.0.1", port: 7890 });
    addProxy("p2", { type: "http", host: "127.0.0.1", port: 7891 });
  });

  it("records a successful detection", () => {
    const entry = recordProxyDetection("p1", BASE);
    expect(entry.checks).toBe(1);
    expect(entry.successes).toBe(1);
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.distinctExitIps).toEqual(["1.2.3.4"]);
    expect(entry.lastSuccessAt).toBeTruthy();
    expect(entry.avgLatencyMs).toBe(120);
    expect(entry.score).toBeGreaterThanOrEqual(80);
    expect(entry.risk).toBe("good");
    expect(entry.suggestion).toContain("状态良好");
  });

  it("accumulates failures and enters cooldown after 3 consecutive failures", () => {
    for (let i = 0; i < 3; i++) {
      recordProxyDetection("p1", { success: false, error: "timeout" });
    }
    let entry = listProxyHealth().find((e) => e.proxyName === "p1");
    expect(entry?.consecutiveFailures).toBe(3);
    expect(entry?.cooldownUntil).toBeTruthy();
    expect(entry?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(entry?.risk).toBe("poor");
    expect(entry?.suggestion).toContain("冷却");
    // a success clears the cooldown
    recordProxyDetection("p1", BASE);
    entry = listProxyHealth().find((e) => e.proxyName === "p1");
    expect(entry?.consecutiveFailures).toBe(0);
    expect(entry?.cooldownUntil).toBeNull();
  });

  it("detects exit-IP and geo drift across successes", () => {
    recordProxyDetection("p1", BASE);
    const e2 = recordProxyDetection("p1", { ...BASE, exitIp: "5.6.7.8" });
    expect(e2.ipDriftCount).toBe(1);
    expect(e2.distinctExitIps).toEqual(["1.2.3.4", "5.6.7.8"]);
    const e3 = recordProxyDetection("p1", { ...BASE, exitIp: "9.9.9.9", countryCode: "DE" });
    expect(e3.ipDriftCount).toBe(2);
    expect(e3.geoDriftCount).toBe(1);
    expect(e3.suggestion).toContain("漂移");
  });

  it("keeps history capped at 20 points while counting every check", () => {
    for (let i = 0; i < 25; i++) {
      recordProxyDetection("p1", { ...BASE, exitIp: `10.0.0.${i % 5}` });
    }
    const entry = listProxyHealth().find((e) => e.proxyName === "p1");
    expect(entry?.history.length).toBe(20);
    expect(entry?.checks).toBe(25);
  });

  it("computes bindings from named and default profile routing", () => {
    const cfg = getConfig();
    const now = Date.now();
    cfg.browserProfiles["prof_a"] = { name: "A", proxyMode: "named", proxyName: "p1", fingerprintSeed: 1, platform: "windows", syncedAt: null, syncStatus: "never", lastModified: now };
    cfg.browserProfiles["prof_b"] = { name: "B", proxyMode: "default", proxyName: null, fingerprintSeed: 2, platform: "macos", syncedAt: null, syncStatus: "never", lastModified: now };
    cfg.defaultProxy = "p2";
    saveConfig(cfg);
    const p1Bindings = computeBindings("p1");
    expect(p1Bindings).toEqual(["prof_a"]);
    const p2Bindings = computeBindings("p2");
    expect(p2Bindings).toEqual(["prof_b (默认)"]);
  });

  it("clears health for one proxy or all", () => {
    recordProxyDetection("p1", BASE);
    recordProxyDetection("p2", BASE);
    expect(listProxyHealth().length).toBe(2);
    expect(clearProxyHealth("p1")).toBe(1);
    expect(listProxyHealth().length).toBe(1);
    expect(clearProxyHealth()).toBe(1);
    expect(listProxyHealth().length).toBe(0);
  });

  it("summarizes risk buckets without leaking config", () => {
    recordProxyDetection("p1", BASE);
    recordProxyDetection("p2", { success: false, error: "x" });
    recordProxyDetection("p2", { success: false, error: "x" });
    const s = proxyHealthSummary();
    expect(s.total).toBe(2);
    expect(s.good).toBe(1);
    expect(s.poor).toBe(1);
    expect(s.inCooldown).toBe(0);
    expect(s.lastCheckedAt).toBeTruthy();
  });

  it("bounds scores and applies risk thresholds", () => {
    expect(riskFromScore(100)).toBe("good");
    expect(riskFromScore(80)).toBe("good");
    expect(riskFromScore(79)).toBe("watch");
    expect(riskFromScore(55)).toBe("watch");
    expect(riskFromScore(54)).toBe("poor");
    expect(riskFromScore(0)).toBe("poor");
    const fresh = { checks: 1, successes: 1, avgLatencyMs: 120, ipDriftCount: 0, geoDriftCount: 0, lastCheckedAt: Date.now() };
    expect(computeScore(fresh)).toBeGreaterThanOrEqual(80);
  });

  it("suggests a non-IDC exit when the proxy is a hosting/IDC IP (Slice 73)", () => {
    recordProxyDetection("p1", { ...BASE, hosting: true, isProxy: false, org: "Oracle Corporation", as: "AS31898" });
    const entries = listProxyHealth();
    const p1 = entries.find((e) => e.proxyName === "p1");
    expect(p1).toBeTruthy();
    expect(p1!.history[0].hosting).toBe(true);
    expect(p1!.suggestion).toContain("机房/IDC");
    expect(p1!.suggestion).toContain("Oracle Corporation");
  });

  it("records the public-proxy flag in history without an IDC suggestion (Slice 73)", () => {
    recordProxyDetection("p1", { ...BASE, hosting: false, isProxy: true });
    const p1 = listProxyHealth().find((e) => e.proxyName === "p1");
    expect(p1!.history[0].isProxy).toBe(true);
    expect(p1!.history[0].hosting).toBe(false);
    expect(p1!.suggestion).not.toContain("机房/IDC");
  });
});
