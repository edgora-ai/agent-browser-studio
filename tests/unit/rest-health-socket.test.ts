// The production health coordinator and disk history are real. Only individual
// host/runtime measurements are synthetic; no host fonts/DNS/CDP are probed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { h, startFixture } from "./rest-mcp-socket-helper.js";
import { setEntry, clearEntry } from "../../src/main/services/browser/runtime-table.js";

let f: Awaited<ReturnType<typeof startFixture>>;
const dirId = "ab_task48_health";
function measured(overrides: any = {}) { return {
  ok: true, hostPlatform: "darwin", hostLocale: "en-US", resolvers: [{ address: "192.0.2.53", isCn: false }], cnFonts: [],
  proxy: { mode: "none", dnsLeakRisk: "none", note: "Synthetic direct connection" },
  raf: { samples: 5, medianMs: 16.67, meanMs: 16.67, refreshHz: 60, standard: true }, findings: [], ...overrides,
}; }
beforeAll(async () => { f = await startFixture("rest"); });
afterAll(async () => { await f?.close(); });
afterEach(() => { clearEntry(dirId); });
beforeEach(() => {
  clearEntry(dirId);
  vi.clearAllMocks();
  f.store.transact((draft: any) => { delete draft.team; draft.browserProfiles = { [dirId]: { name: "Synthetic health target", engine: "firefox", proxyMode: "none" } }; delete draft.profileHealthHistory; delete draft.envRiskDiagnostics; });
  h.browser.statusBrowser.mockReturnValue({ running: false });
  h.environment.checkEnvironmentRisk.mockReturnValue(measured({ raf: null }));
});

describe("REST environment diagnostics reuse the production shared health coordinator", () => {
  it("preserves static inconclusive result and persists source/request identity before reload/read", async () => {
    const r = await f.api(`/api/profiles/${dirId}/env-risk`);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, outcome: "inconclusive", raf: null });
    expect(r.body.requestId).toEqual(expect.any(String));
    expect(f.disk().profileHealthHistory[dirId].at(-1)).toMatchObject({ kind: "env", outcome: "inconclusive", source: "host", requestId: r.body.requestId });
    expect(f.disk().envRiskDiagnostics[dirId].at(-1).outcome).toBe("inconclusive");
    f.config.reloadConfig(); expect(f.config.getProfileHealthHistory(dirId).at(-1)?.requestId).toBe(r.body.requestId);
    expect(h.environment.checkEnvironmentRisk).toHaveBeenCalledWith(expect.any(Object), { proxy: expect.objectContaining({ mode: "none" }) });
  });
  it("uses the matching fresh-launch engine/proxy snapshot rather than current config and keeps completed risk at HTTP 200", async () => {
    f.config.addProxy("synthetic-health-proxy", { type: "socks5", host: "proxy.synthetic.invalid", port: 1080, username: "private-user", password: "private-password" });
    f.config.setProfileProxy(dirId, "synthetic-health-proxy", "named");
    f.store.transact((draft: any) => { draft.browserProfiles[dirId].engine = "chromium"; });
    h.browser.statusBrowser.mockReturnValue({ running: true, pid: 101, cdpPort: 12345 });
    setEntry(dirId, { pid: 101, port: 12345, process: null, lastActivityAt: Date.now(), engine: "firefox", launchProxy: { mode: "named", type: "http", source: "fresh-launch" } });
    const risk = measured({ ok: false, proxy: { mode: "named", type: "http", dnsLeakRisk: "low", note: "Synthetic fresh-launch route" }, findings: [{ severity: "high", code: "synthetic-risk", message: "Synthetic high risk", fix: "Synthetic mitigation" }] });
    h.environment.checkEnvironmentRiskRuntime.mockResolvedValueOnce(risk);
    const r = await f.api(`/api/profiles/${dirId}/env-risk`);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: false, outcome: "risk", findings: risk.findings, proxy: { source: "fresh-launch" } });
    const args = h.environment.checkEnvironmentRiskRuntime.mock.calls[0];
    expect(args[1]).toBe(12345); expect(args[2]).toMatchObject({ proxy: { mode: "named", config: { type: "http" } }, signal: expect.any(AbortSignal) }); expect(args[3]).toBe("firefox");
    expect(args[2].proxy).not.toHaveProperty("name");
    expect(f.disk().profileHealthHistory[dirId].at(-1).source).toBe("runtime"); expect(r.text).not.toContain("private-password"); expect(r.text).not.toContain("private-user");
  });
  it.each(["missing", "adopted"])("%s runtime evidence stays unknown/inconclusive and never substitutes current configured proxy", async kind => {
    f.config.addProxy("configured-only", { type: "socks5", host: "configured.synthetic.invalid", port: 1080 });
    f.config.setProfileProxy(dirId, "configured-only", "named");
    h.browser.statusBrowser.mockReturnValue({ running: true, pid: 101, cdpPort: 12345 });
    if (kind === "adopted") setEntry(dirId, { pid: 101, port: 12345, process: null, lastActivityAt: Date.now(), engine: "firefox" });
    h.environment.checkEnvironmentRiskRuntime.mockImplementationOnce(async (_profile: any, _port: number, options: any) => {
      expect(options.proxy).toBeNull();
      return measured({ proxy: { mode: "unknown", dnsLeakRisk: "high", note: "No observed launch receipt" } });
    });
    const response = await f.api(`/api/profiles/${dirId}/env-risk`);
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ outcome: "inconclusive", proxy: { mode: "unknown", source: "unknown" } });
    expect(response.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "runtime-proxy-unavailable" })]));
    expect(f.disk().profileHealthHistory[dirId].at(-1).outcome).toBe("inconclusive"); f.config.reloadConfig();
    expect(f.config.getProfileHealthHistory(dirId).at(-1)?.outcome).toBe("inconclusive");
  });
  it("returns typed missing-target failure instead of dropping the health failure facts", async () => {
    const before = f.bytes(); const missing = await f.api("/api/profiles/ab_health_missing/env-risk");
    expect(missing.status).toBe(404); expect(missing.body).toMatchObject({ ok: false, outcome: "error", code: "PROFILE_NOT_FOUND" }); expect(f.bytes()).toEqual(before);
  });
  it("cancels only this request's in-flight probe on socket disconnect and never persists late results", async () => {
    h.browser.statusBrowser.mockReturnValue({ running: true, pid: 101, cdpPort: 12345 });
    let armed!: () => void, release!: (result: any) => void;
    const ready = new Promise<void>(resolve => { armed = resolve; }); let signal: AbortSignal | undefined;
    h.environment.checkEnvironmentRiskRuntime.mockImplementationOnce((_profile: any, _port: number, options: any) => {
      signal = options.signal; armed(); return new Promise(resolve => { release = resolve; });
    });
    const req = http.request({ host: "127.0.0.1", port: f.restPort, path: `/api/profiles/${dirId}/env-risk`, agent: false,
      headers: { Authorization: `Bearer ${f.rest!.getRestApiToken()}` } });
    req.on("error", () => { /* caller deliberately disconnects; no response is expected */ });
    req.setTimeout(1500, () => req.destroy(new Error("health fixture timeout"))); req.end();
    try {
      await ready; req.destroy();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 500, interval: 10 });
    } finally { req.destroy(); release(measured()); }
    await vi.waitFor(() => expect(f.config.getProfileHealthHistory(dirId)).toEqual([]));
    expect(f.disk().envRiskDiagnostics?.[dirId] || []).toEqual([]);
  });
});
