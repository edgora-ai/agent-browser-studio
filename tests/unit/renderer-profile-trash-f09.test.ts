// Renderer event regressions, plus real backend readback for supported IDs.
// The filesystem fault matrix remains in f09-profile-trash.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";

const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f09-renderer-"));
vi.mock("electron", () => ({
  app: { getPath: () => STORAGE_ROOT },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));
// The owned fixtures have no browser processes. Host discovery (including
// Windows WMIC/CIM availability) is not evidence about these synthetic IDs.
// Isolate only that boundary; keep lifecycle refusal and all storage paths real.
const discovery = vi.hoisted(() => ({
  findBrowserByProfileSync: vi.fn<typeof import("../../src/main/services/process-discovery.js").findBrowserByProfileSync>(() => null),
}));
vi.mock("../../src/main/services/process-discovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/main/services/process-discovery.js")>(),
  findBrowserByProfileSync: discovery.findBrowserByProfileSync,
}));
import { getConfig, getProfileMeta, reloadConfig } from "../../src/main/services/config-manager.js";
import { listBrowserProfiles, listTrashedProfiles, purgeTrashedProfile, restoreTrashedProfile, trashBrowserProfile } from "../../src/main/services/browser-manager.js";
import { validateDirId } from "../../src/main/services/utils.js";

beforeEach(() => { discovery.findBrowserByProfileSync.mockReset().mockReturnValue(null); });

