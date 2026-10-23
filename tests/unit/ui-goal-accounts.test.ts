// Whole accounts.js module in a controlled synthetic DOM/provider fixture.
// Native rendering/clipboard are not exercised. Storage cases use real config
// bytes and services in a unique owned directory, never the host user data.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as configService from "../../src/main/services/config-manager.js";
import * as accountStore from "../../src/main/services/config/store.js";
import * as httpAuth from "../../src/main/services/http/auth.js";
import * as httpBody from "../../src/main/services/http/body.js";
import * as serverMode from "../../src/main/services/server-mode.js";
import * as branding from "../../src/main/branding.js";
import ts from "typescript";
import * as accountService from "../../src/main/services/local-agent.js";
import * as teamService from "../../src/main/services/team.js";
import { recordAudit } from "../../src/main/services/audit-log.js";
import type { AgentBrowserAPI, AccountReference } from "../../src/renderer/api.js";

const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-accounts-store-"));
vi.mock("electron", () => ({
  app: { getPath: () => STORAGE_ROOT },
  BrowserWindow: { getAllWindows: () => [] },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
  safeStorage: { isEncryptionAvailable: () => { throw new Error("Native secret storage forbidden in this fixture"); } },
}));
import { getConfig, getConfigPath, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { addAccount, deleteAccount, getAccounts, getRedactedAccount, getAccountPassword, getProfileAccounts, getRedactedAccounts, setAccountProfileIds, updateAccount } from "../../src/main/services/local-agent.js";
import { initializeSecretStorage, planSecretStorage, resetSecretStorageForTests } from "../../src/main/services/secrets.js";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/app/accounts.js"), "utf8");
const ACCOUNT = { platformUrl: "https://fixture.invalid", platformUserName: "fixture-alice", tags: ["synthetic"], profileIds: ["fixture_profile_a"], hasPassword: true, ref: { index: 0, revision: "fixture-original-revision" } };
const SECOND = { ...ACCOUNT, platformUserName: "fixture-bob", profileIds: ["fixture_profile_b"], ref: { index: 1, revision: ACCOUNT.ref.revision } };
const PROFILES = [{ dirId: "fixture_profile_a", name: "Synthetic A" }, { dirId: "fixture_profile_b", name: "Synthetic B" }];

class Element {
  tag = "div";
  attributes: Record<string, string> = {};
  private nodes: Element[] = [];
  get children() { return this.nodes; }
  set children(nodes: Element[]) { this.nodes = nodes; for (const node of nodes) node.parentElement = this; }
  parentElement: Element | null = null;
  id = "";
  classList = { contains: (c: string) => (this.attributes.class || "").split(" ").includes(c), toggle: vi.fn(), add: vi.fn(), remove: vi.fn() };
  get dataset(): Record<string, string> { return Object.fromEntries(Object.entries(this.attributes).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v])); }
  get tagName() { return this.tag.toUpperCase(); }
  matches(selector: string) {
    if (selector.includes(" > ") || selector.includes(",")) return false;
    if (selector.startsWith(".") && !this.classList.contains(selector.match(/^\.([\w-]+)/)?.[1] || "")) return false;
    if (/^[a-z]/.test(selector) && selector.match(/^[a-z]+/)?.[0] !== this.tag) return false;
    return [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(a => this.attributes[a[1]] !== undefined && (a[2] === undefined || a[2] === this.attributes[a[1]]));
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  appendChild(child: Element) { child.parentElement = this; this.nodes.push(child); return child; }
  insertBefore(child: Element) { return this.appendChild(child); }
  focus = vi.fn();
  click = () => { this.emit?.("click", this); };
  emit?: (kind: string, target: Element) => void;
  listeners: Record<string, Array<() => void>> = {};
  style: Record<string, string> = { display: "" };
  private inputValue = "";
  get value() { return this.inputValue; }
  set value(value: string | number) { this.inputValue = String(value); }
  checked = false;
  disabled = false;
  open = false;
  placeholder = "";
  private text = "";
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = String(value); this.html = this.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); this.children = []; }
  html = "";
  showModal = vi.fn(() => { this.open = true; });
  close = vi.fn(() => { this.open = false; this.dispatch("close"); });
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
    // Materialize the real module's emitted controls, so functional assertions
    // inspect actual control state rather than source strings/slices.
    for (const m of value.matchAll(/<(button|input)\b([^>]*)>/g)) {
      const child = new Element();
      child.tag = m[1];
      for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.attributes[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      child.parentElement = this;
      child.value = child.attributes.value || "";
      child.checked = /\bchecked\b/.test(m[2]);
      child.disabled = /\bdisabled\b/.test(m[2]);
      this.children.push(child);
    }
  }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  addEventListener(k: string, fn: () => void) { (this.listeners[k] ||= []).push(fn); }
  dispatch(k: string) { for (const fn of this.listeners[k] || []) fn(); }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap(c => [c, ...c.querySelectorAll("*")]);
    return all.filter(c => {
      if (selector === "*") return true;
      if (!c.matches(selector.replace(/:checked/g, ""))) return false;
      if (selector.includes(".acct-bind-cb") && !(c.attributes.class || "").split(" ").includes("acct-bind-cb")) return false;
      if (selector.includes(":checked") && !c.checked) return false;
      const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
      return attrs.every(a => c.attributes[a[1]] !== undefined && (a[2] === undefined || c.attributes[a[1]] === a[2]));
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}
function button(cmd: string) { const el = new Element(); el.tag = "button"; el.attributes["data-cmd"] = cmd; return el; }
async function flush() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function harness(role = "owner", execute = true) {
  const elements: Record<string, Element> = {};
  for (const id of ["accounts-tab-list", "agent-accounts-list", "dlg-account", "dlg-account-title", "acct-edit-index", "acct-url", "acct-username", "acct-password", "acct-tags", "dlg-account-bind", "acct-bind-index", "acct-bind-list", "dlg-account-import", "acct-import-text", "acct-import-status", "acct-import-create-profiles", "acct-import-create-options", "acct-import-platform", "tab-accounts", "tab-agent"]) elements[id] = new Element();
  const add = button("agentAddAccount"), agentAdd = button("agentAddAccount");
  const importBtn = button("agentImportAccounts"), exportBtn = button("agentExportAccounts");
  elements["acct-bulk-import-btn"] = importBtn; elements["acct-export-btn"] = exportBtn;
  elements["tab-accounts"].children = [add, importBtn, exportBtn, elements["accounts-tab-list"]];
  elements["tab-agent"].children = [agentAdd, elements["agent-accounts-list"]];
  const saveBind = button("agentSaveAccountBind");
  elements["dlg-account-bind"].children = [elements["acct-bind-list"], saveBind];
  const saveAccount = new Element(); saveAccount.tag = "button"; saveAccount.attributes.type = "submit";
  elements["dlg-account"].children = [saveAccount];
  elements["acct-edit-index"].value = elements["acct-bind-index"].value = "-1";
  const accounts = {
    list: vi.fn(async (): Promise<any[]> => [structuredClone(ACCOUNT), structuredClone(SECOND)]),
    get: vi.fn(async (i: number, _ref?: any): Promise<any> => structuredClone(i === 0 ? ACCOUNT : SECOND)),
    bind: vi.fn(async (_i: number, _ids: string[], _ref?: any): Promise<any> => ({ ...ACCOUNT })),
    update: vi.fn(async (_i: number, _a: any, _ref?: any): Promise<any> => ({ ...ACCOUNT })),
    add: vi.fn(async (_a: any): Promise<any> => ({ ...ACCOUNT })),
    delete: vi.fn(async (_i: number, _ref?: any): Promise<boolean> => true),
    bulkAdd: vi.fn(async (_s: string): Promise<any> => ({ added: 1 })),
    bulkCreate: vi.fn(async (_s: string, _o: any): Promise<any> => ({ added: 1, created: 1 })),
    copyUsername: vi.fn(async (_i: number, _ref?: any) => ({ ok: true })),
    copyPassword: vi.fn(async (_i: number, _ref?: any) => ({ ok: true })),
  };
  const api = { browser: { list: vi.fn(async (): Promise<any[]> => structuredClone(PROFILES)) }, team: { status: vi.fn(async (): Promise<any> => ({ local: { role } })) } };
  const toast = vi.fn();
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const confirmations: Array<() => void> = [];
  const agentBrowser: any = {
    api, R: { agent: { accounts } }, state: { currentTab: "accounts" },
    helpers: { toast, esc, escAttr: esc, icon: () => "<svg></svg>" },
    confirm: vi.fn((_msg: string, onOk: () => void) => { confirmations.push(onOk); }),
    renderViewState: vi.fn((el: Element, options: any) => {
      el.innerHTML = options.error ? esc(options.error) : esc(options.empty || "");
      if (options.cta) el.children.push(button(options.cta.cmd));
      if (options.retry) { const retry = button(options.retry.cmd); retry.attributes["data-cmd-arg"] = options.retry.arg; el.children.push(retry); }
    }),
  };
  const document = {
    getElementById: (id: string) => elements[id] || null,
    querySelectorAll: (selector: string): Element[] => {
      if (selector === '[data-cmd="agentAddAccount"]') return [add, agentAdd];
      const match = selector.match(/^#([\w-]+)\s+(.+)$/);
      return match ? elements[match[1]]?.querySelectorAll(match[2]) || [] : [];
    },
    querySelector: (selector: string): Element | null => document.querySelectorAll(selector)[0] || null,
  };
  if (execute) vm.runInNewContext(SOURCE, { window: { agentBrowser }, document, console, setTimeout, clearTimeout, Blob, URL });
  return { agentBrowser, accounts, api, toast, elements, saveBind, saveAccount, add, agentAdd, importBtn, exportBtn, confirmations, document };
}
function successes(h: ReturnType<typeof harness>) { return h.toast.mock.calls.filter(c => c[1] === "success"); }
function mutations(h: ReturnType<typeof harness>) { return [h.accounts.bind, h.accounts.update, h.accounts.add, h.accounts.delete, h.accounts.bulkAdd, h.accounts.bulkCreate, h.accounts.copyPassword]; }

beforeEach(() => {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  initializeSecretStorage(planSecretStorage({ userDataDir: STORAGE_ROOT, environment: { AGENT_BROWSER_SECRET_BACKEND: "file" } }));
  reloadConfig();
  const cfg = getConfig(); cfg.accounts = []; delete cfg.team; saveConfig(cfg);
});
afterAll(() => {
  resetSecretStorageForTests();
  if (path.dirname(STORAGE_ROOT) !== os.tmpdir() || !path.basename(STORAGE_ROOT).startsWith("ui-goal-accounts-store-")) throw new Error("Unsafe cleanup");
  fs.rmSync(STORAGE_ROOT, { force: true, recursive: true });
});
describe("account-import OS defaults (whole renderer entrypoints)", () => {
  it("offers an automatic host default in the real account-import markup", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
    const select = html.match(/<select id="acct-import-platform"[^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(select).toMatch(/^\s*<option value="" selected data-i18n="profile\.new\.platform\.auto">Auto \(host OS\)<\/option>/);
  });

  it("opening a new account-import form resets a prior explicit OS to automatic", async () => {
    const h = harness(); h.elements["acct-import-platform"].value = "windows";
    await h.agentBrowser.agentImportAccounts();
    expect(h.elements["dlg-account-import"].open).toBe(true);
    expect(h.elements["acct-import-platform"].value).toBe("");
    expect(h.accounts.bulkCreate).not.toHaveBeenCalled();
  });

  it.each(["", "windows", "macos"])("account import forwards %j without manufacturing Windows when automatic", async platform => {
    const h = harness(); await h.agentBrowser.agentImportAccounts();
    h.elements["acct-import-create-profiles"].checked = true;
    h.elements["acct-import-platform"].value = platform;
    h.elements["acct-import-text"].value = "https://defaults.synthetic.invalid,import-default";
    await h.agentBrowser.agentRunAccountImport(); await flush();
    expect(h.accounts.bulkCreate).toHaveBeenCalledExactlyOnceWith("https://defaults.synthetic.invalid,import-default", { platform: platform || undefined });
    expect(h.accounts.bulkAdd).not.toHaveBeenCalled();
  });
});

const realHarnesses = new WeakSet<object>();
function realStore(h: ReturnType<typeof harness>) {
  realHarnesses.add(h);
  addAccount({ platformUrl: ACCOUNT.platformUrl, platformUserName: ACCOUNT.platformUserName, platformPassword: "synthetic-secret-only", profileIds: ACCOUNT.profileIds, tags: ACCOUNT.tags });
  h.accounts.list.mockImplementation(async () => getRedactedAccounts());
  h.accounts.get.mockImplementation(async (i, ref) => getRedactedAccount(i, ref));
  h.accounts.bind.mockImplementation(async (i, ids, ref) => setAccountProfileIds(i, ids, ref));
  h.accounts.update.mockImplementation(async (i, a, ref) => updateAccount(i, a, ref));
}
function target(h: ReturnType<typeof harness>, i: number) { return realHarnesses.has(h) ? getRedactedAccounts()[i].ref : (i === 0 ? ACCOUNT.ref : SECOND.ref); }
function readAccountBytes() { return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).accounts; }
function assertStored(ids: string[] | undefined, username = ACCOUNT.platformUserName) {
  expect(readAccountBytes()[0].platformUserName).toBe(username);
  expect(readAccountBytes()[0].profileIds).toEqual(ids);
  expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain("synthetic-secret-only");
  reloadConfig();
  expect(getRedactedAccounts().find(a => a.platformUserName === username)?.profileIds).toEqual(ids);
  expect(getProfileAccounts(ids?.[0] || PROFILES[1].dirId).some(a => a.platformUserName === username)).toBe(true);
}

describe("binding readiness and real isolated persistence", () => {
  it("a failed profile read cannot clear existing stored bindings, including direct Save", async () => {
    const h = harness(); realStore(h);
    const before = fs.readFileSync(getConfigPath());
    h.api.browser.list.mockRejectedValueOnce(new Error("synthetic list failure"));
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(true);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(readAccountBytes()[0].profileIds).toEqual(ACCOUNT.profileIds);
    expect(h.accounts.bind).not.toHaveBeenCalled();
    expect(h.saveBind.disabled).toBe(true);
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    expect(successes(h)).toEqual([]);
    const retry = h.elements["acct-bind-list"].querySelector('[data-cmd="agentBindAccounts"]');
    expect(JSON.parse(retry!.getAttribute("data-cmd-arg")!)).toEqual(getRedactedAccounts()[0].ref);
    h.agentBrowser.agentBindAccounts(retry?.getAttribute("data-cmd-arg")); await flush();
    expect(h.saveBind.disabled).toBe(false);
    expect(h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb:checked").map(c => c.value)).toEqual(ACCOUNT.profileIds);
    assertStored(ACCOUNT.profileIds);
  });

  it("Save is guarded throughout delayed account AND delayed profile reads", async () => {
    const h = harness(), accounts = deferred<any[]>(), profiles = deferred<any[]>();
    h.accounts.get.mockReturnValueOnce(accounts.promise.then(rows => rows[0]));
    h.api.browser.list.mockReturnValueOnce(profiles.promise);
    h.agentBrowser.agentBindAccounts(target(h, 0));
    expect(h.saveBind.disabled).toBe(true);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).not.toHaveBeenCalled();
    accounts.resolve([ACCOUNT]); await flush();
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).not.toHaveBeenCalled();
    expect(h.saveBind.disabled).toBe(true);
    profiles.resolve(PROFILES); await flush();
    expect(h.saveBind.disabled).toBe(false);
  });

  it("a legitimate loaded empty selection unbinds, persists, reloads and remains searchable", async () => {
    const h = harness(); realStore(h);
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    expect(h.saveBind.disabled).toBe(false);
    h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb").forEach(c => { c.checked = false; });
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledExactlyOnceWith(0, [], expect.objectContaining({ index: 0, revision: expect.any(String) }));
    assertStored(undefined);
    expect(h.elements["dlg-account-bind"].open).toBe(false);
    expect(successes(h)).toHaveLength(1);
  });

  it("a successfully loaded zero-profile list also allows intentional unbind", async () => {
    const h = harness(); realStore(h); h.api.browser.list.mockResolvedValue([]);
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    expect(h.saveBind.disabled).toBe(false);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledExactlyOnceWith(0, [], expect.objectContaining({ index: 0, revision: expect.any(String) }));
    assertStored(undefined);
  });

  it("duplicate Save during a pending bind cannot submit twice; rejection permits retry", async () => {
    const h = harness(), pending = deferred<any>();
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    h.accounts.bind.mockReturnValueOnce(pending.promise);
    h.agentBrowser.agentSaveAccountBind(); h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledTimes(1);
    expect(h.saveBind.disabled).toBe(true);
    pending.reject(new Error("synthetic write failure")); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(true);
    expect(h.saveBind.disabled).toBe(false);
    expect(successes(h)).toEqual([]);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledTimes(2);
  });
});

describe("stale results and dialog request ownership", () => {
  it("null update keeps the edit dialog open without a success toast", async () => {
    const h = harness(); realStore(h);
    h.agentBrowser.agentEditAccount(target(h, 0)); await flush();
    deleteAccount(0, getRedactedAccounts()[0].ref); const before = fs.readFileSync(getConfigPath());
    h.agentBrowser.saveAccount(); await flush();
    expect(h.elements["dlg-account"].open).toBe(true);
    expect(successes(h)).toEqual([]);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("reselect"), "error");
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    reloadConfig(); expect(getRedactedAccounts()).toEqual([]);
  });

  it("null bind keeps the binding dialog open without a success toast", async () => {
    const h = harness(); realStore(h);
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    deleteAccount(0, getRedactedAccounts()[0].ref); const before = fs.readFileSync(getConfigPath());
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(true);
    expect(successes(h)).toEqual([]);
    expect(h.saveBind.disabled).toBe(true);
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    reloadConfig(); expect(getRedactedAccounts()).toEqual([]);
  });

  it("late binding profile responses cannot replace a newer account's checklist", async () => {
    const h = harness(), first = deferred<any[]>();
    h.api.browser.list.mockReturnValueOnce(first.promise);
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    h.agentBrowser.agentBindAccounts(target(h, 1)); await flush();
    first.resolve(PROFILES); await flush();
    expect(h.elements["acct-bind-index"].value).toBe("1");
    expect(h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb:checked").map(c => c.value)).toEqual(SECOND.profileIds);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledExactlyOnceWith(1, SECOND.profileIds, SECOND.ref);
  });

  it("late account-read responses cannot take over a newer bind request", async () => {
    const h = harness(), first = deferred<any[]>();
    h.accounts.get.mockReturnValueOnce(first.promise.then(rows => rows[0]));
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    h.agentBrowser.agentBindAccounts(target(h, 1)); await flush();
    first.resolve([ACCOUNT, SECOND]); await flush();
    expect(h.elements["acct-bind-index"].value).toBe("1");
    expect(h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb:checked").map(c => c.value)).toEqual(SECOND.profileIds);
  });

  it("cancel while profiles load does not reopen or enable a cancelled dialog", async () => {
    const h = harness(), pending = deferred<any[]>(); h.api.browser.list.mockReturnValueOnce(pending.promise);
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    h.elements["dlg-account-bind"].close();
    pending.resolve(PROFILES); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(false);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).not.toHaveBeenCalled();
  });

  it("late binding errors cannot overwrite a newer ready request", async () => {
    const h = harness(), first = deferred<any[]>(); h.api.browser.list.mockReturnValueOnce(first.promise);
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush(); h.agentBrowser.agentBindAccounts(target(h, 1)); await flush();
    first.reject(new Error("old synthetic request failed")); await flush();
    expect(h.saveBind.disabled).toBe(false);
    expect(h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb")).toHaveLength(2);
    expect(h.agentBrowser.renderViewState).not.toHaveBeenCalled();
  });

  it("a late bind write cannot close a newer binding dialog or toast success for it", async () => {
    const h = harness(), write = deferred<any>();
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush(); h.accounts.bind.mockReturnValueOnce(write.promise);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    h.elements["dlg-account-bind"].close(); h.agentBrowser.agentBindAccounts(target(h, 1)); await flush();
    write.resolve(ACCOUNT); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(true);
    expect(h.elements["acct-bind-index"].value).toBe("1");
    expect(successes(h)).toEqual([]);
  });

  it("late rejected bind writes cannot report an error for a newer ready dialog", async () => {
    const h = harness(), write = deferred<any>();
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush(); h.accounts.bind.mockReturnValueOnce(write.promise);
    h.agentBrowser.agentSaveAccountBind(); await flush();
    h.elements["dlg-account-bind"].close(); h.agentBrowser.agentBindAccounts(target(h, 1)); await flush();
    write.reject(new Error("old synthetic bind write failure")); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(true);
    expect(h.saveBind.disabled).toBe(false);
    expect(h.toast.mock.calls.some(c => c[0] === "old synthetic bind write failure")).toBe(false);
  });

  it("the checklist's owned index cannot be replaced by a hidden-field change", async () => {
    const h = harness(); h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    h.elements["acct-bind-index"].value = "1"; h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).not.toHaveBeenCalled();
    h.elements["acct-bind-index"].value = "0"; h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledExactlyOnceWith(0, ACCOUNT.profileIds, ACCOUNT.ref);
  });

  it("late edit reads cannot overwrite a newer edit or Add dialog", async () => {
    const h = harness(), first = deferred<any[]>(); h.accounts.get.mockReturnValueOnce(first.promise.then(rows => rows[0]));
    h.agentBrowser.agentEditAccount(target(h, 0)); await flush(); h.agentBrowser.agentEditAccount(target(h, 1)); await flush();
    first.resolve([ACCOUNT, SECOND]); await flush();
    expect(h.elements["acct-username"].value).toBe(SECOND.platformUserName);
    const old = deferred<any[]>(); h.accounts.get.mockReturnValueOnce(old.promise.then(rows => rows[0]));
    h.agentBrowser.agentEditAccount(target(h, 0)); h.agentBrowser.agentAddAccount(); await flush();
    old.resolve([ACCOUNT, SECOND]); await flush();
    expect(h.elements["acct-edit-index"].value).toBe("-1");
    expect(h.elements["acct-username"].value).toBe("");
  });

  it("a late edit write cannot close a newer Add dialog or announce its success", async () => {
    const h = harness(), write = deferred<any>();
    h.agentBrowser.agentEditAccount(target(h, 0)); await flush(); h.accounts.update.mockReturnValueOnce(write.promise);
    h.agentBrowser.saveAccount(); await flush();
    h.elements["dlg-account"].close(); h.agentBrowser.agentAddAccount(); await flush();
    write.resolve(ACCOUNT); await flush();
    expect(h.elements["dlg-account"].open).toBe(true);
    expect(h.elements["acct-edit-index"].value).toBe("-1");
    expect(successes(h)).toEqual([]);
  });

  it("duplicate edit Save is guarded and a write error retains editable fields for retry", async () => {
    const h = harness(), write = deferred<any>();
    h.agentBrowser.agentEditAccount(target(h, 0)); await flush(); h.accounts.update.mockReturnValueOnce(write.promise);
    h.elements["acct-tags"].value = "retained";
    h.agentBrowser.saveAccount(); h.agentBrowser.saveAccount(); await flush();
    expect(h.accounts.update).toHaveBeenCalledTimes(1); expect(h.saveAccount.disabled).toBe(true);
    write.reject(new Error("synthetic edit write failure")); await flush();
    expect(h.elements["dlg-account"].open).toBe(true); expect(h.saveAccount.disabled).toBe(false);
    expect(h.elements["acct-tags"].value).toBe("retained"); expect(successes(h)).toEqual([]);
    h.agentBrowser.saveAccount(); await flush(); expect(h.accounts.update).toHaveBeenCalledTimes(2);
  });

  it("the initial top-level route alone gates the account toolbar", async () => {
    const h = harness("viewer"); h.agentBrowser.loadAccountsTab(); await flush();
    for (const el of [h.add, h.agentAdd, h.importBtn, h.exportBtn]) expect(el.style.display).toBe("none");
  });

  it("a failed account read in binding shows an error without unhandled rejection or writes", async () => {
    const h = harness(); h.accounts.get.mockRejectedValueOnce(new Error("synthetic account read failure"));
    h.agentBrowser.agentBindAccounts(target(h, 0)); await flush();
    h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.saveBind.disabled).toBe(true); expect(h.accounts.bind).not.toHaveBeenCalled();
    expect(h.agentBrowser.renderViewState).toHaveBeenCalledWith(h.elements["acct-bind-list"], expect.objectContaining({ error: "synthetic account read failure" }));
  });

  it("successful metadata edit persists actual bytes, reload/list/search and bindings", async () => {
    const h = harness(); realStore(h); h.agentBrowser.agentEditAccount(target(h, 0)); await flush();
    h.elements["acct-username"].value = "fixture-alice-updated";
    h.agentBrowser.saveAccount(); await flush();
    assertStored(ACCOUNT.profileIds, "fixture-alice-updated");
    expect(h.elements["dlg-account"].open).toBe(false);
    expect(successes(h)).toHaveLength(1);
  });

  it("rejects the original displayed target after a preceding deletion and preserves survivor bytes", async () => {
    const h = harness(); realStore(h);
    addAccount({ platformUrl: SECOND.platformUrl, platformUserName: SECOND.platformUserName, platformPassword: "synthetic-bob-secret", profileIds: SECOND.profileIds });
    const displayed = getRedactedAccounts();
    await h.agentBrowser.agentBindAccounts(displayed[1].ref); await flush();
    expect(deleteAccount(0, displayed[0].ref)).toBe(true);
    const before = fs.readFileSync(getConfigPath());
    h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb").forEach(c => { c.checked = c.value === PROFILES[0].dirId; });
    await h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    expect(h.elements["dlg-account-bind"].open).toBe(true);
    expect(h.saveBind.disabled).toBe(true); expect(successes(h)).toEqual([]);
    await h.agentBrowser.agentSaveAccountBind(); await flush();
    expect(h.accounts.bind).toHaveBeenCalledTimes(1);
    reloadConfig();
    expect(getAccounts()[0].platformUserName).toBe(SECOND.platformUserName);
    expect(getProfileAccounts(PROFILES[1].dirId).map(a => a.platformUserName)).toEqual([SECOND.platformUserName]);
    expect(getAccountPassword(0, getRedactedAccounts()[0].ref)).toBe("synthetic-bob-secret");
  });
});

