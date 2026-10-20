import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  config: { browserProfiles: {} as Record<string, any> },
  status: vi.fn(), launch: vi.fn(), launchGate: vi.fn(), role: vi.fn(), safeUrl: vi.fn(),
  connect: vi.fn(), navigate: vi.fn(), wait: vi.fn(), disconnect: vi.fn(),
}));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: any) => h.handlers.set(name, handler) }, BrowserWindow: {} }));
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: h.status, launchBrowser: h.launch,
  stopBrowser: vi.fn(), listBrowserProfiles: vi.fn(), checkFingerprintDrift: vi.fn(),
  getRuntimeChromiumStatusAsync: vi.fn(), verifyRuntimeChromiumAsync: vi.fn(), getEngineStatusAsync: vi.fn(),
  getProfileRuntimeSnapshot: vi.fn(), createBrowserProfile: vi.fn(), deleteBrowserProfile: vi.fn(), getLaunchLogPath: vi.fn(),
}));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => h.config, saveConfig: vi.fn(), setProfileMeta: vi.fn(), assertProfileWritable: vi.fn(),
  resolveProfileProxy: vi.fn(), getProxyDetection: vi.fn(), getEnvRiskDiagnostics: vi.fn(),
}));
vi.mock("../../src/main/services/local-agent.js", () => ({
  cdpConnect: h.connect, cdpNavigate: h.navigate, cdpWaitForLoad: h.wait, cdpDisconnect: h.disconnect,
  assertSafeNavigationUrl: h.safeUrl,
}));
vi.mock("../../src/main/services/agent/cdp-transport.js", () => ({
  cdpConnect: h.connect, cdpNavigate: h.navigate, cdpWaitForLoad: h.wait, cdpDisconnect: h.disconnect,
}));
vi.mock("../../src/main/services/license.js", () => ({ checkLaunchAllowed: h.launchGate, checkCreateAllowed: vi.fn() }));
vi.mock("../../src/main/services/team.js", () => ({ requireProfileMutation: h.role }));
vi.mock("../../src/main/services/audit-log.js", () => ({ listAudit: vi.fn(), recordAudit: vi.fn() }));
vi.mock("../../src/main/services/consistency-check.js", () => ({ checkProfileConsistency: vi.fn() }));
vi.mock("../../src/main/services/fingerprint-baseline.js", () => ({
  captureFingerprint: vi.fn(), diffFingerprints: vi.fn(), hasRiskyDrift: vi.fn(), checkPersonaConsistency: vi.fn(), mismatchesAsDrift: vi.fn(), sanitizePortableFingerprintBaseline: vi.fn(),
}));
vi.mock("../../src/main/services/profile-health.js", () => ({
  beginProfileHealthRun: vi.fn(), cancelProfileHealthRun: vi.fn(), clearProfileHealthHistory: vi.fn(), listProfileHealthHistory: vi.fn(),
  profileHealthFailure: vi.fn(), recordProfileHealthResult: vi.fn(), runProfileEnvironmentRisk: vi.fn(),
}));
vi.mock("../../src/main/services/bulk-import.js", () => ({ parseBulkCsv: vi.fn() }));
vi.mock("../../src/main/services/business-presets.js", () => ({ listBusinessPresets: vi.fn(), resolveBusinessPreset: vi.fn(), presetProfileToCreateOpts: vi.fn() }));

import { registerBrowserHandlers } from "../../src/main/ipc/browser.js";
import { navigateInPage } from "../../src/main/services/page-eval.js";
import { runningProcesses, type RunningEntry } from "../../src/main/services/browser/runtime-table.js";
import { registerFirefoxSession, dropFirefoxSession, type BidiConnection } from "../../src/main/services/bidi-client.js";
import { BrowserLoadTimeoutError } from "../../src/main/services/agent/cdp-navigation-errors.js";

