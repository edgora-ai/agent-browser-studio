import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const h = vi.hoisted(() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "health-environment-")),
    evaluate: vi.fn(), status: vi.fn(),
    fonts: [] as string[], fontReadError: false, renameFailure: false, resolvers: ["1.1.1.1"],
  };
});
vi.mock("electron", () => ({ app: { getPath: () => h.root }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("node:dns", async (original) => ({ ...await original<typeof import("node:dns")>(), getServers: () => h.resolvers }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (directory: any, options?: any) => {
      if (/(?:^|[\\/])(?:fonts|\.fonts)(?:[\\/]|$)/i.test(String(directory))) {
        if (h.fontReadError) throw Object.assign(new Error("Owned font inventory unavailable"), { code: "EACCES" });
        return h.fonts.map((name) => ({ name, isDirectory: () => false, isFile: () => true }));
      }
      return (actual.readdirSync as any)(directory, options);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (h.renameFailure && String(to) === path.join(h.root, "config.json")) throw Object.assign(new Error("EIO: owned environment commit"), { code: "EIO" });
      actual.renameSync(from, to);
    },
  };
});
vi.mock("../../src/main/services/browser-manager.js", () => ({ statusBrowser: h.status }));
vi.mock("../../src/main/services/page-eval.js", () => ({ evaluateInPage: h.evaluate }));

import { getConfig, getConfigPath, getEnvRiskDiagnostics, reloadConfig, setProfileMeta } from "../../src/main/services/config-manager.js";
import { transact } from "../../src/main/services/config/store.js";
import { listProfileHealthHistory, runProfileEnvironmentRisk } from "../../src/main/services/profile-health.js";
import { checkEnvironmentRiskRuntime, measureRaf } from "../../src/main/services/environment-risk.js";
import { clearEntry, setEntry } from "../../src/main/services/browser/runtime-table.js";

const ID = "ab_health_environment";
const RAF = { samples: 60, median: 16.67, mean: 16.67 };
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
beforeEach(() => {
  h.renameFailure = false; h.fontReadError = false; h.fonts = []; h.resolvers = ["1.1.1.1"];
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  reloadConfig(); getConfig();
  transact((draft) => {
    draft.browserProfiles[ID] = { name: "Owned environment", engine: "firefox", fingerprintMode: "off", locale: "zh-CN", proxyMode: "none", updatedAt: 1 };
  });
  h.status.mockReset(); h.status.mockReturnValue({ running: true, pid: 123, cdpPort: 42002 });
  setEntry(ID, { pid: 123, process: null, port: 42002, lastActivityAt: 1, engine: "firefox",
    launchProxy: { mode: "none", source: "fresh-launch" } });
  h.evaluate.mockReset(); h.evaluate.mockResolvedValue(RAF);
});
afterEach(() => { h.renameFailure = false; clearEntry(ID); });
afterAll(() => {
  if (path.dirname(h.root) !== os.tmpdir() || !path.basename(h.root).startsWith("health-environment-")) throw new Error("Unsafe environment fixture cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("shared actual environment diagnostics", () => {
  it("uses the real engine and resolved proxy, atomically persists details and summary, then reloads and searches", async () => {
    transact((draft) => { draft.proxies.owned = { type: "http", host: "127.0.0.1", port: 42003 }; });
    setProfileMeta(ID, { proxyMode: "named", proxyName: "owned" });
    setEntry(ID, { pid: 123, process: null, port: 42002, lastActivityAt: 1, engine: "firefox",
      launchProxy: { mode: "named", type: "http", source: "fresh-launch" } });
    const result = await runProfileEnvironmentRisk(ID, { requestId: "environment-business-value", owner: "rest:owned" });
    expect(result.ok).toBe(true); expect(result.outcome).toBe("pass");
    expect(result.result?.proxy).toMatchObject({ mode: "named", type: "http" });
    expect(h.evaluate).toHaveBeenCalledWith(42002, "firefox", expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const saved = disk();
    expect(saved.envRiskDiagnostics[ID].at(-1)).toMatchObject({ requestId: "environment-business-value", source: "runtime", outcome: "pass" });
    expect(saved.profileHealthHistory[ID].at(-1)).toMatchObject({ requestId: "environment-business-value", source: "runtime", outcome: "pass" });
    expect(saved.browserProfiles[ID].syncBaseline).toBeUndefined();
    reloadConfig();
    expect(getEnvRiskDiagnostics(ID).find((entry) => entry.requestId === "environment-business-value")?.outcome).toBe("pass");
    expect(listProfileHealthHistory(ID).find((entry) => entry.requestId === "environment-business-value")?.source).toBe("runtime");
  });

  it("does not substitute an edited proxy configuration for the running process's direct route", async () => {
    h.resolvers = ["223.5.5.5"];
    setProfileMeta(ID, { locale: "en-US" });
    transact((draft) => { draft.proxies.owned = { type: "http", host: "127.0.0.1", port: 42003 }; });
    setProfileMeta(ID, { proxyMode: "named", proxyName: "owned" });
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.result?.proxy.mode).toBe("none");
    expect(result.result?.findings.some((finding) => finding.code === "dns-resolver-leak")).toBe(true);
    expect(result.outcome).toBe("risk");
  });

  it("leaves the launch proxy unverified for an adopted process without a snapshot", async () => {
    setEntry(ID, { pid: 123, process: null, port: 42002, lastActivityAt: 1, engine: "firefox" });
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.result?.proxy.mode).toBe("unknown");
    expect(result.outcome).toBe("inconclusive");
  });

  it("invalidates a late result when the runtime entry changes even if PID and port match", async () => {
    let finish!: (value: typeof RAF) => void;
    h.evaluate.mockReturnValue(new Promise<typeof RAF>((resolve) => { finish = resolve; }));
    const operation = runProfileEnvironmentRisk(ID);
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledTimes(1));
    setEntry(ID, { pid: 123, process: null, port: 42002, lastActivityAt: 2, engine: "firefox",
      launchProxy: { mode: "none", source: "fresh-launch" } });
    finish(RAF);
    expect((await operation).code).toBe("HEALTH_PROFILE_CHANGED");
    expect(disk().envRiskDiagnostics?.[ID] || []).toEqual([]);
  });

  it("keeps a stopped-browser host-only result inconclusive rather than healthy", async () => {
    h.status.mockReturnValue({ running: false, pid: null, cdpPort: null });
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.ok).toBe(false); expect(result.outcome).toBe("inconclusive");
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(disk().profileHealthHistory[ID].at(-1).source).toBe("host");
  });

  it("makes failed rAF sampling explicit instead of certifying a clean environment", async () => {
    h.evaluate.mockRejectedValue(new Error("Owned frame probe failed"));
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.ok).toBe(false); expect(result.outcome).toBe("inconclusive");
    expect(result.result?.raf).toBeNull();
    expect(result.result?.measurements?.raf).toBe("unavailable");
    expect(result.result?.findings.some((entry) => entry.code === "raf-unavailable")).toBe(true);
    expect(disk().envRiskDiagnostics[ID].at(-1).outcome).toBe("inconclusive");
  });

  it("does not rewrite nonstandard measured timing to pass", async () => {
    h.evaluate.mockResolvedValue({ samples: 60, median: 25.5, mean: 25.5 });
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.outcome).toBe("warn");
    expect(result.result?.raf?.medianMs).toBe(25.5);
    expect(result.result?.raf?.standard).toBe(false);
    expect(result.result?.findings.some((entry) => entry.code === "raf-non-standard")).toBe(true);
  });

  it("does not treat a failed font scan as proof of an empty host inventory", async () => {
    h.fontReadError = true;
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.outcome).toBe("inconclusive");
    expect(result.result?.measurements?.fonts).toBe("unavailable");
    expect(result.result?.findings.some((entry) => entry.code === "font-scan-unavailable")).toBe(true);
  });

  it("does not call a failed font exposure probe observed runtime exposure", async () => {
    h.fonts = ["simsun.ttc"];
    h.evaluate.mockImplementation(async (_port, _engine, expression) => {
      if (expression.includes("document.createElement")) throw new Error("Owned font probe failed");
      return RAF;
    });
    const result = await checkEnvironmentRiskRuntime({ locale: "en-US", platform: "windows" }, 42002,
      { proxy: { mode: "none", config: null }, hostLocale: "en-US", resolvers: ["1.1.1.1"] }, "firefox");
    expect(result.measurements?.fonts).toBe("unavailable");
    expect(result.findings.some((entry) => entry.code === "font-probe-unavailable")).toBe(true);
    const staticFinding = result.findings.find((entry) => entry.code === "cn-fonts-exposed");
    expect(staticFinding).toBeDefined();
    expect(staticFinding?.message).not.toContain("且实测");
  });

  it("requires a boolean for every requested font before calling the exposure probe complete", async () => {
    h.fonts = ["simsun.ttc"];
    h.evaluate.mockImplementation(async (_port, _engine, expression) => expression.includes("document.createElement") ? { SimSun: false } : RAF);
    const result = await checkEnvironmentRiskRuntime({ locale: "en-US", platform: "windows" }, 42002,
      { proxy: { mode: "none", config: null }, hostLocale: "en-US", resolvers: ["1.1.1.1"] }, "firefox");
    expect(result.measurements?.fonts).toBe("unavailable");
  });

  it("allows complete negative font evidence without retaining an exposed-font claim", async () => {
    h.fonts = ["simsun.ttc"];
    h.evaluate.mockImplementation(async (_port, _engine, expression) => expression.includes("document.createElement") ? { SimSun: false, NSimSun: false } : RAF);
    const result = await checkEnvironmentRiskRuntime({ locale: "en-US", platform: "windows" }, 42002,
      { proxy: { mode: "none", config: null }, hostLocale: "en-US", resolvers: ["1.1.1.1"] }, "firefox");
    expect(result.measurements?.fonts).toBe("complete");
    expect(result.findings.some((entry) => entry.code === "cn-fonts-exposed")).toBe(false);
  });

  it.each([{ samples: 3, median: 16.67 }, { samples: -1, median: 16.67, mean: 16.67 }, { samples: 300, median: 16.67, mean: 16.67 }, { samples: 3, median: 0, mean: 16.67 }])("does not synthesize valid timing from malformed measurement %j", async (value) => {
    h.evaluate.mockResolvedValue(value);
    expect(await measureRaf(42002, "firefox")).toBeNull();
  });

  it("does not leave a summary-only or detail-only update when configuration rename fails", async () => {
    const original = fs.readFileSync(getConfigPath()); h.renameFailure = true;
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.ok).toBe(false); expect(result.error).toContain("owned environment commit");
    expect(fs.readFileSync(getConfigPath())).toEqual(original);
    expect(getEnvRiskDiagnostics(ID)).toEqual([]); expect(listProfileHealthHistory(ID)).toEqual([]);
    h.renameFailure = false; reloadConfig();
    expect(getEnvRiskDiagnostics(ID)).toEqual([]); expect(listProfileHealthHistory(ID)).toEqual([]);
  });

  it("does not label observed macOS font exposure as confirmed isolation on Windows", async () => {
    h.fonts = ["PingFang.ttc"];
    h.evaluate.mockImplementation(async (_port, _engine, expression) => expression.includes("document.createElement") ? { "PingFang SC": true } : RAF);
    const result = await checkEnvironmentRiskRuntime({ locale: "en-US", platform: "windows" }, 42002,
      { proxy: { mode: "none", config: null }, hostLocale: "en-US", resolvers: ["1.1.1.1"] }, "firefox");
    expect(result.findings.some((entry) => entry.severity === "medium" && entry.code === "font-platform-mismatch")).toBe(true);
    expect(result.findings.some((entry) => entry.message.includes("实测确认不可加载"))).toBe(false);
  });

  it.each(["127.0.0.53", "192.168.1.1", "9.8.7.6"])("does not infer an upstream resolver identity from %s", async (address) => {
    h.resolvers = [address];
    const result = await runProfileEnvironmentRisk(ID);
    expect(result.outcome).toBe("inconclusive");
    expect(result.result?.findings.some((entry) => entry.code === "dns-resolver-unknown")).toBe(true);
  });
});