describe("viewer gating on both account surfaces", () => {
  it("the initial top-level load gates both toolbars, Edit/Delete/Bind/password copy", async () => {
    const h = harness("viewer"); h.agentBrowser.loadAccountsTab(); h.agentBrowser.agentLoadAccounts(); await flush();
    for (const el of [h.add, h.agentAdd, h.importBtn, h.exportBtn]) expect(el.style.display).toBe("none");
    for (const id of ["accounts-tab-list", "agent-accounts-list"]) {
      const controls = h.elements[id].querySelectorAll("button");
      expect(controls).toHaveLength(2); // Username copy only, once per synthetic account.
      expect(controls.every(c => c.attributes["data-cmd"] === "agentCopyAccountUsername")).toBe(true);
    }
  });

  it("viewer empty states never offer Add on either surface", async () => {
    const h = harness("viewer"); h.accounts.list.mockResolvedValue([]);
    h.agentBrowser.agentLoadAccounts(); await flush();
    for (const id of ["accounts-tab-list", "agent-accounts-list"]) expect(h.elements[id].querySelector('[data-cmd="agentAddAccount"]')).toBeNull();
  });

  it("direct viewer mutation handlers neither open write dialogs nor dispatch writes", async () => {
    const h = harness("viewer");
    h.elements["acct-url"].value = ACCOUNT.platformUrl; h.elements["acct-username"].value = ACCOUNT.platformUserName; h.elements["acct-password"].value = "synthetic";
    h.agentBrowser.agentAddAccount(); h.agentBrowser.agentEditAccount(target(h, 0)); h.agentBrowser.agentDeleteAccount(ACCOUNT.ref);
    h.agentBrowser.agentBindAccounts(target(h, 0)); h.agentBrowser.saveAccount(); h.agentBrowser.agentSaveAccountBind();
    h.agentBrowser.agentImportAccounts(); h.agentBrowser.agentRunAccountImport(); h.agentBrowser.agentCopyAccountPassword(ACCOUNT.ref);
    await flush(); for (const onOk of h.confirmations) onOk(); await flush();
    for (const fn of mutations(h)) expect(fn).not.toHaveBeenCalled();
    for (const id of ["dlg-account", "dlg-account-bind", "dlg-account-import"]) expect(h.elements[id].open).toBe(false);
    expect(h.confirmations).toEqual([]);
  });

  it("pending/failed role lookup leaves controls read-only and denies direct Add", async () => {
    const h = harness(), role = deferred<any>(); h.api.team.status.mockReturnValueOnce(role.promise);
    h.agentBrowser.loadAccountsTab(); h.agentBrowser.agentAddAccount();
    expect(h.add.style.display).toBe("none"); expect(h.agentAdd.style.display).toBe("none");
    expect(h.elements["dlg-account"].open).toBe(false);
    role.reject(new Error("synthetic role lookup failure")); await flush();
    expect(h.add.style.display).toBe("none"); expect(h.elements["dlg-account"].open).toBe(false);
    expect(h.accounts.add).not.toHaveBeenCalled();
  });

  it("direct viewer Export remains gated like its hidden toolbar control", async () => {
    const h = harness("viewer"); h.agentBrowser.agentExportAccounts(); await flush();
    expect(h.accounts.list).not.toHaveBeenCalled(); expect(successes(h)).toEqual([]);
  });

  it("owner Add writes through the real service and reloads the complete synthetic account", async () => {
    const h = harness(); h.accounts.add.mockImplementation(async a => addAccount(a));
    h.accounts.list.mockImplementation(async () => getRedactedAccounts());
    h.agentBrowser.agentAddAccount(); await flush();
    h.elements["acct-url"].value = ACCOUNT.platformUrl; h.elements["acct-username"].value = ACCOUNT.platformUserName;
    h.elements["acct-password"].value = "synthetic-secret-only"; h.elements["acct-tags"].value = "synthetic, added";
    h.agentBrowser.saveAccount(); await flush();
    expect(h.accounts.add).toHaveBeenCalledTimes(1); expect(h.elements["dlg-account"].open).toBe(false);
    assertStored(undefined); expect(readAccountBytes()[0].tags).toEqual(["synthetic", "added"]);
    expect(getRedactedAccounts()[0].hasPassword).toBe(true); expect(successes(h)).toHaveLength(1);
  });

  it("owner empty state offers Add and both surfaces retain manage controls", async () => {
    const h = harness(); h.agentBrowser.agentLoadAccounts(); await flush();
    for (const el of [h.add, h.agentAdd, h.importBtn, h.exportBtn]) expect(el.style.display).toBe("");
    expect(h.elements["accounts-tab-list"].querySelectorAll("button")).toHaveLength(10);
    h.accounts.list.mockResolvedValue([]); h.agentBrowser.agentLoadAccounts(); await flush();
    expect(h.elements["accounts-tab-list"].querySelector('[data-cmd="agentAddAccount"]')).not.toBeNull();
    h.agentBrowser.agentAddAccount(); await flush(); expect(h.elements["dlg-account"].open).toBe(true);
  });
});