afterAll(() => {
  if (path.dirname(STORAGE_ROOT) !== os.tmpdir() || !path.basename(STORAGE_ROOT).startsWith("studio-f09-renderer-")) {
    throw new Error("Unsafe F09 renderer cleanup path");
  }
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, "../..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/profiles.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf8");
const ID = "f09_renderer_a";
const OTHER = "f09_renderer_b";
const ERROR = `EACCES: permission denied; ${"recovery context ".repeat(30)}\nRemaining paths: /synthetic/live, /synthetic/trash; <untrusted-file-name>; END-${ID}`;

class Element {
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  children: Element[] = [];
  hidden = true;
  open = false;
  checked = true;
  textContent = "";
  html = "";
  style: Record<string, string> = {};
  classList = { add: vi.fn(), remove: vi.fn() };
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
    // Parse only controls/warnings emitted by the real trash renderer. The
    // harness deliberately dispatches disabled controls too, testing JS guards.
    for (const match of value.matchAll(/<(?:button|span)\b([^>]*)>/g)) {
      if (!/data-trash-/.test(match[1])) continue;
      const child = new Element();
      for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attr[1], attr[2]);
      child.hidden = /\bhidden\b/.test(match[1]);
      if (/\bdisabled\b/.test(match[1])) child.setAttribute("disabled", "disabled");
      this.children.push(child);
    }
  }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  addEventListener(name: string, fn: () => void) { (this.listeners[name] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn(); }
  querySelectorAll(selector: string) {
    const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (!attrs.length) return this.children;
    return this.children.filter((el) => attrs.some((attr) => el.getAttribute(attr[1]) !== null && (!attr[2] || el.getAttribute(attr[1]) === attr[2])));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  scrollIntoView = vi.fn();
  insertAdjacentHTML(_where: string, html: string) { this.html = html + this.html; }
}

async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function harness(lang = "en-US") {
  const summary = new Element(), detail = new Element(), error = new Element();
  error.querySelector = (selector: string) => selector === ".trash-action-summary" ? summary : selector === ".toast-detail" ? detail : null;
  const list = new Element(), card = new Element(), checkbox = new Element();
  card.children = [checkbox];
  const elements: Record<string, Element> = { "dlg-trash": new Element(), "trash-list": list, "trash-action-error": error, "profile-list": new Element() };
  const confirmations: Array<{ onOk: () => void; cancel: () => void }> = [];
  const api = {
    profile: {
      list: vi.fn(async () => []),
      trash: vi.fn(async (_id: string): Promise<any> => ({ success: true })),
      trashList: vi.fn(async () => ({ success: true, entries: [ID, OTHER].map((dirId) => ({ dirId, name: dirId, recoverable: true })) })),
      trashRestore: vi.fn(async (_id: string): Promise<any> => ({ success: true })),
      trashPurge: vi.fn(async (_id: string): Promise<any> => ({ success: true })),
    },
    browser: { list: vi.fn(async () => []), binary: vi.fn(async () => null) },
    proxy: { list: vi.fn(async () => []) },
  };
  const helpers = {
    toast: vi.fn(),
    esc: (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    escAttr: (s: any) => String(s ?? "").replace(/"/g, "&quot;"),
  };
  const agentBrowser: any = {
    api, helpers, state: { currentTab: "profiles" },
    ipc: { call: vi.fn((_key: string, fn: () => Promise<any>) => fn()) },
    confirm: vi.fn((_msg: string, onOk: () => void) => { confirmations.push({ onOk, cancel: () => {} }); }),
    confirmAsync: vi.fn((_msg: string, _opts: any) => new Promise<boolean>((resolve) => {
      agentBrowser.confirm(_msg, () => resolve(true), _opts);
      confirmations[confirmations.length - 1].cancel = () => resolve(false);
    })),
    loadTab: vi.fn(),
    renderViewState: vi.fn(),
  };
  const document: any = {
    documentElement: { lang: "" },
    getElementById: (id: string) => elements[id] || null,
    querySelector: (selector: string) => selector.includes('.profile-card[data-dir-id="') ? card : null,
    querySelectorAll: () => [],
    addEventListener: () => {}, dispatchEvent: () => true,
  };
  const context: any = {
    window: { agentBrowser }, document, navigator: { language: "en-US" },
    localStorage: { getItem: () => null, setItem: () => {} },
    CustomEvent: class {}, console,
    setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(I18N, context);
  context.window.i18n.set(lang);
  vm.runInContext(SOURCE, context);
  const button = (kind: "restore" | "purge", id = ID) => {
    const el = list.querySelector(`[data-trash-${kind}="${id}"]`);
    if (!el) throw new Error(`Missing ${kind} ${id}`);
    return el;
  };
  return { agentBrowser, api, helpers, confirmations, button, list, card, checkbox, error, summary, detail, i18n: context.window.i18n };
}

function assertDetail(h: ReturnType<typeof harness>, summary: string) {
  expect(h.error.hidden).toBe(false);
  expect(h.error.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(h.summary.textContent).toBe(summary);
  expect(h.detail.textContent).toBe(`${ID}: ${ERROR}`);
  expect(h.detail.innerHTML).toBe(""); // No HTML assignment of untrusted backend text.
}

for (const rejected of [false, true]) {
  describe(`F09 single renderer ${rejected ? "rejection" : "returned failure"}`, () => {
    const fail = (fn: any) => rejected ? fn.mockRejectedValueOnce(new Error(ERROR)) : fn.mockResolvedValueOnce({ success: false, error: ERROR });

    it("preserves delete details, card/selection, releases busy state and retries with Undo", async () => {
      const h = harness();
      fail(h.api.profile.trash);
      h.agentBrowser.delProfile(ID);
      h.confirmations[0].onOk();
      await flush();
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Could not delete profile", "error", { detail: `${ID}: ${ERROR}`, ttlMs: 0 });
      expect(h.card.getAttribute("aria-busy")).toBe("false");
      expect(h.checkbox.checked).toBe(true);
      expect(h.agentBrowser.loadTab).not.toHaveBeenCalled();
      h.agentBrowser.delProfile(ID);
      h.confirmations[1].onOk();
      await flush();
      expect(h.api.profile.trash).toHaveBeenCalledTimes(2);
      expect(h.agentBrowser.loadTab).toHaveBeenCalledWith("profiles");
      expect(h.helpers.toast.mock.calls.at(-1)?.[2]).toMatchObject({ ttlMs: 12000, action: { label: "Undo" } });
    });

    it("keeps restore failures in the modal, without list/sweep, and permits retry", async () => {
      const h = harness();
      h.agentBrowser.showTrash(); await flush();
      fail(h.api.profile.trashRestore);
      h.button("restore").click(); await flush();
      assertDetail(h, "Could not restore profile");
      expect(h.api.profile.trashList).toHaveBeenCalledTimes(1);
      expect(h.api.browser.list).not.toHaveBeenCalled();
      expect(h.button("restore").getAttribute("disabled")).toBeNull();
      expect(h.button("purge").getAttribute("disabled")).toBeNull();
      h.button("restore").click(); await flush();
      expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(2);
      expect(h.api.profile.trashList).toHaveBeenCalledTimes(2);
      expect(h.api.browser.list).toHaveBeenCalledTimes(1);
      expect(h.error.hidden).toBe(true);
    });

    it("retains purge errors, never restores unverified data, and re-confirms retry", async () => {
      const h = harness();
      h.agentBrowser.showTrash(); await flush();
      fail(h.api.profile.trashPurge);
      const restore = h.button("restore"), purge = h.button("purge");
      purge.click(); h.confirmations[0].onOk(); await flush();
      assertDetail(h, "Could not permanently delete profile");
      expect(h.api.profile.trashList).toHaveBeenCalledTimes(1);
      expect(h.api.browser.list).not.toHaveBeenCalled();
      expect(restore.getAttribute("disabled")).not.toBeNull();
      expect(purge.getAttribute("disabled")).toBeNull();
      restore.click(); await flush();
      expect(h.api.profile.trashRestore).not.toHaveBeenCalled();
      purge.click();
      expect(h.confirmations).toHaveLength(2);
      expect(h.api.profile.trashPurge).toHaveBeenCalledTimes(1);
      h.confirmations[1].onOk(); await flush();
      expect(h.api.profile.trashPurge).toHaveBeenCalledTimes(2);
      expect(h.api.profile.trashList).toHaveBeenCalledTimes(2);
      expect(h.error.hidden).toBe(true);
    });
  });
}

it("guards delete during confirmation and pending IPC, including repeated confirm callbacks", async () => {
  const h = harness(), pending = deferred<any>();
  h.api.profile.trash.mockReturnValueOnce(pending.promise);
  h.agentBrowser.delProfile(ID); h.agentBrowser.delProfile(ID);
  expect(h.confirmations).toHaveLength(1);
  expect(h.card.getAttribute("aria-busy")).toBe("true");
  h.confirmations[0].onOk(); h.confirmations[0].onOk(); await flush();
  h.agentBrowser.delProfile(ID);
  expect(h.api.profile.trash).toHaveBeenCalledTimes(1);
  pending.resolve({ success: false, error: ERROR }); await flush();
  h.agentBrowser.delProfile(ID);
  expect(h.confirmations).toHaveLength(2);
  h.confirmations[1].cancel(); await flush();
  expect(h.card.getAttribute("aria-busy")).toBe("false");
});

it("makes restore/purge mutually exclusive per ID while another ID remains actionable", async () => {
  const h = harness(), pending = deferred<any>();
  h.agentBrowser.showTrash(); await flush();
  h.api.profile.trashRestore.mockReturnValueOnce(pending.promise);
  h.button("restore").click(); h.button("restore").click(); h.button("purge").click();
  expect(h.button("purge").getAttribute("disabled")).not.toBeNull();
  expect(h.confirmations).toHaveLength(0);
  expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(1);
  h.agentBrowser.showTrash(); await flush(); // A manual re-open must preserve the pending guard.
  h.button("restore").click(); h.button("purge").click();
  expect(h.button("restore").getAttribute("disabled")).not.toBeNull();
  expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(1);
  h.button("purge", OTHER).click();
  expect(h.confirmations).toHaveLength(1);
  h.confirmations[0].cancel(); await flush();
  expect(h.button("purge", OTHER).getAttribute("disabled")).toBeNull();
  pending.resolve({ success: false, error: ERROR }); await flush();
  expect(h.button("restore").getAttribute("disabled")).toBeNull();
});

it("guards purge confirmation/write, cancel/retry, and a re-render of a failed purge", async () => {
  const h = harness(), pending = deferred<any>();
  h.agentBrowser.showTrash(); await flush();
  h.button("purge").click(); h.button("purge").click(); h.button("restore").click();
  expect(h.confirmations).toHaveLength(1);
  expect(h.api.profile.trashRestore).not.toHaveBeenCalled();
  h.confirmations[0].cancel(); await flush();
  expect(h.button("restore").getAttribute("disabled")).toBeNull();
  h.api.profile.trashPurge.mockReturnValueOnce(pending.promise);
  h.button("purge").click();
  h.confirmations[1].onOk(); h.confirmations[1].onOk(); await flush();
  h.button("restore").click(); h.button("purge").click();
  expect(h.api.profile.trashPurge).toHaveBeenCalledTimes(1);
  expect(h.confirmations).toHaveLength(2);
  pending.resolve({ success: false, error: ERROR }); await flush();
  h.agentBrowser.showTrash(); await flush();
  expect(h.list.querySelector(`[data-trash-restore="${ID}"]`)).toBeNull();
  expect(h.button("purge").getAttribute("disabled")).toBeNull();
});

async function retainedUndo(h: ReturnType<typeof harness>, ids = [ID]): Promise<() => void> {
  if (ids.length === 1) h.agentBrowser.delProfile(ids[0]);
  else {
    ids.forEach((id) => h.agentBrowser.toggleProfileSelect(id, true));
    h.agentBrowser.batchDeleteSelected();
    await flush();
  }
  h.confirmations.at(-1)!.onOk();
  await flush();
  const success = h.helpers.toast.mock.calls.at(-1)!;
  expect(success[1], JSON.stringify(success)).toBe("success");
  expect(success[2]).toMatchObject({ ttlMs: 12000, action: { label: "Undo" } });
  // Batch delete refreshes on success; measure only subsequent restore effects.
  h.api.browser.list.mockClear();
  h.agentBrowser.loadTab.mockClear();
  return success[2].action.onClick;
}

function expectNoRestoreFailureRefresh(h: ReturnType<typeof harness>) {
  expect(h.api.browser.list).not.toHaveBeenCalled();
  expect(h.agentBrowser.loadTab).not.toHaveBeenCalled();
  expect(h.api.profile.trashList).toHaveBeenCalledTimes(1);
}

for (const rejected of [false, true]) {
  const settleFailure = (pending: ReturnType<typeof deferred<any>>) => rejected
    ? pending.reject(new Error(ERROR)) : pending.resolve({ success: false, error: ERROR });
  describe(`F09 cross-entry ${rejected ? "rejection" : "returned failure"}`, () => {
    it("blocks retained single Undo during a modal restore, then releases the ID for a successful retry", async () => {
      const h = harness(), pending = deferred<any>();
      const undo = await retainedUndo(h);
      h.agentBrowser.showTrash(); await flush();
      h.api.profile.trashRestore.mockReturnValueOnce(pending.promise);
      h.button("restore").click();
      undo(); await flush();
      expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(1);
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Restored 0, 1 could not be restored", "error", {
        detail: `${ID}: This profile is busy — wait for the current operation to finish`,
      });
      expect(h.button("restore").getAttribute("disabled")).not.toBeNull();
      expect(h.button("purge").getAttribute("disabled")).not.toBeNull();
      expectNoRestoreFailureRefresh(h);
      settleFailure(pending); await flush();
      assertDetail(h, "Could not restore profile");
      expectNoRestoreFailureRefresh(h);
      undo(); await flush();
      expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(2);
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Restored 1 profiles", "success");
      expect(h.api.browser.list).toHaveBeenCalledTimes(1);
      expect(h.button("restore").getAttribute("disabled")).toBeNull();
    });

    it("makes single Undo exclude modal restore/purge and a second Undo until its deferred IPC finishes", async () => {
      const h = harness(), pending = deferred<any>();
      const undo = await retainedUndo(h);
      h.agentBrowser.showTrash(); await flush();
      h.api.profile.trashRestore.mockReturnValueOnce(pending.promise);
      undo();
      h.button("restore").click(); h.button("purge").click(); undo(); await flush();
      expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(1);
      expect(h.api.profile.trashPurge).not.toHaveBeenCalled();
      expect(h.confirmations).toHaveLength(1); // Only the original single delete.
      expect(h.button("restore").getAttribute("disabled")).not.toBeNull();
      expect(h.button("purge").getAttribute("disabled")).not.toBeNull();
      expectNoRestoreFailureRefresh(h);
      settleFailure(pending); await flush();
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Restored 0, 1 could not be restored", "error", { detail: `${ID}: ${ERROR}` });
      expect(h.button("restore").getAttribute("disabled")).toBeNull();
      expectNoRestoreFailureRefresh(h);
      undo(); await flush();
      expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(2);
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Restored 1 profiles", "success");
      expect(h.api.browser.list).toHaveBeenCalledTimes(1);
    });

    it("blocks retained Undo throughout purge confirmation, deferred IPC, failure, and a cancelled retry", async () => {
      const h = harness(), pending = deferred<any>();
      const undo = await retainedUndo(h);
      h.agentBrowser.showTrash(); await flush();
      h.api.profile.trashPurge.mockReturnValueOnce(pending.promise);
      h.button("purge").click();
      undo(); await flush(); // No purge IPC yet: the confirmation already owns the ID.
      expect(h.api.profile.trashRestore).not.toHaveBeenCalled();
      expect(h.api.profile.trashPurge).not.toHaveBeenCalled();
      expectNoRestoreFailureRefresh(h);
      h.confirmations[1].onOk(); await flush();
      undo(); await flush();
      expect(h.api.profile.trashPurge).toHaveBeenCalledTimes(1);
      expect(h.api.profile.trashRestore).not.toHaveBeenCalled();
      expectNoRestoreFailureRefresh(h);
      settleFailure(pending); await flush();
      assertDetail(h, "Could not permanently delete profile");
      undo(); await flush();
      expect(h.api.profile.trashRestore).not.toHaveBeenCalled();
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Restored 0, 1 could not be restored", "error", {
        detail: `${ID}: Data may be incomplete after a purge attempt; do not restore as complete.`,
      });
      expect(h.detail.textContent).toBe(`${ID}: ${ERROR}`); // Preserve original recovery paths; no false rollback.
      expectNoRestoreFailureRefresh(h);
      h.button("purge").click(); h.confirmations[2].cancel(); await flush();
      undo(); h.button("restore").click(); await flush();
      expect(h.api.profile.trashRestore).not.toHaveBeenCalled();
      expect(h.api.profile.trashPurge).toHaveBeenCalledTimes(1);
      expectNoRestoreFailureRefresh(h);
    });

    it("tallies blocked IDs independently in batch Undo without releasing another entry's pending operation", async () => {
      const third = "f09_renderer_c", h = harness();
      const undo = await retainedUndo(h, [ID, OTHER, third]);
      h.api.profile.trashList.mockResolvedValue({ success: true, entries: [ID, OTHER, third].map((dirId) => ({ dirId, name: dirId, recoverable: true })) });
      h.agentBrowser.showTrash(); await flush();
      const purge = deferred<any>(), modalRestore = deferred<any>(), undoRestore = deferred<any>();
      h.api.profile.trashPurge.mockReturnValueOnce(purge.promise);
      h.button("purge").click(); h.confirmations[1].onOk(); await flush();
      settleFailure(purge); await flush();
      h.api.profile.trashRestore.mockReturnValueOnce(modalRestore.promise).mockReturnValueOnce(undoRestore.promise);
      h.button("restore", OTHER).click();
      undo(); await flush();
      expect(h.api.profile.trashRestore.mock.calls.map(([id]) => id)).toEqual([OTHER, third]);
      expect(h.button("purge", OTHER).getAttribute("disabled")).not.toBeNull();
      expect(h.button("restore", third).getAttribute("disabled")).not.toBeNull();
      h.button("purge", OTHER).click(); h.button("restore", OTHER).click();
      expect(h.confirmations).toHaveLength(2);
      expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(2);
      expectNoRestoreFailureRefresh(h);
      undoRestore.resolve({ success: true }); await flush();
      expect(h.helpers.toast).toHaveBeenLastCalledWith("Restored 1, 2 could not be restored", "error", {
        detail: `${ID}: Data may be incomplete after a purge attempt; do not restore as complete.\n` +
          `${OTHER}: This profile is busy — wait for the current operation to finish`,
      });
      expect(h.api.browser.list).toHaveBeenCalledTimes(1); // Only the actually successful restore refreshes.
      expect(h.api.profile.trashList).toHaveBeenCalledTimes(1);
      expect(h.button("purge", OTHER).getAttribute("disabled")).not.toBeNull();
      expect(h.button("restore").getAttribute("disabled")).not.toBeNull();
      settleFailure(modalRestore); await flush();
      expect(h.api.browser.list).toHaveBeenCalledTimes(1);
      expect(h.api.profile.trashList).toHaveBeenCalledTimes(1);
      expect(h.button("restore", OTHER).getAttribute("disabled")).toBeNull();
    });
  });
}

for (const id of ["toString", "valueOf", "hasOwnProperty", ID]) {
  it(`allows single delete for supported ID ${id} but excludes duplicates until its deferred IPC finishes`, async () => {
    expect(() => validateDirId(id)).not.toThrow();
    const h = harness(), pending = deferred<any>();
    h.api.profile.trash.mockReturnValueOnce(pending.promise);
    h.agentBrowser.delProfile(id); h.agentBrowser.delProfile(id);
    expect(h.confirmations).toHaveLength(1);
    expect(h.card.getAttribute("aria-busy")).toBe("true");
    h.confirmations[0].onOk(); h.confirmations[0].onOk(); await flush();
    h.agentBrowser.delProfile(id);
    expect(h.api.profile.trash.mock.calls.map(([id]) => id)).toEqual([id]);
    pending.reject(new Error(ERROR)); await flush();
    expect(h.card.getAttribute("aria-busy")).toBe("false");
    expect(h.helpers.toast).toHaveBeenLastCalledWith("Could not delete profile", "error", { detail: `${id}: ${ERROR}`, ttlMs: 0 });
    expect(h.agentBrowser.loadTab).not.toHaveBeenCalled();
    await retainedUndo(h, [id]);
    expect(h.api.profile.trash.mock.calls.map(([id]) => id)).toEqual([id, id]);
  });

  it(`restores, single-deletes, Undoes and purges supported ID ${id} through the renderer and real backend`, async () => {
    expect(() => validateDirId(id)).not.toThrow();
    getConfig();
    const config = path.join(STORAGE_ROOT, "config.json"), index = path.join(STORAGE_ROOT, "trash", "index.json");
    const live = path.join(STORAGE_ROOT, "profiles", id, "Default", "sentinel.txt");
    const trash = path.join(STORAGE_ROOT, "trash", "profiles", id, "Default", "sentinel.txt");
    const meta = { name: `Supported ${id}`, engine: "chromium", note: "F09 supported ID" };
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.writeFileSync(trash, `F09-supported-${id}`);
    fs.writeFileSync(index, JSON.stringify([{ dirId: id, name: meta.name, deletedAt: Date.now(), meta }]));
    const h = harness();
    h.api.profile.trashList.mockImplementation(async () => ({ success: true, entries: listTrashedProfiles() }));
    h.api.profile.trashRestore.mockImplementation(async (id) => ({ success: restoreTrashedProfile(id) }));
    h.api.profile.trash.mockImplementation(async (id) => ({ success: trashBrowserProfile(id) }));
    h.api.profile.trashPurge.mockImplementation(async (id) => ({ success: purgeTrashedProfile(id) }));
    function readback(restored: boolean, indexed: boolean) {
      expect(Object.hasOwn(JSON.parse(fs.readFileSync(config, "utf8")).browserProfiles, id)).toBe(restored);
      expect(JSON.parse(fs.readFileSync(index, "utf8")).some((entry: any) => entry.dirId === id)).toBe(indexed);
      reloadConfig();
      expect(getProfileMeta(id)).toEqual(restored ? expect.objectContaining(meta) : null);
      expect(listBrowserProfiles().some((profile) => profile.dirId === id)).toBe(restored);
      expect(listTrashedProfiles().some((entry) => entry.dirId === id)).toBe(indexed);
      expect(fs.existsSync(live)).toBe(restored);
      expect(fs.existsSync(trash)).toBe(indexed);
      if (restored || indexed) expect(fs.readFileSync(restored ? live : trash, "utf8")).toBe(`F09-supported-${id}`);
    }
    h.agentBrowser.showTrash(); await flush();
    expect(h.button("restore", id).getAttribute("disabled")).toBeNull();
    expect(h.button("purge", id).getAttribute("disabled")).toBeNull();
    h.button("restore", id).click(); await flush();
    expect(h.api.profile.trashRestore).toHaveBeenCalledWith(id);
    readback(true, false);
    const undo = await retainedUndo(h, [id]); // busyCards must not mistake an inherited name for pending work.
    expect(h.api.profile.trash).toHaveBeenCalledWith(id);
    expect(h.card.getAttribute("aria-busy")).toBe("false");
    readback(false, true);
    undo(); await flush();
    expect(h.api.profile.trashRestore).toHaveBeenCalledTimes(2);
    readback(true, false);
    await retainedUndo(h, [id]);
    readback(false, true);
    h.agentBrowser.showTrash(); await flush();
    h.button("purge", id).click();
    expect(h.confirmations).toHaveLength(3);
    h.confirmations[2].onOk(); await flush();
    expect(h.api.profile.trashPurge).toHaveBeenCalledWith(id);
    readback(false, false);
    expect(JSON.parse(fs.readFileSync(index, "utf8"))).toEqual([]);
  });
}

for (const running of [false, true]) {
  it(`refuses renderer deletion with ${running ? "an unverified running owner" : "unavailable discovery"} and conserves persisted data`, async () => {
    const id = running ? "f09_refused_running" : "f09_refused_unknown";
    getConfig();
    const config = path.join(STORAGE_ROOT, "config.json"), index = path.join(STORAGE_ROOT, "trash", "index.json");
    const live = path.join(STORAGE_ROOT, "profiles", id, "Default", "sentinel.txt");
    const trash = path.join(STORAGE_ROOT, "trash", "profiles", id, "Default", "sentinel.txt");
    const meta = { name: id, engine: "chromium", note: "Synthetic runtime refusal" };
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.writeFileSync(trash, `F09-refused-${id}`);
    fs.writeFileSync(index, JSON.stringify([{ dirId: id, name: id, deletedAt: Date.now(), meta }]));
    expect(restoreTrashedProfile(id)).toBe(true);
    const savedConfig = fs.readFileSync(config, "utf8"), savedIndex = fs.readFileSync(index, "utf8");
    const h = harness();
    h.api.profile.trash.mockImplementation(async (id) => ({ success: trashBrowserProfile(id) }));
    if (running) {
      // Unknown ownership blocks deletion without adopting a fake PID (or
      // probing a real process on a subsequent status/readback).
      discovery.findBrowserByProfileSync.mockReturnValueOnce({ pid: 1234, cdpPort: 0, unknown: true });
    } else {
      discovery.findBrowserByProfileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error("Synthetic process discovery unavailable"), { code: "PROCESS_DISCOVERY_UNAVAILABLE" });
      });
    }
    h.agentBrowser.delProfile(id);
    h.confirmations[0].onOk(); await flush();
    expect(discovery.findBrowserByProfileSync).toHaveBeenCalledExactlyOnceWith(id, path.join(STORAGE_ROOT, "profiles", id), { strict: true });
    expect(h.api.profile.trash).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.helpers.toast).toHaveBeenCalledTimes(1);
    expect(h.helpers.toast).toHaveBeenLastCalledWith("Could not delete profile", "error", {
      detail: `${id}: ${running ? "Cannot delete profile while managed Chromium is running" : "Cannot move profile to trash: runtime state is unknown. Stop it normally and retry after exit is confirmed."}`,
      ttlMs: 0,
    });
    expect(h.card.getAttribute("aria-busy")).toBe("false");
    expect(h.checkbox.checked).toBe(true);
    expect(h.agentBrowser.loadTab).not.toHaveBeenCalled();
    expect(h.api.browser.list).not.toHaveBeenCalled();
    expect(h.api.profile.trashList).not.toHaveBeenCalled();
    expect(fs.readFileSync(config, "utf8")).toBe(savedConfig);
    expect(fs.readFileSync(index, "utf8")).toBe(savedIndex);
    expect(fs.readFileSync(live, "utf8")).toBe(`F09-refused-${id}`);
    expect(fs.existsSync(trash)).toBe(false);
    reloadConfig();
    expect(getProfileMeta(id)).toEqual(expect.objectContaining(meta));
    expect(listBrowserProfiles().some((profile) => profile.dirId === id)).toBe(true);
    expect(listTrashedProfiles().some((entry) => entry.dirId === id)).toBe(false);
  });
}

it("defines a foreground modal error outside the list and mirrors all short translations", () => {
  const dlg = HTML.slice(HTML.indexOf('<dialog id="dlg-trash"'), HTML.indexOf("</dialog>", HTML.indexOf('<dialog id="dlg-trash"')));
  expect(dlg).toMatch(/id="trash-action-error"[^>]*role="alert"/);
  expect(dlg).toContain('class="trash-action-summary"');
  expect(dlg).toContain('class="toast-detail"');
  expect(dlg.indexOf('id="trash-action-error"')).toBeLessThan(dlg.indexOf('id="trash-list"'));
  expect(fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8")).toBe(I18N);
  for (const lang of ["en-US", "zh-CN"]) {
    const h = harness(lang);
    for (const action of ["delete", "restore", "purge"]) {
      const key = `toast.trash.${action}-failed`;
      // Exercise the real dictionaries, not a fallback-echo i18n stub.
      const text = h.i18n.t(key, "MISSING");
      expect(text).not.toBe("MISSING");
      expect(text).not.toMatch(/EACCES|viewer|workspace role/);
      if (lang === "zh-CN") expect(text).toMatch(/[一-鿿]/);
    }
  }
});
