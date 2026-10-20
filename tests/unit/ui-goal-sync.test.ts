// Whole-module renderer tests with a minimal control DOM and synthetic provider.
// No native application, browser, S3, credentials or host data is used.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as zlib from "node:zlib";

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-sync-store-"));
vi.mock("electron", () => ({
  app: { getPath: () => STORE },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
  safeStorage: { isEncryptionAvailable: () => false },
}));
import { getConfig, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { syncService } from "../../src/main/services/sync-service.js";
import { addMember, initTeam, renameWorkspace, setMemberRole, teamStatus } from "../../src/main/services/team.js";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/app/sync.js"), "utf8");
const HTML = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
class Control {
  value = ""; checked = false; disabled = false; textContent = "";
  style: Record<string, string> = {}; attrs: Record<string, string> = {};
  children: Control[] = []; html = "";
  onclick: ((e: any) => void) | null = null; onchange: ((e: any) => void) | null = null;
  focus = vi.fn();
  onRender: ((children: Control[]) => void) | null = null;
  get innerHTML() { return this.html; }
  set innerHTML(s: string) {
    this.html = s; this.children = [];
    // Model only generated select controls; production code runs unmodified.
    for (const m of s.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const c = new Control();
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) c.attrs[a[1]] = a[2];
      const options = [...m[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      c.value = (options.find((o) => /\bselected\b/.test(o[2])) || options[0])?.[1] || "";
      this.children.push(c);
    }
    for (const m of s.matchAll(/<input\b([^>]*)>/g)) {
      const c = new Control();
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) c.attrs[a[1]] = a[2];
      c.checked = /\bchecked\b/.test(m[1]); this.children.push(c);
    }
    if (this.onRender) this.onRender(this.children);
  }
  setAttribute(k: string, value: string) { this.attrs[k] = String(value); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  get dataset() { return { deviceId: this.attrs["data-device-id"] }; }
  closest(sel: string) { return sel.startsWith(".") && this.attrs.class?.split(" ").includes(sel.slice(1)) ? this : null; }
  contains(c: Control) { return this.children.includes(c); }
}
function section(ids: string[] = []) { return { localOnly: [], remoteOnly: [], changed: ids.map((id) => ({ id, fields: ["name"] })) }; }
const COMPARISON_TOKEN = { targetId: "fixture-target", localHash: "fixture-local", remoteHash: "fixture-remote" };
function diff(ids = ["fixture_a"]) {
  return { ok: true, comparisonToken: COMPARISON_TOKEN, coverage: { compared: ["portable-profile", "preferences"], notCompared: ["live-cookies", "localStorage-database", "full-profile-files"], unverified: [] }, profiles: section(ids), proxies: section(["proxy_fixture"]), accounts: section(["account_fixture"]), extensions: section(["ext_fixture"]), pushWarnings: [], pullNotes: [] };
}
function harness() {
  const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const elements = Object.fromEntries(ids.map((id) => [id, new Control()]));
  elements["sync-merge-strategy"].value = "local";
  elements["team-panel"].onRender = (children) => {
    for (const c of children) if (c.attrs.id) elements[c.attrs.id] = c;
  };
  const push = new Control(), pull = new Control(); push.textContent = "Push"; pull.textContent = "Pull";
  const api = {
    sync: {
      preview: vi.fn(async (): Promise<any> => ({ configured: true, runningProfiles: [] })),
      previewDiff: vi.fn(async (): Promise<any> => diff()),
      push: vi.fn(async (_opts?: any): Promise<any> => ({ success: false, message: "fixture push refused" })),
      pull: vi.fn(async (_opts?: any): Promise<any> => ({ success: false, message: "fixture pull refused" })),
      status: vi.fn(async (): Promise<any> => ({ enabled: true, custodyConsentAt: 1 })),
      configure: vi.fn(async (_cfg: any) => ({ success: true })),
    },
    app: { reloadConfig: vi.fn(async () => {}) },
    team: { status: vi.fn(async (): Promise<any> => ({ team: null, local: { role: "owner" } })), setRole: vi.fn(async (_id: string, _role: string) => ({ success: true })), setEnabled: vi.fn(async (_enabled: boolean) => ({ success: true })) },
  };
  const helpers = { toast: vi.fn(), esc: (v: any) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), escAttr: (v: any) => String(v ?? "").replace(/"/g, "&quot;") };
  const ab: any = { api, helpers, confirmAsync: vi.fn(async (_msg: string, _opts?: any) => true),
    invalidateProfilesForSync: vi.fn(), invalidateAccountsForSync: vi.fn(), loadProfiles: vi.fn(), loadAccountsTab: vi.fn(), loadProxies: vi.fn(), loadExtensionsTab: vi.fn() };
  const document = {
    getElementById: (id: string) => elements[id] || null,
    querySelector: (s: string) => s.includes('"syncPush"') ? push : s.includes('"syncPull"') ? pull : null,
    querySelectorAll: () => elements["sync-diff"].children.filter((c) => c.attrs.class === "sync-entry-strategy"),
  };
  vm.runInNewContext(SOURCE, { window: { agentBrowser: ab }, document, console });
  ab.loadSyncConfig = vi.fn();
  return { ab, api, helpers, elements, push, pull, entries: () => elements["sync-diff"].children };
}

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  if (path.dirname(STORE) !== os.tmpdir() || !path.basename(STORE).startsWith("ui-goal-sync-store-")) throw new Error("Unsafe sync fixture cleanup");
  fs.rmSync(STORE, { recursive: true, force: true });
});

describe("Sync whole-module strategy and asynchronous operations (fake UI)", () => {
  it("untouched conflicts follow the current global strategy after Compare", async () => {
    const h = harness(); await h.ab.loadSyncDiff();
    expect(h.entries()).toHaveLength(3); // Extensions intentionally have no per-item resolution.
    h.elements["sync-merge-strategy"].value = "remote";
    h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).toHaveBeenCalledWith({ strategy: "remote", resolutions: {}, comparisonToken: COMPARISON_TOKEN });
  });
  it("explicitly choosing the former default is retained while untouched entries inherit", async () => {
    const h = harness(); await h.ab.loadSyncDiff();
    h.entries()[0].value = "local";
    h.elements["sync-merge-strategy"].value = "newest";
    h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).toHaveBeenCalledWith({ strategy: "newest", resolutions: { "profiles:fixture_a": "local" }, comparisonToken: COMPARISON_TOKEN });
  });
  it("an explicit choice equal to global stays explicit after another global change", async () => {
    const h = harness(); h.elements["sync-merge-strategy"].value = "remote";
    await h.ab.loadSyncDiff(); h.entries()[1].value = "remote";
    h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).toHaveBeenLastCalledWith({ strategy: "remote", resolutions: { "proxies:proxy_fixture": "remote" }, comparisonToken: COMPARISON_TOKEN });
    // A mutation clears the previous choices. A second decision must be based
    // on a newly displayed comparison, not silently rebound to fresh content.
    await h.ab.loadSyncDiff(); h.entries()[1].value = "remote";
    h.elements["sync-merge-strategy"].value = "local";
    h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).toHaveBeenLastCalledWith({ strategy: "local", resolutions: { "proxies:proxy_fixture": "remote" }, comparisonToken: COMPARISON_TOKEN });
  });
  it("reset to inherit clears the override and Compare clears all old decisions", async () => {
    const h = harness(); await h.ab.loadSyncDiff(); h.entries()[0].value = "remote"; h.entries()[0].value = "";
    h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).toHaveBeenCalledWith({ strategy: "local", resolutions: {}, comparisonToken: COMPARISON_TOKEN });
    await h.ab.loadSyncDiff(); h.entries()[0].value = "remote"; await h.ab.loadSyncDiff();
    h.ab.syncPull(); await flush(); expect(h.api.sync.pull).toHaveBeenLastCalledWith({ strategy: "local", resolutions: {}, comparisonToken: COMPARISON_TOKEN });
  });
  for (const result of ["reject", "failure", "null"] as const) {
    it(`aborts Push on ${result} preflight, releases busy state and permits retry`, async () => {
      const h = harness();
      if (result === "reject") h.api.sync.previewDiff.mockRejectedValueOnce(new Error("fixture unavailable"));
      else h.api.sync.previewDiff.mockResolvedValueOnce(result === "null" ? null : { ok: false, message: "fixture denied" });
      h.ab.syncPush(); await flush();
      expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.push.disabled).toBe(false); expect(h.push.textContent).toBe("Push");
      expect(h.helpers.toast.mock.calls.some((c) => c[1] === "error")).toBe(true);
      h.api.sync.previewDiff.mockResolvedValueOnce({ ...diff(), firstPush: true });
      h.ab.syncPush(); await flush(); expect(h.api.sync.push).toHaveBeenCalledTimes(1);
    });
  }
  it("offline count-card failure is best effort, but a valid first-push diff permits Push", async () => {
    const h = harness(); h.api.sync.preview.mockRejectedValueOnce(new Error("count unavailable"));
    h.api.sync.previewDiff.mockResolvedValueOnce({ ...diff(), firstPush: true });
    h.ab.syncPush(); await flush(); expect(h.api.sync.push).toHaveBeenCalledTimes(1);
  });
  it("late Compare success cannot overwrite a newer comparison", async () => {
    const h = harness(), a = deferred<any>(), b = deferred<any>();
    h.api.sync.previewDiff.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pa = h.ab.loadSyncDiff(), pb = h.ab.loadSyncDiff();
    b.resolve(diff(["newer_fixture"])); await pb;
    a.resolve(diff(["older_fixture"])); await pa;
    expect(h.entries()[0].attrs["data-id"]).toBe("newer_fixture");
  });
  it("late Compare rejection cannot erase a newer result or toast an obsolete failure", async () => {
    const h = harness(), a = deferred<any>(); h.api.sync.previewDiff.mockReturnValueOnce(a.promise);
    const pa = h.ab.loadSyncDiff(); await h.ab.loadSyncDiff();
    a.reject(new Error("obsolete fixture")); await pa;
    expect(h.entries()).toHaveLength(3); expect(h.helpers.toast).not.toHaveBeenCalled();
  });
  it("older Push preflight still confirms its own warnings despite a newer Compare", async () => {
    const h = harness(), a = deferred<any>(); h.api.sync.previewDiff.mockReturnValueOnce(a.promise);
    h.ab.syncPush(); await flush(); await h.ab.loadSyncDiff();
    h.ab.confirmAsync.mockResolvedValueOnce(false); a.resolve({ ...diff(), pushWarnings: ["delete fixture"] }); await flush();
    expect(h.ab.confirmAsync.mock.calls[0][0]).toContain("delete fixture"); expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.push.disabled).toBe(false);
  });
  it("warning Cancel and lock override Cancel cause no force or reload", async () => {
    const h = harness(); h.api.sync.previewDiff.mockResolvedValueOnce({ ...diff(), pushWarnings: ["remove fixture"] });
    h.ab.confirmAsync.mockResolvedValueOnce(false); h.ab.syncPush(); await flush();
    expect(h.api.sync.push).not.toHaveBeenCalled(); expect(h.push.disabled).toBe(false);
    h.api.sync.push.mockResolvedValueOnce({ success: false, message: "locked by another device" });
    h.ab.confirmAsync.mockResolvedValueOnce(false); h.ab.syncPush(); await flush();
    expect(h.api.sync.push).toHaveBeenCalledTimes(1); expect(h.ab.loadSyncConfig).not.toHaveBeenCalled(); expect(h.push.disabled).toBe(false);
  });
  it("acknowledged warning and lock override force once, then report denial", async () => {
    const h = harness(); h.api.sync.previewDiff.mockResolvedValueOnce({ ...diff(), pushWarnings: ["remove fixture"] });
    h.api.sync.push.mockResolvedValueOnce({ success: false, message: "locked by another device" }).mockResolvedValueOnce({ success: false, message: "requires admin role" });
    h.ab.syncPush(); await flush(); expect(h.api.sync.push.mock.calls).toEqual([[{ comparisonToken: COMPARISON_TOKEN }], [{ force: true, comparisonToken: COMPARISON_TOKEN }]]);
    expect(h.ab.confirmAsync.mock.calls.every((c: [string, { ackLabel?: string }?]) => c[1]?.ackLabel)).toBe(true);
    expect(h.helpers.toast).toHaveBeenLastCalledWith("requires admin role", "error"); expect(h.ab.loadSyncConfig).not.toHaveBeenCalled();
  });
  it("running-profile Pull cancellation and preview rejection release controls without write", async () => {
    const h = harness(); await h.ab.loadSyncDiff(); h.api.sync.preview.mockResolvedValueOnce({ runningProfiles: ["fixture_a"] });
    h.ab.confirmAsync.mockResolvedValueOnce(false); h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).not.toHaveBeenCalled(); expect(h.pull.disabled).toBe(false);
    await h.ab.loadSyncDiff(); h.api.sync.preview.mockRejectedValueOnce(new Error("preview denied")); h.ab.syncPull(); await flush();
    expect(h.api.sync.pull).not.toHaveBeenCalled(); expect(h.pull.disabled).toBe(false);
  });
  it("Pull confirmation rejection is handled and releases the busy control", async () => {
    const h = harness(); await h.ab.loadSyncDiff(); h.api.sync.preview.mockResolvedValueOnce({ runningProfiles: ["fixture_a"] });
    h.ab.confirmAsync.mockRejectedValueOnce(new Error("confirmation unavailable"));
    h.ab.syncPull(); await flush(); expect(h.pull.disabled).toBe(false); expect(h.api.sync.pull).not.toHaveBeenCalled();
  });
  it("Pull refreshes live status and model views even when the obsolete reload API would fail", async () => {
    const h = harness(); await h.ab.loadSyncDiff(); h.api.sync.pull.mockResolvedValueOnce({ success: true, message: "fixture pulled" });
    h.api.app.reloadConfig.mockRejectedValueOnce(new Error("reload must not be called")); await h.ab.syncPull(); await flush();
    expect(h.api.app.reloadConfig).not.toHaveBeenCalled(); expect(h.api.sync.status).toHaveBeenCalled(); expect(h.pull.disabled).toBe(false);
    expect(h.ab.invalidateProfilesForSync).toHaveBeenCalled(); expect(h.ab.invalidateAccountsForSync).toHaveBeenCalled();
    expect(h.ab.loadProfiles).toHaveBeenCalledWith(true); expect(h.ab.loadAccountsTab).toHaveBeenCalled();
  });
  it("rejected enforcement write does not leave the unsaved checkbox selected", async () => {
    const h = harness();
    h.api.team.status.mockResolvedValue({ team: { name: "Synthetic", ownerDeviceId: "owner", enabled: true, members: [] }, local: { role: "owner", deviceId: "owner" } });
    h.ab.loadTeamPanel(); await flush();
    const box = h.elements["team-enabled"]; expect(box.checked).toBe(true); box.checked = false;
    h.api.team.setEnabled.mockRejectedValueOnce(new Error("enforcement unavailable"));
    box.onchange!({ target: box }); await flush();
    expect(h.elements["team-enabled"].checked).toBe(true); expect(h.api.team.status).toHaveBeenCalledTimes(2);
  });
  for (const rejected of [false, true]) {
    it(`team role/enforcement ${rejected ? "rejection" : "denial"} restores controls from status`, async () => {
      const h = harness();
      h.api.team.status.mockResolvedValue({ team: { name: "Synthetic", ownerDeviceId: "owner", enabled: true, members: [{ deviceId: "owner", role: "owner" }, { deviceId: "other", role: "member" }] }, local: { role: "owner", deviceId: "owner" } });
      h.ab.loadTeamPanel(); await flush();
      const panel = h.elements["team-panel"], sel = panel.children.find((c) => c.attrs.class === "team-role-select")!;
      expect(sel.value).toBe("member"); sel.value = "viewer";
      if (rejected) h.api.team.setRole.mockRejectedValueOnce(new Error("role transport unavailable"));
      else h.api.team.setRole.mockResolvedValueOnce({ success: false });
      panel.onchange!({ target: sel }); await flush();
      expect(h.api.team.setRole).toHaveBeenCalledWith("other", "viewer");
      expect(panel.children.find((c) => c.attrs.class === "team-role-select")?.value).toBe("member");
      const box = h.elements["team-enabled"]; expect(box.checked).toBe(true); box.checked = false;
      if (rejected) h.api.team.setEnabled.mockRejectedValueOnce(new Error("enforcement transport unavailable"));
      else h.api.team.setEnabled.mockResolvedValueOnce({ success: false });
      box.onchange!({ target: box }); await flush();
      expect(h.api.team.setEnabled).toHaveBeenCalledWith(false); expect(h.elements["team-enabled"].checked).toBe(true);
      expect(h.helpers.toast.mock.calls.some((c) => c[1] === "success")).toBe(false);
    });
  }
  for (const role of ["owner", "admin", "member", "viewer"]) {
    it(`renders actual ${role} management controls from team status`, async () => {
      const h = harness(); h.api.team.status.mockResolvedValueOnce({ team: { name: "Synthetic", ownerDeviceId: "owner", enabled: true, members: [{ deviceId: "owner", role: "owner" }, { deviceId: "other", role: "member" }] }, local: { role, deviceId: "me" } });
      h.ab.loadTeamPanel(); await flush();
      const rendered = h.elements["team-panel"].innerHTML;
      expect(rendered.includes('id="team-workspace-rename"')).toBe(role === "owner");
      expect(rendered.includes('id="team-add-device-id"')).toBe(role === "owner" || role === "admin");
      expect(h.elements["team-panel"].children.length > 0).toBe(role === "owner" || role === "admin");
    });
  }
});