// Complete core/tabs/delegation/accounts/preload/agent IPC modules. Only unrelated
// service dependencies and external environment are replaced; no source slices.
function moduleHarness() {
  const h = harness("owner", false);
  const handlers = new Map<string, (...args: any[]) => any>();
  const clipboard = vi.fn(); // synthetic sink only; Electron is never loaded
  const blocked = vi.fn((name: string) => { throw new Error("Forbidden fixture call: " + name); });
  const other = new Proxy({}, { get: (_o, key) => (..._args: unknown[]) => blocked(String(key)) });
  const electron = { ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) }, clipboard: { writeText: clipboard }, dialog: other, BrowserWindow: other };
  const module = { exports: {} as any };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../src/main/ipc/agent.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === "electron") return electron;
    if (name.endsWith("/local-agent.js")) return accountService;
    if (name.endsWith("/team.js")) return teamService;
    if (name.endsWith("/audit-log.js")) return { recordAudit };
    return other;
  }, console, Buffer });
  module.exports.registerAgentHandlers();
  handlers.set("team:status", () => teamService.teamStatus());
  handlers.set("browser:list", () => h.api.browser.list());
  handlers.set("app:reload-config", () => reloadConfig());
  const trace: Array<{ channel: string; args: any[] }> = [];
  let facade!: AgentBrowserAPI;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../src/main/preload.cjs"), "utf8"), { require: (name: string) => {
    if (name !== "electron") return blocked(name);
    return { contextBridge: { exposeInMainWorld: (_name: string, api: AgentBrowserAPI) => { facade = api; } }, ipcRenderer: { invoke: async (channel: string, ...args: any[]) => {
      trace.push({ channel, args: structuredClone(args) });
      if (channel.startsWith("obs:")) return {};
      const fn = handlers.get(channel); if (!fn) return blocked(channel);
      try { return structuredClone(await fn({}, ...structuredClone(args))); }
      catch (e: any) { throw new Error("Error invoking remote method '" + channel + "': " + e.message); }
    }, on: vi.fn(), removeListener: vi.fn() } };
  }, console });
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const document: any = h.document;
  document.readyState = "complete";
  document.addEventListener = (kind: string, fn: (e: any) => void) => (listeners[kind] ||= []).push(fn);
  document.activeElement = null;
  document.createElement = (tag: string) => { const e = new Element(); e.tag = tag; return e; };
  for (const id of ["dlg-confirm", "dlg-confirm-msg", "dlg-confirm-title", "dlg-confirm-detail", "dlg-confirm-ack-wrap", "dlg-confirm-ack", "dlg-confirm-ack-label"]) h.elements[id] = new Element();
  for (const [id, el] of Object.entries(h.elements)) { el.id = id; if (id.startsWith("dlg-") && !id.includes("title") && !id.includes("detail") && !id.includes("ack") && !id.includes("msg")) el.tag = "dialog"; }
  const tabs = [h.elements["tab-accounts"], h.elements["tab-agent"]];
  tabs.forEach(el => el.attributes.class = "tab-content");
  const nav = ["accounts", "agent"].map(tab => { const el = button("switchTab"); el.attributes = { "data-role": "cmd", "data-cmd": "switchTab", "data-tab": tab, class: "nav-item", role: "tab" }; return el; });
  const originalQuery = document.querySelectorAll;
  document.querySelectorAll = (selector: string) => selector.startsWith(".nav-item") ? nav : selector === ".tab-content" ? tabs : originalQuery(selector);
  class Dialog extends Element { showModal = vi.fn(() => { this.open = true; }); }
  const window: any = { agentBrowserAPI: facade, addEventListener: vi.fn(), localStorage: { getItem: () => null } };
  const context = vm.createContext({ window, document, console, Blob, URL, setTimeout, clearTimeout, HTMLElement: Element, HTMLDialogElement: Dialog, navigator: { clipboard: { writeText: () => blocked("global clipboard") } } });
  function run(name: string) { vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/app/" + name + ".js"), "utf8"), context); }
  run("core");
  window.agentBrowser.helpers.toast = h.toast;
  window.agentBrowser.helpers.icon = () => "<svg></svg>";
  run("ipc"); run("tabs"); run("accounts"); run("delegation");
  h.agentBrowser = window.agentBrowser;
  // These unrelated Agent views are not exercised; the real tab router is.
  h.agentBrowser.switchAgentSub = vi.fn();
  h.agentBrowser.agentLoadConversations = vi.fn(); h.agentBrowser.agentLoadConfig = vi.fn();
  function click(el: Element | null) {
    if (!el) throw new Error("Missing emitted command");
    if (el.disabled) return;
    const event = { target: el, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const fn of listeners.click || []) fn(event);
  }
  function command(surface: string, cmd: string, row = 0) { return h.elements[surface].querySelectorAll('[data-cmd="' + cmd + '"]')[row] || null; }
  function close(id: string) { const el = button("close-dialog"); el.attributes["data-role"] = "cmd"; el.attributes["data-cmd-target"] = id; click(el); }
  function confirm() { const el = button("doConfirm"); el.attributes["data-role"] = "cmd"; click(el); }
  return { ...h, facade, trace, clipboard, blocked, handlers, click, command, nav, close, confirm };
}
function seedPair() {
  addAccount({ platformUrl: ACCOUNT.platformUrl, platformUserName: ACCOUNT.platformUserName, platformPassword: "synthetic-secret-only", tags: ACCOUNT.tags, profileIds: ACCOUNT.profileIds });
  addAccount({ platformUrl: SECOND.platformUrl, platformUserName: SECOND.platformUserName, platformPassword: "synthetic-bob-secret", tags: SECOND.tags, profileIds: SECOND.profileIds });
}
function writes(h: ReturnType<typeof moduleHarness>, name: string) { return h.trace.filter(t => t.channel === "agent:accounts:" + name); }
async function renderBoth(h: ReturnType<typeof moduleHarness>) {
  h.click(h.nav[0]); await flush();
  expect(h.agentBrowser.state.currentTab).toBe("accounts");
  h.click(h.nav[1]); await flush();
  expect(h.agentBrowser.state.currentTab).toBe("agent");
  h.agentBrowser.agentLoadAccounts(); await flush();
}
function assertNoSecret(h: ReturnType<typeof moduleHarness>) {
  expect(JSON.stringify(h.elements["accounts-tab-list"].innerHTML + h.elements["agent-accounts-list"].innerHTML + h.toast.mock.calls)).not.toContain("synthetic-secret-only");
  expect(h.elements["acct-password"].value).toBe("");
  expect(h.blocked).not.toHaveBeenCalled();
}

