import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, startFixture, request, rawRequest } from "./rest-mcp-socket-helper.js";

let f: Awaited<ReturnType<typeof startFixture>>;
const dirId = "ab_task48_business", extId = "b".repeat(32);
beforeAll(async () => { f = await startFixture("rest"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  f.store.transact((draft: any) => {
    delete draft.team; draft.proxies = {}; draft.automation = []; draft.skillRepository = {};
    draft.browserProfiles = { [dirId]: { name: "Synthetic environment", engine: "chromium", proxyMode: "none", tags: ["fixture"] } };
  });
  h.browser.listBrowserProfiles.mockImplementation(() => Object.entries(f.config.getConfig().browserProfiles || {}).map(([id, value]: [string, any]) => ({ dirId: id, ...value })));
});

async function status(route: string, expected: number, options: Parameters<typeof f.api>[1] = {}) {
  const r = await f.api(route, options); expect(r.status, r.text).toBe(expected); return r;
}

describe("REST trust, real HTTP lifecycle, parameters and public contracts", () => {
  it("serves only declared GET public endpoints; auth, Origin and Host are enforced on real sockets", async () => {
    for (const route of ["/health", "/openapi.json"]) expect((await request(f.restPort, route)).status).toBe(200);
    for (const route of ["/api/profiles", "/version", "/health"]) expect((await request(f.restPort, route, { method: "POST" })).status).toBe(401);
    expect((await request(f.restPort, "/api/profiles?token=" + f.rest!.getRestApiToken())).status).toBe(401);
    expect((await request(f.restPort, "/api/profiles", { headers: { "X-Agent-Browser-Token": f.rest!.getRestApiToken() } })).status).toBe(200);
    expect((await request(f.restPort, "/api/profiles", { headers: { "X-Cloak-Token": f.rest!.getRestApiToken() } })).status).toBe(200);
    for (const origin of ["https://outside.invalid", "null", "bad origin", "file:///"]) await status("/health", 403, { headers: { Origin: origin } });
    await status("/health", 403, { headers: { Host: "outside.invalid" } });
    await status("/health", 200, { headers: { Origin: "https://localhost:443" } });
    await status("/api/profiles", 204, { method: "OPTIONS", token: null });
    await status("/unknown-route", 404);
    const spec = await status("/openapi.json", 200);
    expect(spec.body.paths["/api/accounts/{index}"].parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "If-Match", required: true })]));
    expect(spec.body.paths["/api/sync/push"].post.responses["409"]).toBeDefined();
  });
  it("contains invalid JSON and declared body overflow, then answers the next valid request", async () => {
    const bad = await status("/api/profiles", 400, { raw: "{" }); expect(bad.body.error).toMatch(/JSON/);
    const overflow = await rawRequest(f.restPort, `POST /api/profiles HTTP/1.1\r\nHost: 127.0.0.1:${f.restPort}\r\nAuthorization: Bearer ${f.rest!.getRestApiToken()}\r\nContent-Length: 2097153\r\nConnection: close\r\n\r\nx`);
    expect(overflow).toMatch(/^HTTP\/1\.1 413 /); await status("/api/profiles", 200);
  });
  it("reuses the listening server and exposes dynamic port/token/running state", async () => {
    const running = f.rest!.startRestApiServer(); await running.ready;
    expect(running.port).toBe(f.restPort); expect(f.rest!.isRestApiServerRunning()).toBe(true);
    expect(f.rest!.getRestApiToken()).toContain("synthetic");
    await status("/version", 200); await status("/api/server/idle", 200);
  });
});