registerBrowserHandlers();
const ID = "ab_navigation_ipc";
const PORT = 42083;
const DESTINATION = "https://open-navigation.fixture.test/app";
function owner() { return Object.assign(new EventEmitter(), { id: 83, isDestroyed: vi.fn(() => false) }); }
function runtime(engine: "chromium" | "firefox" = "chromium", bidiConn?: BidiConnection) {
  const entry: RunningEntry = { pid: process.pid, process: null, port: PORT, lastActivityAt: 1, engine, ...(bidiConn ? { bidiConn } : {}) };
  runningProcesses.set(ID, entry);
  return entry;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function session() {
  const connection: BidiConnection = {
    wsUrl: `ws://127.0.0.1:${PORT}/session`, closed: false, close: vi.fn(),
    send: vi.fn(async (method: string) => {
      if (method === "browsingContext.getTree") return { contexts: [{ context: "real-firefox-context" }] };
      if (method === "browsingContext.navigate") return { navigation: "firefox-navigation", url: DESTINATION };
      throw new Error(`Unexpected navigation fixture command ${method}`);
    }),
  };
  registerFirefoxSession(PORT, connection);
  return connection;
}
const invoke = (channel: string, sender = owner(), params: any = {}) => h.handlers.get(channel)!({ sender }, { dirId: ID, ...params });

beforeEach(() => {
  vi.resetAllMocks(); runningProcesses.clear(); dropFirefoxSession(PORT);
  h.config.browserProfiles = { [ID]: { engine: "chromium", appUrl: DESTINATION } };
  h.status.mockImplementation(() => ({ running: runningProcesses.has(ID), cdpPort: runningProcesses.get(ID)?.port }));
  h.launchGate.mockReturnValue({ allowed: true }); h.role.mockReturnValue({ ok: true });
  h.launch.mockRejectedValue(new Error("Unrequested fixture launch"));
  h.safeUrl.mockImplementation(async (url) => url);
  h.connect.mockImplementation(async (port) => ({ port, ws: { close: vi.fn() } }));
  h.navigate.mockResolvedValue({ frameId: "root", loaderId: "loader" }); h.wait.mockResolvedValue(undefined);
});
afterEach(() => { dropFirefoxSession(PORT); runningProcesses.clear(); });

describe("navigateInPage retains one engine router and an additive full-load contract", () => {
  it("does not finish a requested Chromium load until cdpWaitForLoad actually completes", async () => {
    const held = deferred(); h.wait.mockReturnValue(held.promise);
    let finished = false;
    const operation = navigateInPage(PORT, "chromium", DESTINATION, { timeoutMs: 300, waitForLoad: true } as any).then(() => { finished = true; });
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1));
    expect(h.wait).toHaveBeenCalledTimes(1); expect(finished).toBe(false);
    held.resolve(); await operation;
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the default helper acceptance-only and preserves typed full-load timeout failures", async () => {
    await navigateInPage(PORT, "chromium", DESTINATION);
    expect(h.wait).not.toHaveBeenCalled();
    h.wait.mockRejectedValue(new BrowserLoadTimeoutError());
    await expect(navigateInPage(PORT, "chromium", DESTINATION, { waitForLoad: true } as any)).rejects.toBeInstanceOf(BrowserLoadTimeoutError);
    expect(h.disconnect).toHaveBeenCalledTimes(2);
  });

  it("requests Firefox complete readiness on the borrowed session without any CDP or independent session", async () => {
    const live = session();
    await navigateInPage(PORT, "firefox", DESTINATION, { timeoutMs: 300, waitForLoad: true } as any);
    expect(live.send).toHaveBeenCalledWith("browsingContext.navigate", { context: "real-firefox-context", url: DESTINATION, wait: "complete" }, expect.any(Number), expect.any(AbortSignal));
    expect(live.close).not.toHaveBeenCalled(); expect(h.connect).not.toHaveBeenCalled();
  });

  it("bounds Chromium preparation and cleans up a connection that arrives after the caller deadline", async () => {
    const held = deferred<any>(); h.connect.mockReturnValue(held.promise);
    const operation = navigateInPage(PORT, "chromium", DESTINATION, { timeoutMs: 25, waitForLoad: true } as any);
    await expect(operation).rejects.toMatchObject({ code: "BROWSER_LOAD_TIMEOUT" });
    const late = { port: PORT, ws: { close: vi.fn() } }; held.resolve(late);
    await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalledWith(late));
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe("real browser open handlers and aliases bind navigation to runtime and sender", () => {
  it.each(["browser:open-risk-check", "cloak:open-risk-check", "browser:open-app", "cloak:open-app"])("%s uses the running Firefox engine even after saved intent changes", async (channel) => {
    const live = session(); runtime("firefox", live);
    const sender = owner();
    expect(await invoke(channel, sender, { url: DESTINATION })).toMatchObject({ success: true });
    expect(live.send).toHaveBeenCalledWith("browsingContext.navigate", { context: "real-firefox-context", url: DESTINATION, wait: "complete" }, expect.any(Number), expect.any(AbortSignal));
    expect(live.close).not.toHaveBeenCalled(); expect(h.connect).not.toHaveBeenCalled();
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it.each(["browser:open-risk-check", "browser:open-app"])("%s reports real load timeout rather than navigation acceptance", async (channel) => {
    runtime(); h.wait.mockRejectedValue(new BrowserLoadTimeoutError());
    expect(await invoke(channel)).toMatchObject({ success: false, error: expect.stringContaining("deadline") });
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["browser:open-risk-check", "browser:open-app"])("%s rejects current runtime replacement during load", async (channel) => {
    runtime(); const held = deferred(); h.wait.mockReturnValue(held.promise);
    const sender = owner(); const pending = invoke(channel, sender);
    await vi.waitFor(() => expect(h.wait).toHaveBeenCalledTimes(1));
    runtime(); held.resolve();
    expect(await pending).toMatchObject({ success: false, error: expect.stringMatching(/replaced|instance/i) });
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it.each(["browser:open-risk-check", "browser:open-app"])("%s cancels on sender destruction and never closes a borrowed Firefox session", async (channel) => {
    const live = session(); runtime("firefox", live);
    const held = deferred<any>();
    (live.send as any).mockImplementation(async (method: string) => method === "browsingContext.getTree" ? { contexts: [{ context: "real-firefox-context" }] } : held.promise);
    const sender = owner(); const pending = invoke(channel, sender);
    await vi.waitFor(() => expect((live.send as any).mock.calls.some((call: any[]) => call[0] === "browsingContext.navigate")).toBe(true));
    sender.isDestroyed.mockReturnValue(true); sender.emit("destroyed");
    const result = await pending;
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/cancel|abort|owner|destroy/i) });
    expect(live.close).not.toHaveBeenCalled(); expect(sender.listenerCount("destroyed")).toBe(0);
    held.resolve({ navigation: "late" });
  });

  it("preserves explicit risk-check launch consent and both license/team launch gates", async () => {
    expect(await invoke("browser:open-risk-check")).toMatchObject({ success: false, code: "PROFILE_NOT_RUNNING" });
    expect(h.launch).not.toHaveBeenCalled();
    h.role.mockReturnValue({ ok: false, error: "requires member role" });
    expect(await invoke("browser:open-app")).toMatchObject({ success: false, error: expect.stringContaining("requires member") });
    h.role.mockReturnValue({ ok: true }); h.launchGate.mockReturnValue({ allowed: false, code: "LICENSE_EXPIRED", error: "fixture expired" });
    for (const channel of ["browser:open-risk-check", "browser:open-app"]) {
      expect(await invoke(channel, owner(), { allowLaunch: true })).toMatchObject({ success: false, code: "LICENSE_EXPIRED" });
    }
    expect(h.launch).not.toHaveBeenCalled(); expect(h.connect).not.toHaveBeenCalled();
  });

  it("retains URL refusal before launch or navigation", async () => {
    h.safeUrl.mockRejectedValue(new Error("fixture unsafe destination"));
    for (const channel of ["browser:open-risk-check", "browser:open-app"]) expect(await invoke(channel)).toMatchObject({ success: false, error: expect.stringContaining("unsafe") });
    expect(h.connect).not.toHaveBeenCalled(); expect(h.launch).not.toHaveBeenCalled();
  });
});