for (const surface of ["accounts-tab-list", "agent-accounts-list"]) {
  describe("original displayed reference through whole modules — " + surface, () => {
    for (const command of ["agentEditAccount", "agentBindAccounts", "agentCopyAccountUsername", "agentCopyAccountPassword"]) {
      it(command + " rejects a cross-client reorder without inspecting or copying the replacement target", async () => {
        seedPair(); const h = moduleHarness(); await renderBoth(h);
        const clicked = h.command(surface, command, 0)!;
        const originalRef = getRedactedAccounts()[0].ref;
        const cfg = getConfig(); cfg.accounts!.reverse(); saveConfig(cfg);
        const before = fs.readFileSync(getConfigPath());
        h.click(clicked); await flush();
        expect(fs.readFileSync(getConfigPath())).toEqual(before);
        expect(h.clipboard).not.toHaveBeenCalled(); expect(successes(h)).toEqual([]);
        expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("reselect"), "error");
        if (command === "agentEditAccount") expect(h.elements["acct-username"].value).toBe("");
        const channel = command === "agentCopyAccountUsername" ? "copy-username" : command === "agentCopyAccountPassword" ? "copy-password" : "get";
        expect(writes(h, channel).at(-1)?.args).toEqual([0, originalRef]);
        assertNoSecret(h);
      });
    }
    it("confirmation retains its original ref across deletion, refresh and repeated callbacks", async () => {
      seedPair(); const h = moduleHarness(); await renderBoth(h);
      const originalRef = getRedactedAccounts()[0].ref;
      h.click(h.command(surface, "agentDeleteAccount")); await flush();
      expect(h.elements["dlg-confirm"].open).toBe(true);
      deleteAccount(0, originalRef); const before = fs.readFileSync(getConfigPath());
      h.agentBrowser.agentLoadAccounts(); await flush(); h.confirm(); await flush(); h.confirm(); await flush();
      expect(fs.readFileSync(getConfigPath())).toEqual(before);
      expect(writes(h, "delete").map(t => t.args)).toEqual([[0, originalRef]]);
      expect(successes(h)).toEqual([]); expect(readAccountBytes()[0].platformUserName).toBe(SECOND.platformUserName);
      // Only a newly selected displayed row and a new confirmation may delete.
      h.click(h.command(surface, "agentDeleteAccount")); await flush(); h.confirm(); await flush();
      expect(getRedactedAccounts()).toEqual([]); expect(writes(h, "delete")).toHaveLength(2);
      assertNoSecret(h);
    });
    it("edit conflict preserves ALL unsaved fields, disables Save and never adopts refreshed refs", async () => {
      seedPair(); const h = moduleHarness(); await renderBoth(h);
      const originalRef = getRedactedAccounts()[0].ref;
      h.click(h.command(surface, "agentEditAccount")); await flush();
      h.elements["acct-url"].value = "https://unsaved.invalid"; h.elements["acct-username"].value = "unsaved-owner";
      h.elements["acct-password"].value = "synthetic-unsaved-secret"; h.elements["acct-tags"].value = "unsaved, tags";
      const cfg = getConfig(); cfg.accounts!.reverse(); saveConfig(cfg); const before = fs.readFileSync(getConfigPath());
      await h.agentBrowser.saveAccount(); await flush();
      expect(h.elements["dlg-account"].open).toBe(true); expect(h.saveAccount.disabled).toBe(true);
      expect(["acct-url", "acct-username", "acct-password", "acct-tags"].map(id => h.elements[id].value)).toEqual(["https://unsaved.invalid", "unsaved-owner", "synthetic-unsaved-secret", "unsaved, tags"]);
      expect(writes(h, "update")[0]?.args[0].ref).toEqual(originalRef);
      await h.agentBrowser.saveAccount(); await flush(); expect(writes(h, "update")).toHaveLength(1);
      expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(successes(h)).toEqual([]);
      h.close("dlg-account"); h.click(h.command(surface, "agentEditAccount")); await flush();
      expect(h.elements["acct-username"].value).toBe(SECOND.platformUserName); expect(h.saveAccount.disabled).toBe(false);
      assertNoSecret(h);
    });
    it("profile-read Retry carries the original ref and cannot rebind the new index occupant", async () => {
      seedPair(); const h = moduleHarness(); await renderBoth(h);
      const originalRef = getRedactedAccounts()[0].ref;
      h.api.browser.list.mockRejectedValueOnce(new Error("synthetic profile failure"));
      h.click(h.command(surface, "agentBindAccounts")); await flush();
      const retry = h.elements["acct-bind-list"].querySelector('[data-cmd="agentBindAccounts"]');
      expect(JSON.parse(retry!.getAttribute("data-cmd-arg")!)).toEqual(originalRef);
      deleteAccount(0, originalRef); const before = fs.readFileSync(getConfigPath());
      h.click(retry); await flush(); await h.agentBrowser.agentSaveAccountBind(); await flush();
      expect(h.saveBind.disabled).toBe(true); expect(writes(h, "bind")).toEqual([]);
      expect(writes(h, "get").at(-1)?.args).toEqual([0, originalRef]); expect(fs.readFileSync(getConfigPath())).toEqual(before);
      expect(successes(h)).toEqual([]); assertNoSecret(h);
    });
    it("bind conflict preserves selection and requires explicit row reselection", async () => {
      seedPair(); const h = moduleHarness(); await renderBoth(h);
      const originalRef = getRedactedAccounts()[0].ref;
      h.click(h.command(surface, "agentBindAccounts")); await flush();
      h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb").forEach(c => c.checked = c.value === PROFILES[1].dirId);
      updateAccount(1, { tags: ["second-client"] }, getRedactedAccounts()[1].ref);
      const before = fs.readFileSync(getConfigPath());
      await h.agentBrowser.agentSaveAccountBind(); await flush(); await h.agentBrowser.agentSaveAccountBind(); await flush();
      expect(h.elements["dlg-account-bind"].open).toBe(true); expect(h.saveBind.disabled).toBe(true);
      expect(h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb:checked").map(c => c.value)).toEqual([PROFILES[1].dirId]);
      expect(writes(h, "bind").map(t => t.args[0].ref)).toEqual([originalRef]); expect(successes(h)).toEqual([]);
      expect(fs.readFileSync(getConfigPath())).toEqual(before); assertNoSecret(h);
    });
  });
}