// Real service contracts; only the provider transport is controlled. Every
// fixture config write is inspected on disk, reloaded and searched by ID.
describe("Sync service contracts with synthetic config/remote bytes", () => {
  function seed(role: "owner" | "admin" | "member" | "viewer" = "owner") {
    const cfg = getConfig(); cfg.deviceId = "fixture_device";
    cfg.browserProfiles = {}; cfg.proxies = {}; cfg.accounts = []; cfg.extensionRepository = {};
    cfg.sync = { enabled: true, endpoint: "https://fixture.invalid", bucket: "fixture", accessKey: "dummy", secretKey: "dummy", custodyConsentAt: 1 };
    cfg.team = { name: "Synthetic", ownerDeviceId: "owner_fixture", enabled: true, updatedAt: 1, members: [{ deviceId: "fixture_device", name: "Fixture", role, addedAt: 1 }] };
    saveConfig(cfg);
    const stored = JSON.parse(fs.readFileSync(path.join(STORE, "config.json"), "utf8"));
    expect(stored.team.members.find((m: any) => m.deviceId === "fixture_device").role).toBe(role);
    reloadConfig(); expect(teamStatus().local.role).toBe(role);
  }
  it("only 404 on both modern and legacy keys yields firstPush; 403 and rejection do not", async () => {
    seed(); const provider = vi.fn(async (_url: string) => new Response("missing", { status: 404 })); vi.stubGlobal("fetch", provider);
    expect(await syncService.previewDiff()).toMatchObject({ ok: true, firstPush: true }); expect(provider).toHaveBeenCalledTimes(2);
    expect(String(provider.mock.calls[0]?.[0])).toContain("agent-browser-studio-config.json");
    provider.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    expect(await syncService.previewDiff()).toMatchObject({ ok: false, message: "HTTP 403: denied" });
    provider.mockRejectedValueOnce(new Error("provider offline")); expect(await syncService.previewDiff()).toMatchObject({ ok: false, message: "provider offline" });
  });
  it("viewer Push and member force Push use real gates before any provider request", async () => {
    const provider = vi.fn(); vi.stubGlobal("fetch", provider);
    seed("viewer"); expect(await syncService.push()).toMatchObject({ success: false, message: expect.stringContaining("requires member role") });
    seed("member"); expect(await syncService.push(undefined, true)).toMatchObject({ success: false, message: expect.stringContaining("requires admin role") });
    expect(provider).not.toHaveBeenCalled();
  });
  it("owner-only rename and admin grant protection operate against reloaded roster", () => {
    seed("admin"); expect(renameWorkspace("Denied")).toMatchObject({ ok: false });
    expect(addMember("new_fixture", "New", "admin")).toMatchObject({ ok: false });
    seed("owner"); expect(addMember("new_fixture", "New", "member")).toMatchObject({ ok: true });
    expect(setMemberRole("new_fixture", "viewer")).toMatchObject({ ok: true });
    expect(renameWorkspace("Fixture renamed")).toMatchObject({ ok: true });
    const disk = JSON.parse(fs.readFileSync(path.join(STORE, "config.json"), "utf8"));
    expect(disk.team.name).toBe("Fixture renamed"); expect(disk.team.members.find((m: any) => m.deviceId === "new_fixture").role).toBe("viewer");
    reloadConfig(); expect(teamStatus().team?.members.find((m) => m.deviceId === "new_fixture")?.role).toBe("viewer");
  });
  it("renderer remote Pull updates real synthetic config bytes, reload and ID search", async () => {
    seed(); const cfg = getConfig(); cfg.proxies = { proxy_fixture: { type: "http", host: "local.fixture.invalid", port: 80 } }; saveConfig(cfg);
    expect(JSON.parse(fs.readFileSync(path.join(STORE, "config.json"), "utf8")).proxies.proxy_fixture.host).toBe("local.fixture.invalid");
    reloadConfig(); expect(getConfig().proxies.proxy_fixture.host).toBe("local.fixture.invalid");
    const remote = { ...getConfig(), proxies: { proxy_fixture: { type: "http", host: "remote.fixture.invalid", port: 81 } } };
    const bytes = Buffer.from(JSON.stringify({ timestamp: 2, data: zlib.gzipSync(JSON.stringify(remote)).toString("base64") }));
    const remoteFile = path.join(STORE, "synthetic-provider.json"); fs.writeFileSync(remoteFile, bytes);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fs.readFileSync(remoteFile))));
    const h = harness(); h.api.sync.previewDiff.mockImplementation(() => syncService.previewDiff());
    h.api.sync.pull.mockImplementation((opts) => syncService.pull(undefined, opts));
    await h.ab.loadSyncDiff(); h.elements["sync-merge-strategy"].value = "remote";
    await h.ab.syncPull(); await flush();
    expect(h.api.app.reloadConfig).not.toHaveBeenCalled(); expect(h.api.sync.status).toHaveBeenCalled();
    expect(getConfig().proxies.proxy_fixture.host).toBe("remote.fixture.invalid");
    expect(JSON.parse(fs.readFileSync(path.join(STORE, "config.json"), "utf8")).proxies.proxy_fixture.host).toBe("remote.fixture.invalid");
    reloadConfig(); expect(Object.entries(getConfig().proxies).find(([id]) => id === "proxy_fixture")?.[1].host).toBe("remote.fixture.invalid");
    expect(fs.readFileSync(remoteFile)).toEqual(bytes);
  });
});
