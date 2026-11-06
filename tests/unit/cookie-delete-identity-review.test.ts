import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// All native capabilities are replaced before production modules load. No
// browser, socket, process discovery, database or application path is touched.
const h = vi.hoisted(() => ({
  forbidden: vi.fn(() => { throw new Error("Undeclared native capability"); }),
  handlers: new Map<string, (...args: any[]) => any>(),
  port: vi.fn(() => 9222 as number | null),
  engine: "chromium",
  response: {} as any,
  deleteError: false,
  commands: [] as Array<{ method: string; params?: any }>,
  fetch: vi.fn(),
  exists: vi.fn(),
  sqlite: vi.fn(),
  sqliteRows: [] as any[],
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  // Source loading is the only real read. Native SUT file access has a closed
  // facade, including an exact synthetic Cookies path for stopped-profile reads.
  const sources = new Set([new URL("../../src/main/preload.cjs", import.meta.url).href,
    new URL("../../src/renderer/js/app/cookies.js", import.meta.url).href]);
  return { existsSync: h.exists, readFileSync: (file: any, encoding: any) => {
    if (!sources.has(String(file)) || encoding !== "utf8") return h.forbidden();
    return actual.readFileSync(file, encoding);
  }, mkdirSync: h.forbidden, writeFileSync: h.forbidden, renameSync: h.forbidden,
  rmSync: h.forbidden, unlinkSync: h.forbidden, statSync: h.forbidden, lstatSync: h.forbidden,
  realpathSync: h.forbidden, readdirSync: h.forbidden, openSync: h.forbidden, closeSync: h.forbidden,
  copyFileSync: h.forbidden, accessSync: h.forbidden };
});
vi.mock("node:fs/promises", () => ({ readdir: h.forbidden, stat: h.forbidden, rm: h.forbidden,
  readFile: h.forbidden, writeFile: h.forbidden, mkdir: h.forbidden, rename: h.forbidden,
  unlink: h.forbidden, open: h.forbidden, realpath: h.forbidden, lstat: h.forbidden, access: h.forbidden }));
vi.mock("node:child_process", () => ({ exec: h.forbidden, execFile: h.forbidden, execSync: h.forbidden,
  execFileSync: h.sqlite, spawn: h.forbidden, spawnSync: h.forbidden, fork: h.forbidden }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, fn: any) => h.handlers.set(name, fn) },
  dialog: { showOpenDialog: h.forbidden, showSaveDialog: h.forbidden, showMessageBox: h.forbidden } }));
vi.mock("../../src/main/services/config-manager.js", () => ({ getAppDataDir: h.forbidden, getProfilesDir: () => process.env.TEST_SAFE_OWNED_ROOT + "/synthetic-profiles",
  resolveProfileProxy: h.forbidden, getProfileMeta: h.forbidden, getConfig: h.forbidden,
  removeProfileMeta: h.forbidden, setProfileMeta: h.forbidden }));