describe("reference validation and real transport role boundaries", () => {
  it("duplicate public metadata with different synthetic secrets cannot retarget a displayed copy", async () => {
    addAccount({ platformUrl: ACCOUNT.platformUrl, platformUserName: ACCOUNT.platformUserName, platformPassword: "synthetic-secret-only" });
    addAccount({ platformUrl: ACCOUNT.platformUrl, platformUserName: ACCOUNT.platformUserName, platformPassword: "synthetic-other-secret" });
    const h = moduleHarness(); await renderBoth(h);
    const clicked = h.command("accounts-tab-list", "agentCopyAccountPassword", 0)!;
    const selected = getRedactedAccounts()[0].ref;
    deleteAccount(0, selected); const before = fs.readFileSync(getConfigPath());
    h.click(clicked); await flush();
    expect(h.clipboard).not.toHaveBeenCalled(); expect(writes(h, "copy-password").at(-1)?.args).toEqual([0, selected]);
    expect(fs.readFileSync(getConfigPath())).toEqual(before); expect(successes(h)).toEqual([]);
    reloadConfig(); expect(getAccountPassword(0, getRedactedAccounts()[0].ref)).toBe("synthetic-other-secret"); assertNoSecret(h);
  });
  it("checks returned ref BEFORE reading fields of a mismatched refetch", async () => {
    const h = harness(); let inspected = 0;
    const mismatch = { ref: { index: 0, revision: "different" }, get platformUserName() { inspected++; return "replacement"; }, get profileIds() { inspected++; return []; } };
    h.accounts.get.mockResolvedValue(mismatch);
    await h.agentBrowser.agentEditAccount(ACCOUNT.ref); await h.agentBrowser.agentBindAccounts(ACCOUNT.ref); await flush();
    expect(inspected).toBe(0); expect(h.saveAccount.disabled).toBe(true); expect(h.saveBind.disabled).toBe(true);
    expect(successes(h)).toEqual([]);
  });
  it("original references are detached from caller mutation and hidden edit-index tampering", async () => {
    const h = harness(); const reference = { ...ACCOUNT.ref };
    await h.agentBrowser.agentEditAccount(reference); reference.index = 1; reference.revision = "replacement";
    h.elements["acct-edit-index"].value = "1"; await h.agentBrowser.saveAccount();
    expect(h.accounts.update).not.toHaveBeenCalled();
    h.elements["acct-edit-index"].value = "0"; await h.agentBrowser.saveAccount();
    expect(h.accounts.update.mock.calls[0][2]).toEqual(ACCOUNT.ref);
  });
  it("generic write failure Retry reuses the SAME original reference", async () => {
    const h = harness(); await h.agentBrowser.agentEditAccount(ACCOUNT.ref);
    h.accounts.update.mockRejectedValueOnce(new Error("synthetic disk failure"));
    await h.agentBrowser.saveAccount(); await h.agentBrowser.saveAccount();
    expect(h.accounts.update.mock.calls.map(c => c[2])).toEqual([ACCOUNT.ref, ACCOUNT.ref]);
  });
  it("whole-module close delegation prevents a delayed selected read from reopening", async () => {
    seedPair(); const h = moduleHarness(); await renderBoth(h);
    const pending = deferred<any>(); const original = h.handlers.get("agent:accounts:get")!;
    h.handlers.set("agent:accounts:get", () => pending.promise);
    h.click(h.command("accounts-tab-list", "agentBindAccounts")); await flush(); h.close("dlg-account-bind");
    pending.resolve(await original({}, 0, getRedactedAccounts()[0].ref)); await flush();
    expect(h.elements["dlg-account-bind"].open).toBe(false); expect(h.saveBind.disabled).toBe(true);
    await h.agentBrowser.agentSaveAccountBind(); expect(writes(h, "bind")).toEqual([]); assertNoSecret(h);
  });
  it("visible and accessible duplicate profile names include full distinct actual IDs", async () => {
    const h = harness(); const profiles = [{ name: "Duplicate", dirId: "1700000000000_shared_prefix_a" }, { name: "Duplicate", dirId: "1700000000000_shared_prefix_b" }];
    h.api.browser.list.mockResolvedValue(profiles); await h.agentBrowser.agentBindAccounts(ACCOUNT.ref);
    for (const p of profiles) expect(h.elements["acct-bind-list"].innerHTML).toContain('> ' + p.name + ' <span class="hint-line">(' + p.dirId + ')</span></label>');
    h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb").forEach(c => c.checked = c.value === profiles[1].dirId);
    await h.agentBrowser.agentSaveAccountBind(); expect(h.accounts.bind).toHaveBeenCalledWith(0, [profiles[1].dirId], ACCOUNT.ref);
  });
  it("new refs emitted after refresh cannot be substituted into an older pending list response", async () => {
    const h = harness(), pending = deferred<any[]>(); h.accounts.list.mockReturnValueOnce(pending.promise);
    h.agentBrowser.loadAccountsTab(); await flush(); h.accounts.list.mockResolvedValue([{ ...SECOND, ref: { index: 0, revision: "new" } }]);
    h.agentBrowser.loadAccountsTab(); await flush(); pending.resolve([ACCOUNT]); await flush();
    const cmd = h.elements["accounts-tab-list"].querySelector('[data-cmd="agentEditAccount"]');
    expect(JSON.parse(cmd!.getAttribute("data-cmd-arg")!)).toEqual({ index: 0, revision: "new" });
  });
  it("owner copies reach only the mocked sink; secrets never cross preload or enter DOM", async () => {
    seedPair(); const h = moduleHarness(); await renderBoth(h);
    h.click(h.command("accounts-tab-list", "agentCopyAccountUsername")); await flush();
    h.click(h.command("agent-accounts-list", "agentCopyAccountPassword")); await flush();
    expect(h.clipboard.mock.calls).toEqual([[ACCOUNT.platformUserName], ["synthetic-secret-only"]]);
    expect(await h.facade.agent.accounts.list()).toEqual(expect.arrayContaining([expect.objectContaining({ hasPassword: true, ref: expect.any(Object) })]));
    expect(JSON.stringify(await h.facade.agent.accounts.list())).not.toContain("synthetic-secret-only"); assertNoSecret(h);
  });
  it("real team viewer hides both surfaces; cached-owner demotion denies protected writes/copy", async () => {
    seedPair(); const owner = moduleHarness(); await renderBoth(owner);
    owner.click(owner.command("accounts-tab-list", "agentEditAccount")); await flush();
    const cfg = getConfig(); cfg.team = { name: "Synthetic", enabled: true, ownerDeviceId: "synthetic-other-owner", members: [{ deviceId: cfg.deviceId!, name: "Synthetic viewer", role: "viewer", addedAt: 1 }], updatedAt: 1 }; saveConfig(cfg);
    const before = fs.readFileSync(getConfigPath());
    await owner.agentBrowser.saveAccount(); owner.click(owner.command("agent-accounts-list", "agentCopyAccountPassword")); await flush();
    expect(owner.clipboard).not.toHaveBeenCalled(); expect(successes(owner)).toEqual([]); expect(fs.readFileSync(getConfigPath())).toEqual(before);
    const viewer = moduleHarness(); await renderBoth(viewer);
    for (const surface of ["accounts-tab-list", "agent-accounts-list"]) expect(viewer.elements[surface].querySelectorAll("button").map(b => b.attributes["data-cmd"])).toEqual(["agentCopyAccountUsername", "agentCopyAccountUsername"]);
    expect(viewer.add.style.display).toBe("none"); expect(viewer.agentAdd.style.display).toBe("none");
    await expect(viewer.facade.agent.accounts.copyPassword(0, getRedactedAccounts()[0].ref)).rejects.toThrow("requires member role");
    expect(viewer.clipboard).not.toHaveBeenCalled(); assertNoSecret(viewer);
  });
  it("real update retains ciphertext, bind persists exact IDs and file-vault reload remains searchable", async () => {
    seedPair(); const h = moduleHarness(); await renderBoth(h);
    const encryptedBefore = readAccountBytes()[0].platformPassword;
    h.click(h.command("accounts-tab-list", "agentEditAccount")); await flush(); h.elements["acct-username"].value = "searchable-updated";
    await h.agentBrowser.saveAccount(); await flush(); expect(readAccountBytes()[0].platformPassword).toBe(encryptedBefore);
    h.click(h.command("agent-accounts-list", "agentBindAccounts")); await flush(); h.elements["acct-bind-list"].querySelectorAll(".acct-bind-cb").forEach(c => c.checked = c.value === PROFILES[1].dirId);
    await h.agentBrowser.agentSaveAccountBind(); await flush(); expect(readAccountBytes()[0].profileIds).toEqual([PROFILES[1].dirId]);
    reloadConfig(); resetSecretStorageForTests(); initializeSecretStorage(planSecretStorage({ userDataDir: STORAGE_ROOT, environment: { AGENT_BROWSER_SECRET_BACKEND: "file" } }));
    expect(getRedactedAccounts().find(a => a.platformUserName === "searchable-updated")?.tags).toEqual(ACCOUNT.tags);
    expect(getProfileAccounts(PROFILES[1].dirId).some(a => a.platformUserName === "searchable-updated")).toBe(true);
    expect(getAccountPassword(0, getRedactedAccounts()[0].ref)).toBe("synthetic-secret-only");
    expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain("synthetic-secret-only"); assertNoSecret(h);
  });
});