describe("REST profile transport, redaction, truthful native-boundary results", () => {
  it("lists sync unknowns and reads actual metadata without proxy credentials", async () => {
    const list = await status("/api/profiles", 200);
    expect(list.body.profiles[0]).toMatchObject({ dirId, syncStatus: "unknown", syncReason: "content-unavailable", browser: "chromium", tags: ["fixture"] });
    const detail = await status(`/api/profiles/${dirId}`, 200); expect(detail.body.dirId).toBe(dirId); expect(detail.body.proxy).toBeNull();
    f.config.addProxy("synthetic-proxy", { type: "http", host: "proxy.synthetic.invalid", port: 8080, username: "synthetic-user", password: "synthetic-password" });
    f.config.setProfileProxy(dirId, "synthetic-proxy", "named");
    const proxied = await status(`/api/profiles/${dirId}`, 200);
    expect(proxied.body.proxy.hasAuth).toBe(true); expect(proxied.text).not.toContain("synthetic-password"); expect(proxied.text).not.toContain("synthetic-user");
    await status("/api/profiles/ab_missing", 404); await status("/api/profiles/bad.id", 400);
  });
  it("sanitizes profile create options and preserves native refusal codes", async () => {
    await status("/api/profiles", 400, { body: { name: " " } });
    h.browser.createBrowserProfile.mockReturnValueOnce({ dirId });
    await status("/api/profiles", 201, { body: { name: "  Fixture  ", engine: "chromium", unknownSecret: "not forwarded" } });
    expect(h.browser.createBrowserProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Fixture" }));
    expect(h.browser.createBrowserProfile.mock.calls[0][0]).not.toHaveProperty("unknownSecret");
    h.browser.createBrowserProfile.mockImplementationOnce(() => { throw new Error("fixture creation refused"); });
    await status("/api/profiles", 400, { body: { name: "Refused" } });
    h.browser.launchBrowser.mockResolvedValueOnce({ pid: 101, cdpPort: 9222, driftCheck: { checked: false }, envCheck: { checked: false } });
    const launched = await status(`/api/profiles/${dirId}/launch`, 200, { body: { headless: true } });
    expect(launched.body).toMatchObject({ success: true, cookieCheck: { checked: false }, dirId });
    expect(h.browser.launchBrowser).toHaveBeenLastCalledWith(dirId, { headless: true });
    h.browser.launchBrowser.mockRejectedValueOnce(Object.assign(new Error("Restart required"), { code: "restart-required" }));
    expect((await status(`/api/profiles/${dirId}/launch`, 400, { body: {} })).body.code).toBe("restart-required");
    h.browser.launchBrowser.mockRejectedValueOnce(new Error("other native refusal"));
    expect((await status(`/api/profiles/${dirId}/launch`, 400, { body: {} })).body.code).toBeUndefined();
  });
  it("distinguishes status/stop/delete and their errors without launching a browser", async () => {
    h.browser.statusBrowser.mockReturnValueOnce({ running: true, pid: 42, cdpPort: 9333 });
    expect((await status(`/api/profiles/${dirId}/status`, 200)).body.running).toBe(true);
    await status("/api/profiles/bad.id/status", 404);
    h.browser.stopBrowser.mockReturnValueOnce(true); expect((await status(`/api/profiles/${dirId}/stop`, 200, { method: "POST" })).body.success).toBe(true);
    h.browser.stopBrowser.mockImplementationOnce(() => { throw new Error("stop refused"); }); await status(`/api/profiles/${dirId}/stop`, 400, { method: "POST" });
    h.browser.deleteBrowserProfile.mockReturnValueOnce(true); await status(`/api/profiles/${dirId}`, 200, { method: "DELETE" });
    h.browser.deleteBrowserProfile.mockImplementationOnce(() => { throw new Error("delete refused"); }); await status(`/api/profiles/${dirId}`, 400, { method: "DELETE" });
    h.browser.checkFingerprintDrift.mockResolvedValueOnce({ checked: false, reason: "not-running" });
    expect((await status(`/api/profiles/${dirId}/drift`, 200)).body.checked).toBe(false);
    h.browser.checkFingerprintDrift.mockRejectedValueOnce(new Error("drift unavailable")); await status(`/api/profiles/${dirId}/drift`, 400);
  });
  it("gates profile extension install/delete and rejects invalid or missing entities before download", async () => {
    h.extensions.listExtensionRepository.mockReturnValueOnce([{ id: extId }]);
    expect((await status(`/api/profiles/${dirId}/extensions`, 200)).body.extensions[0].enabled).toBe(false);
    await status(`/api/profiles/${dirId}/extensions/bad/install`, 400, { method: "POST" });
    await status(`/api/profiles/ab_missing/extensions/${extId}/install`, 400, { method: "POST" });
    expect(h.extensions.addOrUpdateChromeStoreExtension).not.toHaveBeenCalled();
    h.extensions.addOrUpdateChromeStoreExtension.mockResolvedValueOnce({ id: extId });
    await status(`/api/profiles/${dirId}/extensions/${extId}/install`, 200, { method: "POST" });
    expect(f.disk().browserProfiles[dirId].extensions[extId]).toBe(true); f.config.reloadConfig();
    expect(f.config.getProfileMeta(dirId)?.extensions?.[extId]).toBe(true);
    await status(`/api/profiles/${dirId}/extensions/${extId}`, 200, { method: "DELETE" });
    expect(f.disk().browserProfiles[dirId].extensions[extId]).toBe(false);
    await status(`/api/profiles/${dirId}/extensions/bad`, 400, { method: "DELETE" });
    h.extensions.addOrUpdateChromeStoreExtension.mockRejectedValueOnce(new Error("fixture download refused"));
    await status(`/api/profiles/${dirId}/extensions/${extId}/install`, 400, { method: "POST" });
  });
});

describe("REST real proxy configuration and conservative exports", () => {
  it("writes disk, reloads and queries redacted proxy fields; missing/invalid parameters remain explicit", async () => {
    await status("/api/proxies", 400, { body: {} });
    await status("/api/proxies", 400, { body: { name: "invalid/name", config: {} } });
    await status("/api/proxies", 201, { body: { name: "synthetic-proxy", config: { type: "http", host: "proxy.synthetic.invalid", port: 8080, username: "synthetic-user", password: "synthetic-password" } } });
    expect(f.disk().proxies["synthetic-proxy"].host).toBe("proxy.synthetic.invalid");
    expect(JSON.stringify(f.disk().proxies)).not.toContain("synthetic-password"); f.config.reloadConfig();
    const list = await status("/api/proxies", 200); expect(list.text).not.toContain("synthetic-password");
    const info = await status("/api/proxies/synthetic-proxy", 200); expect(info.body.hasAuth).toBe(true); expect(info.text).not.toContain("synthetic-user");
    await status("/api/proxies/absent", 404); await status("/api/proxies/synthetic-proxy", 400, { method: "PATCH", body: {} });
    await status("/api/proxies/synthetic-proxy", 200, { method: "PATCH", body: { config: { type: "http", host: "updated.synthetic.invalid", port: 8081 } } });
    expect(f.disk().proxies["synthetic-proxy"].host).toBe("updated.synthetic.invalid");
    await status("/api/proxies/synthetic-proxy/default", 200, { method: "POST" });
    expect(f.disk().defaultProxy).toBe("synthetic-proxy");
    await status("/api/proxies/synthetic-proxy/rotation", 200); await status("/api/proxies/absent/rotation", 404);
    await status("/api/proxies/synthetic-proxy/rotate", 200, { method: "POST" }); await status("/api/proxies/absent/rotate", 404, { method: "POST" });
    await status("/api/proxies/health", 200); await status("/api/proxies/synthetic-proxy", 200, { method: "DELETE" });
    await status("/api/proxies/synthetic-proxy", 404);
  });
  it("retains proxy import failure rows; secret CSV export enforces the actual member gate", async () => {
    await status("/api/proxies/import", 400, { body: {} });
    const imported = await status("/api/proxies/import", 200, { body: { text: "http://synthetic-user:synthetic-password@proxy.synthetic.invalid:8080\nnot a proxy" } });
    expect(imported.body.report.imported.length).toBe(1); expect(imported.body.report.failed.length).toBe(1);
    expect((await status("/api/proxies/export", 200)).text).not.toContain("synthetic-password");
    f.role("viewer"); const before = f.bytes(); await status("/api/proxies/export?includePasswords=true", 403); expect(f.bytes()).toEqual(before);
    f.role("member"); expect((await status("/api/proxies/export?includePasswords=true", 200)).text).toContain("synthetic-password");
  });
});

describe("REST automation and skill repositories use real persistent stores", () => {
  const rule = () => ({ name: "Synthetic rule", trigger: { type: "once", at: Date.now() + 60_000 }, action: { type: "launch-profile", dirId } });
  it("creates/updates/deletes automation with on-disk and reload/query proofs", async () => {
    await status("/api/automation/rules", 400, { body: {} });
    const made = await status("/api/automation/rules", 201, { body: rule() }); const id = made.body.rule.id;
    expect(f.disk().automation.find((r: any) => r.id === id)?.name).toBe("Synthetic rule"); f.config.reloadConfig();
    expect((await status("/api/automation/rules", 200)).body.rules.some((r: any) => r.id === id)).toBe(true);
    await status(`/api/automation/rules/${id}`, 200, { method: "PATCH", body: { ...rule(), name: "Changed fixture" } });
    expect(f.disk().automation.find((r: any) => r.id === id)?.name).toBe("Changed fixture");
    await status("/api/automation/rules/absent", 404, { method: "PATCH", body: rule() });
    await status("/api/automation/rules", 400, { body: { ...rule(), trigger: { type: "cron", cron: "not cron" } } });
    h.automation.testRunRule.mockResolvedValueOnce({ ok: false, error: "fixture not runnable" });
    expect((await status(`/api/automation/rules/${id}/test-run`, 200, { method: "POST" })).body.ok).toBe(false);
    h.automation.testRunRule.mockRejectedValueOnce(new Error("fixture execution refused")); await status(`/api/automation/rules/${id}/test-run`, 400, { method: "POST" });
    await status(`/api/automation/rules/${id}`, 200, { method: "DELETE" }); await status(`/api/automation/rules/${id}`, 404, { method: "DELETE" });
    expect(h.automation.reloadSchedule).toHaveBeenCalledTimes(3);
  });
  it("viewer automation mutations and test-run have zero scheduler or store effects", async () => {
    f.role("viewer"); const before = f.bytes();
    for (const [route, method, body] of [
      ["/api/automation/rules", "POST", rule()], ["/api/automation/rules/absent", "PATCH", rule()],
      ["/api/automation/rules/absent", "DELETE", undefined], ["/api/automation/rules/absent/test-run", "POST", undefined],
    ] as const) await status(route, 403, { method, body });
    expect(f.bytes()).toEqual(before); expect(h.automation.reloadSchedule).not.toHaveBeenCalled(); expect(h.automation.testRunRule).not.toHaveBeenCalled();
  });
  it("persists local skill CRUD/install and distinguishes malformed/missing entries", async () => {
    await status("/api/skills", 400, { body: { id: "missing-prompt" } });
    await status("/api/skills", 400, { body: { id: "../invalid", prompt: "fixture" } });
    const made = await status("/api/skills", 201, { body: { id: "synthetic-skill", title: "Synthetic skill", prompt: "Do nothing except use fixture data.", enabled: false, tags: [" local ", "local"] } });
    expect(made.body.skill.enabled).toBe(false); expect(f.disk().skillRepository["synthetic-skill"].prompt).toContain("fixture"); f.config.reloadConfig();
    expect((await status("/api/skills?filter=synthetic", 200)).body.skills.map((s: any) => s.id)).toContain("synthetic-skill");
    await status("/api/skills/synthetic-skill/install", 200, { method: "POST" }); expect(f.disk().skillRepository["synthetic-skill"].enabled).toBe(true);
    await status("/api/skills/synthetic-skill", 200, { method: "PATCH", body: { shared: true, tags: [" fixture ", "fixture"] } });
    await status("/api/skills/absent-skill/install", 404, { method: "POST" });
    await status("/api/skills/absent-skill", 404, { method: "PATCH", body: {} });
    await status("/api/skills/absent-skill", 404, { method: "DELETE" });
    await status("/api/skills/synthetic-skill", 200, { method: "DELETE" });
    expect(f.disk().skillRepository["synthetic-skill"]).toBeUndefined();
  });
  it("viewer skills never write or enable an entry; disabled-team behavior remains the existing policy", async () => {
    f.role("viewer"); const before = f.bytes();
    for (const [route, method, body] of [
      ["/api/skills", "POST", { id: "synthetic-skill", prompt: "fixture" }], ["/api/skills/browser-automation/install", "POST", undefined],
      ["/api/skills/browser-automation", "PATCH", { enabled: true }], ["/api/skills/browser-automation", "DELETE", undefined],
    ] as const) await status(route, 403, { method, body });
    expect(f.bytes()).toEqual(before);
    f.role("viewer", false); await status("/api/skills/browser-automation/install", 200, { method: "POST" });
  });
});

describe("REST extension repository transport branches and no-download refusals", () => {
  it("lists and validates installers, forwards controlled local/store results, and maps missing entities", async () => {
    await status("/api/extension-repository?filter=fixture", 200);
    await status("/api/extension-repository", 400, { body: {} }); await status("/api/extension-repository/local", 400, { body: {} });
    h.extensions.addOrUpdateChromeStoreExtension.mockResolvedValueOnce({ id: extId });
    await status("/api/extension-repository", 201, { body: { extId: " " + extId + " ", shared: true, tags: [" fixture "] } });
    expect(h.extensions.addOrUpdateChromeStoreExtension).toHaveBeenCalledWith(extId, { shared: true, tags: ["fixture"] });
    h.extensions.installLocalExtension.mockResolvedValueOnce({ id: extId });
    await status("/api/extension-repository/local", 201, { body: { path: f.dir + "/synthetic-extension" } });
    h.extensions.updateRepositoryExtension.mockResolvedValueOnce({ id: extId }); await status(`/api/extension-repository/${extId}/update`, 200, { method: "POST" });
    h.extensions.updateRepositoryExtension.mockRejectedValueOnce(new Error("not in the repository")); await status(`/api/extension-repository/${extId}/update`, 404, { method: "POST" });
    h.extensions.updateRepositoryExtension.mockRejectedValueOnce(new Error("fixture update failed")); await status(`/api/extension-repository/${extId}/update`, 400, { method: "POST" });
    await status(`/api/extension-repository/${extId}`, 404, { method: "PATCH", body: {} });
    h.extensions.getRepositoryExtension.mockReturnValueOnce({ id: extId }); h.extensions.setRepositoryExtensionMeta.mockReturnValueOnce({ id: extId, shared: true });
    await status(`/api/extension-repository/${extId}`, 200, { method: "PATCH", body: { shared: true } });
    await status(`/api/extension-repository/${extId}`, 404, { method: "DELETE" });
    h.extensions.deleteRepositoryExtension.mockReturnValueOnce(true); await status(`/api/extension-repository/${extId}`, 200, { method: "DELETE" });
  });
  it("rejects every viewer repository mutation with zero download/install/metadata effects", async () => {
    f.role("viewer"); const before = f.bytes();
    for (const [route, method, body] of [
      ["/api/extension-repository", "POST", { extId }], ["/api/extension-repository/local", "POST", { path: f.dir }],
      [`/api/extension-repository/${extId}/update`, "POST", undefined], [`/api/extension-repository/${extId}`, "PATCH", {}],
      [`/api/extension-repository/${extId}`, "DELETE", undefined],
    ] as const) await status(route, 403, { method, body });
    expect(f.bytes()).toEqual(before);
    for (const name of ["addOrUpdateChromeStoreExtension", "installLocalExtension", "updateRepositoryExtension", "setRepositoryExtensionMeta", "deleteRepositoryExtension"] as const) expect(h.extensions[name]).not.toHaveBeenCalled();
  });
  it("keeps adapters read-only and distinguishes missing recipes", async () => {
    expect((await status("/api/platform-adapters?filter=generic", 200)).body.adapters.length).toBeGreaterThan(0);
    await status("/api/platform-adapters/generic-web", 200); await status("/api/platform-adapters/not-a-recipe", 404);
    expect((await status("/api/platform-adapter/detect?url=https%3A%2F%2Fsynthetic.invalid", 200)).body.adapter.id).toBe("generic-web");
    await status("/api/engine-status", 200);
  });
});