vi.mock("../../src/main/services/process-discovery.js", () => ({ findCdpPortSync: h.port, getRunningProcessesAsync: h.forbidden }));
vi.mock("../../src/main/services/utils.js", () => ({
  validateDirId: (id: string) => { if (typeof id !== "string" || !/^ab_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid dirId"); },
  getDirectorySizeAsync: h.forbidden,
}));
vi.mock("../../src/main/services/profile-restore-lock.js", () => ({ acquireRestoreLock: h.forbidden }));
vi.mock("../../src/main/services/sync/profile-state.js", () => ({ readProfileSyncState: h.forbidden }));
vi.mock("../../src/main/services/page-eval.js", () => ({ getProfileEngineByDirId: () => h.engine }));
vi.mock("../../src/main/branding.js", () => ({ PROFILE_DIR_NAME: "Default" }));
vi.mock("../../src/main/services/browser/runtime-table.js", () => ({ runningProcesses: new Map() }));
vi.mock("../../src/main/services/agent/dispatch-guard.js", () => ({ captureProtocolDispatchGuard: h.forbidden, runWithProtocolDispatchGuard: h.forbidden }));
vi.mock("../../src/main/services/bidi-client.js", () => ({ connectBidi: h.forbidden, getRegisteredFirefoxSession: h.forbidden,
  normalizeBidiWebSocketUrl: h.forbidden, bidiSetCookie: h.forbidden, bidiDeleteCookies: h.forbidden }));
vi.mock("../../src/main/services/browser-manager.js", () => ({ listBrowserProfiles: h.forbidden, createBrowserProfile: h.forbidden,
  deleteBrowserProfile: h.forbidden, trashBrowserProfile: h.forbidden, restoreTrashedProfile: h.forbidden,
  listTrashedProfiles: h.forbidden, purgeExpiredTrash: h.forbidden, purgeTrashedProfile: h.forbidden }));
vi.mock("../../src/main/services/license.js", () => ({ checkCreateAllowed: h.forbidden }));
vi.mock("../../src/main/services/main-i18n.js", () => ({ tMain: h.forbidden }));
vi.mock("../../src/main/services/archive-path-guard.js", () => ({ assertSafeArchiveExportPath: h.forbidden,
  assertSafeArchiveExportDir: h.forbidden, assertSafeArchiveImportPath: h.forbidden }));
vi.mock("../../src/main/services/profile-archive.js", () => ({ exportProfileArchive: h.forbidden, importProfileArchive: h.forbidden,
  exportProfileArchives: h.forbidden, importProfileArchives: h.forbidden, archiveOperationFailure: h.forbidden,
  classifyArchiveBatchReport: h.forbidden, getProfileArchiveExportConflicts: h.forbidden }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class MockSocket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit("open")); }
    send(serialized: string) {
      const { id, method, params } = JSON.parse(serialized);
      h.commands.push({ method, params });
      const response = method === "Network.getAllCookies" ? h.response : {};
      const reply = method === "Network.deleteCookies" && h.deleteError
        ? { id, error: { message: "synthetic failure" } } : { id, result: response };
      queueMicrotask(() => this.emit("message", JSON.stringify(reply)));
    }
    terminate() { this.emit("close"); }
  } };
});

import * as cdpModule from "../../src/main/services/cdp-cookie-service.js";
import { cdpCookieService } from "../../src/main/services/cdp-cookie-service.js";
import { firefoxCookieService, runtimeCookieOps } from "../../src/main/services/bidi-cookie-service.js";
import { deleteCookie } from "../../src/main/services/profile-manager.js";
import { registerProfileHandlers } from "../../src/main/ipc/profile.js";
registerProfileHandlers();
const id = "ab_cookie_review";
const invoke = (payload: any) => h.handlers.get("profile:delete-cookie")!({}, payload);
const cookie = (path: string, extra: any = {}) => ({ domain: "example.test", name: "sid", value: "synthetic",
  path, expires: -1, secure: false, httpOnly: false, ...extra });