// Compile-only contract checks; omission cannot typecheck into a legacy fallback.
function accountContractTypes(api: AgentBrowserAPI, ref: AccountReference) {
  void api.agent.accounts.get(ref.index, ref); void api.agent.accounts.update(ref.index, { tags: [] }, ref);
  void api.agent.accounts.bind(ref.index, [], ref); void api.agent.accounts.delete(ref.index, ref);
  void api.agent.accounts.copyUsername(ref.index, ref); void api.agent.accounts.copyPassword(ref.index, ref);
  // @ts-expect-error required original displayed reference
  void api.agent.accounts.update(ref.index, { tags: [] });
  // @ts-expect-error required original displayed reference
  void api.agent.accounts.delete(ref.index);
  // @ts-expect-error required original displayed reference
  void api.agent.accounts.copyPassword(ref.index);
}
void accountContractTypes;

// Task292 additive reconciliation proofs. The HTTP server is only a callback
// facade; renderer commands still use the complete existing preload/IPC path.
// Both transports share the actual config store and isolated file vault above.
function restCallbackHarness() {
  let callback!: (req: any, res: any) => Promise<void>;
  const forbidden = vi.fn((name: string): never => { throw new Error("Forbidden REST fixture operation: " + name); });
  const opaque = new Proxy({}, { get: (_o, name) => name === "__esModule" ? false : () => forbidden(String(name)) });
  const modules = { exports: {} as any };
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/main/services/rest-api-server.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, {
    module: modules, exports: modules.exports, Buffer, URL,
    process: { env: { AGENT_BROWSER_API_TOKEN: "synthetic-reconcile-token", AGENT_BROWSER_API_PORT: "0" }, uptime: () => 1 },
    console: { log() {}, warn() {}, error() {} },
    require: (name: string) => {
      if (name === "node:http") return { createServer: (handler: typeof callback) => {
        callback = handler;
        const server = new EventEmitter() as any;
        server.listen = (_port: number, _host: string, ready: () => void) => ready();
        server.address = () => ({ port: 1 });
        server.close = (finish: () => void) => finish();
        return server;
      } };
      if (name === "node:crypto") return crypto;
      if (name === "node:path") return path;
      if (name === "./config-manager.js") return configService;
      if (name === "./config/store.js") return accountStore;
      if (name === "./local-agent.js") return accountService;
      if (name === "./team.js") return teamService;
      if (name === "./http/auth.js") return httpAuth;
      if (name === "./http/body.js") return httpBody;
      if (name === "./server-mode.js") return serverMode;
      if (name === "../branding.js") return branding;
      if (name === "./audit-log.js") return { recordAudit };
      return opaque;
    },
  });
  modules.exports.startRestApiServer();
  async function request(method: string, route: string, ref?: AccountReference, body?: unknown, authenticated = true) {
    const req = new EventEmitter() as any;
    req.method = method; req.url = route;
    req.headers = { host: "127.0.0.1", ...(authenticated ? { authorization: "Bearer synthetic-reconcile-token" } : {}), ...(ref ? { "if-match": JSON.stringify(ref.revision) } : {}) };
    req.socket = { remoteAddress: "127.0.0.1" }; req.destroy = () => {};
    const response = { status: 0, headers: {} as Record<string, string>, body: undefined as any };
    const res = {
      setHeader: (key: string, value: string) => { response.headers[key.toLowerCase()] = value; },
      writeHead: (status: number, values?: Record<string, string>) => { response.status = status; for (const [key, value] of Object.entries(values || {})) response.headers[key.toLowerCase()] = value; },
      end: (text?: string) => { response.body = text ? JSON.parse(text) : undefined; },
    };
    const pending = callback(req, res);
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end"); await pending;
    expect(forbidden).not.toHaveBeenCalled();
    return response;
  }
  return { request, stop: () => modules.exports.stopRestApiServer() as Promise<void> };
}

describe("Task292 account renderer reconciliation", () => {
  it("unsafe integer refs dispatch no selected reads, copies, confirmations or mutations", async () => {
    const h = harness(); const ref = { index: Number.MAX_SAFE_INTEGER + 1, revision: ACCOUNT.ref.revision };
    for (const command of ["agentEditAccount", "agentBindAccounts", "agentDeleteAccount", "agentCopyAccountUsername", "agentCopyAccountPassword"]) await h.agentBrowser[command](ref);
    await flush();
    for (const fn of [h.accounts.get, h.accounts.copyUsername, ...mutations(h)]) expect(fn).not.toHaveBeenCalled();
    expect(h.confirmations).toEqual([]); expect(successes(h)).toEqual([]);
    expect(h.elements["dlg-account"].open).toBe(false); expect(h.elements["dlg-account-bind"].open).toBe(false);
  });

  it("renderer preserves opaque revisions exactly rather than deriving an identity or positional fallback", async () => {
    const h = harness(); const ref = { index: 0, revision: 'opaque:fixture/<>&"not-a-secret-hash' };
    h.accounts.get.mockResolvedValue({ ...ACCOUNT, ref });
    h.accounts.list.mockResolvedValue([{ ...ACCOUNT, ref }]);
    h.agentBrowser.agentLoadAccounts(); await flush();
    const emitted = h.elements["accounts-tab-list"].querySelector('[data-cmd="agentEditAccount"]')!.getAttribute("data-cmd-arg")!;
    expect(JSON.parse(emitted)).toEqual(ref);
    await h.agentBrowser.agentEditAccount(emitted); await h.agentBrowser.saveAccount();
    expect(h.accounts.get).toHaveBeenCalledExactlyOnceWith(0, ref);
    expect(h.accounts.update.mock.calls[0][2]).toEqual(ref);
    expect(Object.keys(h.accounts.update.mock.calls[0][2])).toEqual(["index", "revision"]);
  });

  it("committed preload mutation DTOs never contain plaintext or stored ciphertext", async () => {
    seedPair(); const h = moduleHarness();
    const updated = await h.facade.agent.accounts.update(1, { tags: ["reconcile-search"] }, getRedactedAccounts()[1].ref);
    expect(updated.ref).toEqual(getRedactedAccounts()[1].ref);
    const bound = await h.facade.agent.accounts.bind(1, [PROFILES[0].dirId], updated.ref);
    expect(bound.ref).toEqual(getRedactedAccounts()[1].ref);
    const added = await h.facade.agent.accounts.add({ platformUrl: "https://added.synthetic.invalid", platformUserName: "added", platformPassword: "synthetic-added-secret" });
    expect(added.ref).toEqual(getRedactedAccounts()[2].ref);
    for (const dto of [updated, bound, added]) {
      expect(dto.hasPassword).toBe(true); expect(dto).not.toHaveProperty("platformPassword");
      expect(Number.isSafeInteger(dto.ref.index)).toBe(true); expect(dto.ref.revision).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(dto)).not.toContain(readAccountBytes()[dto.ref.index].platformPassword);
    }
    expect(readAccountBytes()[1].platformPassword).toMatch(/^v2:/);
    expect(getAccountPassword(1, getRedactedAccounts()[1].ref)).toBe("synthetic-bob-secret");
    expect(getProfileAccounts(PROFILES[0].dirId).find(a => a.tags?.includes("reconcile-search"))?.ref.index).toBe(1);
    expect(h.blocked).not.toHaveBeenCalled();
  });

  for (const surface of ["accounts-tab-list", "agent-accounts-list"]) {
    it(surface + " profile-filtered row uses its global index through emitted edit and copy handlers", async () => {
      seedPair(); const h = moduleHarness();
      const profile = h.handlers.get("agent:accounts:profile")!;
      h.handlers.set("agent:accounts:list", () => profile({}, PROFILES[1].dirId));
      await renderBoth(h);
      const selected = getRedactedAccounts()[1].ref;
      expect(JSON.parse(h.command(surface, "agentEditAccount")!.getAttribute("data-cmd-arg")!)).toEqual(selected);
      h.click(h.command(surface, "agentCopyAccountUsername")); await flush();
      expect(writes(h, "copy-username").at(-1)?.args).toEqual([1, selected]); expect(h.clipboard.mock.calls).toEqual([[SECOND.platformUserName]]);
      const beforeA = readAccountBytes()[0], beforeBSecret = readAccountBytes()[1].platformPassword;
      h.click(h.command(surface, "agentEditAccount")); await flush();
      expect(writes(h, "get").at(-1)?.args).toEqual([1, selected]);
      h.elements["acct-username"].value = "filtered-searchable-B";
      await h.agentBrowser.saveAccount(); await flush();
      expect(writes(h, "update").at(-1)?.args[0].ref).toEqual(selected);
      expect(readAccountBytes()[0]).toEqual(beforeA); expect(readAccountBytes()[1].platformPassword).toBe(beforeBSecret);
      reloadConfig();
      expect(getProfileAccounts(PROFILES[1].dirId).find(a => a.platformUserName === "filtered-searchable-B")?.ref.index).toBe(1);
      expect(getAccountPassword(1, getRedactedAccounts()[1].ref)).toBe("synthetic-bob-secret");
      expect(successes(h)).toHaveLength(2); assertNoSecret(h);
    });

    it(surface + " real REST callback deletion cannot retarget a pending renderer edit to its successor", async () => {
      seedPair(); addAccount({ platformUrl: "https://third.synthetic.invalid", platformUserName: "synthetic-C", platformPassword: "synthetic-C-secret", tags: ["C"] });
      const h = moduleHarness(), rest = restCallbackHarness(); await renderBoth(h);
      try {
        expect((await rest.request("GET", "/health", undefined, undefined, false)).status).toBe(200);
        expect((await rest.request("GET", "/api/accounts", undefined, undefined, false)).status).toBe(401);
        const listed = await rest.request("GET", "/api/accounts");
        expect(listed.status).toBe(200); expect(listed.headers.etag).toBe(JSON.stringify(listed.body.revision));
        const original = listed.body.accounts[1].ref;
        h.click(h.command(surface, "agentEditAccount", 1)); await flush();
        const fields = ["acct-url", "acct-username", "acct-password", "acct-tags"];
        const typed = ["https://unsaved-rest.invalid", "unsaved-rest-B", "synthetic-unsaved-rest-secret", "unsaved-rest, tags"];
        fields.forEach((id, i) => h.elements[id].value = typed[i]);
        expect((await rest.request("DELETE", "/api/accounts/0", listed.body.accounts[0].ref)).status).toBe(200);
        const before = fs.readFileSync(getConfigPath());
        await h.agentBrowser.saveAccount(); await flush(); await h.agentBrowser.saveAccount(); await flush();
        expect(writes(h, "update").map(call => call.args[0].ref)).toEqual([original]);
        expect(fields.map(id => h.elements[id].value)).toEqual(typed); expect(h.saveAccount.disabled).toBe(true);
        expect(h.elements["dlg-account"].open).toBe(true); expect(successes(h)).toEqual([]); expect(fs.readFileSync(getConfigPath())).toEqual(before);
        expect(readAccountBytes()[1].platformUserName).toBe("synthetic-C");
        const stale = await rest.request("PATCH", "/api/accounts/1", original, { username: "wrong-successor" });
        expect(stale.status).toBe(412); expect(stale.body.code).toBe("ACCOUNT_REFERENCE_CONFLICT"); expect(fs.readFileSync(getConfigPath())).toEqual(before);
        h.close("dlg-account"); h.click(h.command(surface, "agentEditAccount", 0)); await flush();
        h.elements["acct-username"].value = "explicitly-reselected-B";
        await h.agentBrowser.saveAccount(); await flush();
        expect(readAccountBytes().map((a: any) => a.platformUserName)).toEqual(["explicitly-reselected-B", "synthetic-C"]);
        reloadConfig(); expect(getRedactedAccounts().find(a => a.platformUserName === "explicitly-reselected-B")?.ref.index).toBe(0);
        expect(getAccountPassword(0, getRedactedAccounts()[0].ref)).toBe("synthetic-bob-secret");
        expect(getAccountPassword(1, getRedactedAccounts()[1].ref)).toBe("synthetic-C-secret"); assertNoSecret(h);
      } finally { await rest.stop(); }
    });
  }
});