const deletes = () => h.commands.filter((command) => command.method === "Network.deleteCookies");
const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
// Unlike the legacy renderer-only fixture below, every list/delete request here
// crosses the actual registered IPC handler and profile-manager implementation.
function mountCookieUi() {
  const pending: Promise<any>[] = [], payloads: any[] = [], listings: any[][] = [], results: any[] = [], toasts: any[] = [];
  let bridge: any;
  runInNewContext(source("../../src/main/preload.cjs"), { require: (name: string) => {
    if (name !== "electron") throw new Error("Unexpected preload import");
    return { contextBridge: { exposeInMainWorld: (_name: string, api: any) => { bridge = api; } },
      ipcRenderer: { invoke: (channel: string, payload: any) => {
        if (channel !== "profile:cookies" && channel !== "profile:delete-cookie") throw new Error("Unexpected preload invocation");
        if (channel === "profile:delete-cookie") payloads.push(structuredClone(payload));
        const result = Promise.resolve(h.handlers.get(channel)!({}, structuredClone(payload))).then((reply) => {
          if (channel === "profile:cookies") listings.push(structuredClone(reply));
          else results.push(structuredClone(reply));
          return structuredClone(reply);
        });
        pending.push(result); return result;
      } } };
  } });
  const list: any = { innerHTML: "", contains: () => true };
  const nodes: any = { "cookie-list": list, "cookie-dir-id": { value: id }, "cookie-search": { value: "" } };
  const agent: any = { api: bridge, helpers: { toast: (...args: any[]) => toasts.push(args), esc: String, escAttr: String, icon: () => "" } };
  runInNewContext(source("../../src/renderer/js/app/cookies.js"), { window: { agentBrowser: agent },
    document: { getElementById: (name: string) => nodes[name] } });
  return { agent, list, listings, payloads, results, toasts,
    click: (index: number) => list.onclick({ target: { closest: () => ({ dataset: { cookieIndex: String(index) } }) } }),
    flush: async () => {
      for (let i = 0; i < 5; i++) {
        const count = pending.length; await Promise.all(pending); await Promise.resolve();
        if (pending.length === count) return;
      }
      throw new Error("Unexpected Cookie request loop");
    } };
}
beforeEach(() => {
  vi.restoreAllMocks();
  h.forbidden.mockClear(); h.port.mockClear().mockReturnValue(9222); h.engine = "chromium";
  h.commands.length = 0; h.response = { cookies: [cookie("/"), cookie("/account")] }; h.deleteError = false;
  const db = process.env.TEST_SAFE_OWNED_ROOT + "/synthetic-profiles/" + id + "/Default/Cookies";
  h.sqliteRows = [{ host_key: "example.test", name: "sid", value: "old-partition-P", path: "/account",
    expires_utc: 0, is_secure: 0, is_httponly: 0, samesite: -1 }];
  h.exists.mockReset().mockImplementation((file) => file === db ? true : h.forbidden());
  h.sqlite.mockReset().mockImplementation((command, args, options) => {
    if (command !== "sqlite3" || args[0] !== "-json" || args[args.length - 2] !== db ||
        typeof args[args.length - 1] !== "string" || options.encoding !== "utf-8" || options.timeout !== 5000) return h.forbidden();
    return JSON.stringify(h.sqliteRows);
  });
  h.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/synthetic" }] });
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(process, "kill").mockImplementation(h.forbidden as any);
});
afterEach(() => {
  expect(h.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("single-row Cookie deletion exact identity", () => {
  it("deletes only the selected non-root path among same-domain/name siblings", async () => {
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account" })).toEqual({ success: true });
    expect(deletes()).toEqual([{ method: "Network.deleteCookies", params: { domain: "example.test", name: "sid", path: "/account" } }]);
  });
  it("preserves an explicit root path without deleting non-root siblings", async () => {
    expect(await deleteCookie(id, "example.test", "sid", "/")).toBe(true);
    expect(deletes().map((c) => c.params.path)).toEqual(["/"]);
  });
  it("does not normalize or prefix-match paths, domains or names", async () => {
    h.response = { cookies: [cookie("/account/"), cookie("/account", { domain: ".example.test" }), cookie("/account", { name: "sid2" })] };
    expect(await deleteCookie(id, "example.test", "sid", "/account")).toBe(true);
    expect(deletes()).toEqual([]);
  });
  it.each([undefined, null, "", "account", "/bad\npath", "/" + "a".repeat(4096)])("rejects absent/invalid path %s before discovery", async (path) => {
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path })).toEqual({ success: false, error: "COOKIE_DELETE_PATH_REQUIRED" });
    expect(h.port).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled(); expect(deletes()).toEqual([]);
  });
  it("rejects missing path at direct CDP and Firefox service boundaries", async () => {
    await expect((cdpCookieService.deleteCookie as any)(id, "example.test", "sid")).rejects.toThrow("COOKIE_DELETE_PATH_REQUIRED");
    await expect((firefoxCookieService.deleteCookie as any)(id, "example.test", "sid")).rejects.toThrow("COOKIE_DELETE_PATH_REQUIRED");
    expect(h.port).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([null, {}, { topLevelSite: "https://top.test", hasCrossSiteAncestor: false }])("refuses partition identity rather than dropping it", async (partitionKey) => {
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account", partitionKey }))
      .toEqual({ success: false, error: "COOKIE_DELETE_PARTITION_UNSUPPORTED" });
    expect(h.port).not.toHaveBeenCalled(); expect(deletes()).toEqual([]);
  });
  it("does not delete an unpartitioned row with a same-path partitioned sibling", async () => {
    h.response = { cookies: [cookie("/account"), cookie("/account", { partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false } })] };
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account" }))
      .toEqual({ success: false, error: "COOKIE_DELETE_PARTITION_AMBIGUOUS" });
    expect(deletes()).toEqual([]);
  });
  it("does not broaden a partitioned-only same-path match", async () => {
    h.response = { cookies: [cookie("/account", { partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true } })] };
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account" })).toMatchObject({ success: false, error: "COOKIE_DELETE_PARTITION_AMBIGUOUS" });
    expect(deletes()).toEqual([]);
  });
  it.each([{}, { cookies: null }, { cookies: [cookie("/account", { path: undefined })] },
    { cookies: [cookie("/account", { partitionKeyOpaque: true })] },
    { cookies: [cookie("/account", { partitionKey: { topLevelSite: "https://top.test" } })] }])("fails closed on incomplete/opaque CDP snapshots", async (response) => {
    h.response = response;
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account" })).toEqual({ success: false, error: "COOKIE_DELETE_IDENTITY_UNAVAILABLE" });
    expect(deletes()).toEqual([]);
  });
  it("keeps stopped profiles read-only", async () => {
    h.port.mockReturnValue(null);
    await expect(deleteCookie(id, "example.test", "sid", "/account")).rejects.toThrow("Launch this profile");
    expect(h.fetch).not.toHaveBeenCalled(); expect(deletes()).toEqual([]);
  });
  it("does not report a rejected native delete as successful", async () => {
    h.deleteError = true;
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account" })).toEqual({ success: false });
    expect(deletes()).toHaveLength(1);
  });
  it("makes the current Firefox exact-delete limitation explicit, with no BiDi command", async () => {
    h.engine = "firefox";
    await expect(runtimeCookieOps.deleteCookie(id, "example.test", "sid", "/account"))
      .rejects.toThrow("FIREFOX_COOKIE_DELETE_EXACT_IDENTITY_UNSUPPORTED");
    await expect((runtimeCookieOps.deleteCookie as any)(id, "example.test", "sid", "/account", undefined, true))
      .rejects.toThrow("FIREFOX_COOKIE_DELETE_EXACT_IDENTITY_UNSUPPORTED");
    vi.spyOn(runtimeCookieOps, "hasRunningBrowser").mockReturnValue(true);
    expect(await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account" }))
      .toEqual({ success: false, error: "FIREFOX_COOKIE_DELETE_EXACT_IDENTITY_UNSUPPORTED" });
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.commands).toEqual([]);
  });
  it.each([false, null, 0, 1, "true", "false", {}, []].map((value) => [value]))("rejects unknown/illegal verification metadata %j at every boundary", async (verification) => {
    const args = [id, "example.test", "sid", "/account", undefined, verification] as const;
    const errors = await Promise.all([deleteCookie, runtimeCookieOps.deleteCookie,
      cdpCookieService.deleteCookie, firefoxCookieService.deleteCookie].map(async (del) => {
      try { await (del as any)(...args); return "accepted"; } catch (error: any) { return error.message; }
    }));
    const reply = await invoke({ dirId: id, domain: "example.test", name: "sid", path: "/account", deleteIdentityVerified: verification });
    expect(deletes()).toEqual([]);
    expect(errors).toEqual(Array(4).fill("COOKIE_DELETE_IDENTITY_UNAVAILABLE"));
    expect(reply).toEqual({ success: false, error: "COOKIE_DELETE_IDENTITY_UNAVAILABLE" });
    expect(h.port).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled(); expect(h.commands).toEqual([]);
  });
  it.each([undefined, true])("keeps verified online/legacy metadata %s intact across manager, runtime and CDP", async (verification) => {
    const runtime = vi.spyOn(runtimeCookieOps, "deleteCookie"), native = vi.spyOn(cdpCookieService, "deleteCookie");
    expect(await (deleteCookie as any)(id, "example.test", "sid", "/account", undefined, verification)).toBe(true);
    expect(runtime).toHaveBeenCalledWith(id, "example.test", "sid", "/account", undefined, verification);
    expect(native).toHaveBeenCalledWith(id, "example.test", "sid", "/account", undefined, verification);
    expect(deletes()).toEqual([{ method: "Network.deleteCookies", params: { domain: "example.test", name: "sid", path: "/account" } }]);
  });
  it("keeps an explicitly verified missing Cookie idempotent", async () => {
    h.response = { cookies: [] };
    expect(await (deleteCookie as any)(id, "example.test", "sid", "/account", undefined, true)).toBe(true);
    expect(deletes()).toEqual([]);
  });
  it.each([false, true])("refuses a stale offline P row with only online U remaining (upper-gate bypass=%s)", async (bypassUpperGates) => {
    h.port.mockReturnValue(null);
    // The offline SELECT cannot distinguish this former partitioned P row.
    // Its logical origin is modelled here; no real DB or sqlite process exists.
    h.response = { cookies: [cookie("/account", { value: "old-partition-P", partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false } })] };
    const ui = mountCookieUi(); ui.agent.loadCookies(id, ""); await ui.flush();
    expect(h.sqlite).toHaveBeenCalledTimes(1);
    expect(h.sqlite.mock.calls[0][1].at(-1)).toContain("SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite");
    expect(ui.listings[0][0]).toMatchObject({ domain: "example.test", name: "sid", path: "/account", value: "old-partition-P" });
    expect(ui.list.innerHTML).toContain("data-cookie-index"); expect(h.commands).toEqual([]);
    h.port.mockReturnValue(9222).mockClear();
    h.response = { cookies: [cookie("/account", { value: "unpartitioned-U" })] };
    const adapter = vi.spyOn(cdpCookieService, "deleteCookie");
    // Bypass ONLY the imported manager/router assertion to prove the actual
    // CDP adapter's local assertion also receives false and rejects it. This is
    // separate from the unmodified, all-gates-active regression above.
    const upper = bypassUpperGates ? vi.spyOn(cdpModule, "assertCookieDeleteIdentity").mockImplementation(() => {}) : null;
    ui.click(0); await ui.flush();
    // Check the actual native write first so RED reproduces the wrong-U delete,
    // rather than stopping at a merely absent metadata field assertion.
    expect(deletes(), "Stale offline identity: " + JSON.stringify({ row: ui.listings[0][0], payload: ui.payloads[0], nativeDeletes: deletes() })).toEqual([]);
    expect(ui.listings[0][0].deleteIdentityVerified).toBe(false);
    expect(ui.payloads[0].deleteIdentityVerified).toBe(false);
    expect(ui.payloads[0].partitionKey).toBeUndefined();
    expect(ui.results).toEqual([{ success: false, error: "COOKIE_DELETE_IDENTITY_UNAVAILABLE" }]);
    expect(ui.toasts).toContainEqual(["COOKIE_DELETE_IDENTITY_UNAVAILABLE", "error"]);
    expect(ui.toasts).not.toContainEqual(["Cookie deleted", "success"]);
    // Bypassing the manager gate permits its one running-browser check. The
    // real CDP local gate must reject before any additional adapter discovery.
    expect(h.port).toHaveBeenCalledTimes(bypassUpperGates ? 1 : 0);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.commands).toEqual([]);
    if (upper) {
      expect(upper).toHaveBeenCalledTimes(2);
      expect(adapter).toHaveBeenCalledWith(id, "example.test", "sid", "/account", undefined, false);
    } else expect(adapter).not.toHaveBeenCalled();
  });
  it("still deletes an online row through the actual list, renderer, preload, IPC, manager, runtime and CDP", async () => {
    const ui = mountCookieUi(); ui.agent.loadCookies(id, ""); await ui.flush();
    expect(h.sqlite).not.toHaveBeenCalled(); expect(h.exists).not.toHaveBeenCalled();
    expect(ui.listings[0][1].path).toBe("/account"); expect(ui.listings[0][1].deleteIdentityVerified).not.toBe(false);
    ui.click(1); await ui.flush();
    expect(ui.payloads[0]).toMatchObject({ dirId: id, domain: "example.test", name: "sid", path: "/account" });
    expect(deletes()).toEqual([{ method: "Network.deleteCookies", params: { domain: "example.test", name: "sid", path: "/account" } }]);
    expect(ui.results).toEqual([{ success: true }]); expect(ui.toasts).toContainEqual(["Cookie deleted", "success"]);
  });
  it("carries a clicked row through real renderer, preload, IPC, manager and CDP", async () => {
    const rows = [cookie("/"), cookie("/account")];
    const pending: Promise<any>[] = []; const payloads: any[] = []; const toasts: any[] = [];
    let bridge: any;
    runInNewContext(source("../../src/main/preload.cjs"), { require: (name: string) => {
      if (name !== "electron") throw new Error("Unexpected preload import");
      return { contextBridge: { exposeInMainWorld: (_name: string, api: any) => { bridge = api; } },
        ipcRenderer: { invoke: (channel: string, payload: any) => {
          if (channel === "profile:cookies") return Promise.resolve(rows);
          if (channel !== "profile:delete-cookie") throw new Error("Unexpected preload invocation");
          payloads.push(payload); const result = invoke(payload); pending.push(result); return result;
        } } };
    } });
    const list: any = { innerHTML: "", contains: () => true };
    const nodes: any = { "cookie-list": list, "cookie-dir-id": { value: id }, "cookie-search": { value: "" } };
    const agent: any = { api: bridge, helpers: { toast: (...args: any[]) => toasts.push(args),
      esc: String, escAttr: String, icon: () => "" } };
    runInNewContext(source("../../src/renderer/js/app/cookies.js"), { window: { agentBrowser: agent },
      document: { getElementById: (name: string) => nodes[name] } });
    agent.loadCookies(id, ""); await Promise.resolve();
    list.onclick({ target: { closest: () => ({ dataset: { cookieIndex: "1" } }) } });
    await Promise.all(pending); await Promise.resolve();
    expect(payloads[0]).toEqual({ dirId: id, domain: "example.test", name: "sid", path: "/account", partitionKey: undefined });
    expect(deletes().map((command) => command.params.path)).toEqual(["/account"]);
    expect(toasts).toContainEqual(["Cookie deleted", "success"]);
    // The same click must retain partition identity and show failure, not success.
    rows[1].partitionKey = { topLevelSite: "https://top.test", hasCrossSiteAncestor: false };
    toasts.length = 0; await Promise.resolve();
    list.onclick({ target: { closest: () => ({ dataset: { cookieIndex: "1" } }) } });
    await Promise.all(pending); await Promise.resolve();
    expect(payloads[1].partitionKey).toEqual(rows[1].partitionKey);
    expect(toasts).toContainEqual(["COOKIE_DELETE_PARTITION_UNSUPPORTED", "error"]);
    expect(deletes()).toHaveLength(1);
  });
});
