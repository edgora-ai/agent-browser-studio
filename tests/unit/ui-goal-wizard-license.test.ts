// Controlled DOM/provider fixtures; whole renderer modules, no native runtime or network.
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "../..");
const HTML = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const PROGRESS = "agent-browser-studio-wizard-progress";
const TERMS = "agent-browser-studio-terms-accepted-v1";
const DISMISSED = "agent-browser-studio-wizard-dismissed";

class Element {
  id = "";
  value = "";
  disabled = false;
  checked = false;
  open = false;
  hidden = false;
  textContent = "";
  private html = "";
  get innerHTML() { return this.html; }
  set innerHTML(markup: string) { this.html = markup; this.children = []; parseMarkup(markup, this); }
  className = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: Element[] = [];
  parentNode: Element | null = null;
  tag = "div";
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(el: Element) { this.children.push(el); el.parentNode = this; return el; }
  querySelectorAll(selector: string): Element[] {
    const match = (el: Element) => selector === "button" ? el.tag === "button" : selector === "input" ? el.tag === "input" : selector === "span" ? el.tag === "span" : selector === ".wizard-step" ? el.attrs.class === "wizard-step" : selector === ".btn-row" ? el.attrs.class === "btn-row" : selector.startsWith(".wizard-step[data-step=") ? el.attrs["data-step"] === selector.match(/"(\d)"/)?.[1] : false;
    return this.children.flatMap(el => [...(match(el) ? [el] : []), ...el.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { if (this.open) throw new Error("dialog already open"); this.open = true; }
  close() { this.open = false; }
  focus() {}
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

function parseMarkup(markup: string, root: Element) {
  const stack = [root];
  for (const token of markup.matchAll(/<\/?([\w-]+)([^>]*)>/g)) {
    const tag = token[1];
    if (token[0].startsWith("</")) { if (stack.at(-1)?.tag === tag) stack.pop(); continue; }
    const el = new Element(); el.tag = tag;
    for (const attr of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.attrs[attr[1]] = attr[2] ?? "";
    el.id = el.attrs.id || ""; el.disabled = "disabled" in el.attrs;
    stack.at(-1)!.appendChild(el);
    if (!["input", "br", "hr"].includes(tag)) stack.push(el);
  }
}

function harness(module: "wizard" | "license", saved?: unknown, storageFile?: string) {
  // Parse actual dialog input/button attributes: a hand-coded enabled input
  // would conceal the restored-step-2 bug in the real initially-disabled DOM.
  const elements: Record<string, Element> = {};
  const documentRoot = new Element();
  for (const id of ["dlg-wizard", "dlg-license", "dlg-terms"]) {
    const markup = HTML.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))![0];
    const stack = [documentRoot];
    for (const token of markup.matchAll(/<\/?([\w-]+)([^>]*)>/g)) {
      const tag = token[1];
      if (token[0].startsWith("</")) { if (stack.at(-1)?.tag === tag) stack.pop(); continue; }
      const el = new Element(); el.tag = tag;
      for (const attr of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.attrs[attr[1]] = attr[2] ?? "";
      el.id = el.attrs.id || ""; el.disabled = "disabled" in el.attrs;
      if (el.id) elements[el.id] = el;
      stack.at(-1)!.appendChild(el);
      if (!["input", "br", "hr"].includes(tag)) stack.push(el);
    }
  }
  const banner = new Element(); banner.id = "license-banner"; elements[banner.id] = banner;
  const storage = new Map<string, string>([[TERMS, "1"]]);
  if (saved !== undefined) storage.set(PROGRESS, JSON.stringify(saved));
  const browser = {
    binary: vi.fn(async () => ({ installed: true })),
    list: vi.fn(async (): Promise<Array<{ dirId: string; name: string }>> => []),
    verifyBinary: vi.fn(async () => ({ success: true })),
    create: vi.fn(async (_p: { name: string }): Promise<any> => ({ dirId: "synthetic-created" })),
    status: vi.fn(async (_id: string) => ({ running: false })),
    openRiskCheck: vi.fn(async (_id: string, _opts: unknown) => ({ success: true })),
  };
  const license = {
    status: vi.fn(async (): Promise<any> => ({ plan: "trial", daysLeft: 14, maxProfiles: 10, canActivate: true, deviceId: "synthetic-device" })),
    activate: vi.fn(async (_code: string): Promise<any> => ({ ok: false, code: "INVALID_CODE", error: "Synthetic refusal" })),
  };
  const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const agent: any = { api: { browser, license, app: { quit: vi.fn(async () => ({ success: true })) } }, state: {}, helpers: { toast: vi.fn(), esc, icon: () => "", scheduleProfilesRefresh: vi.fn() }, confirm: vi.fn(), ensureExternalRiskConsent: vi.fn(), interceptLicenseGate: vi.fn(() => false) };
  const doc = {
    getElementById: (id: string) => elements[id] || (function find(el: Element): Element | null { if (el.id === id) { elements[id] = el; return el; } for (const child of el.children) { const found = find(child); if (found) return found; } return null; })(documentRoot),
    createElement: () => new Element(),
    querySelector: (s: string) => {
      const command = s.match(/data-cmd="([^"]+)"/);
      if (command) return documentRoot.querySelectorAll("button").find(e => e.attrs["data-cmd"] === command[1]) || null;
      const step = s.match(/data-step="(\d)"/);
      if (step) {
        const el = elements["dlg-wizard"].querySelector(`.wizard-step[data-step="${step[1]}"]`);
        return s.endsWith("button") ? el?.querySelector("button") : s.endsWith(".btn-row") ? el?.querySelector(".btn-row") : el;
      }
      return null;
    },
  };
  const window: any = { agentBrowser: agent };
  const persist = () => { if (storageFile) fs.writeFileSync(storageFile, JSON.stringify(Object.fromEntries(storage))); };
  persist();
  const localStorage = { getItem: (k: string) => storage.get(k) || null, setItem: (k: string, v: string) => { storage.set(k, v); persist(); }, removeItem: (k: string) => { storage.delete(k); persist(); } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, `src/renderer/js/app/${module}.js`), "utf8"), { window, document: doc, localStorage, console, Date });
  const button = (cmd: string) => documentRoot.querySelectorAll("button").find(el => el.attrs["data-cmd"] === cmd)!;
  // Dynamically created status nodes must be looked up like the actual DOM,
  // not disappear merely because no later getElementById cached them yet.
  const liveElements = new Proxy(elements, { get: (target, id: string) => target[id] || doc.getElementById(id) });
  return { agent, browser, license, elements: liveElements, storage, window, button };
}

describe("F15 wizard checkpoints (synthetic whole-module fixtures)", () => {
  it("resumes a pending profile checkpoint even when engine and profiles already exist", async () => {
    const h = harness("wizard", { step: 2, dirId: "existing", profileName: "old name" });
    h.browser.list.mockResolvedValue([{ dirId: "existing", name: "renamed" }]);
    h.agent.maybeShowWizard(); await flush();
    expect(h.elements["dlg-wizard"].open).toBe(true);
    expect(h.agent.state.wizardDirId).toBe("existing");
    expect(h.elements["wizard-profile-name"].value).toBe("renamed");
    expect(h.button("wizardCreateProfile").disabled).toBe(true);
    expect(h.button("wizardLaunchAndCheck").disabled).toBe(false);
  });
  it("restores the name input as editable after completed verification", async () => {
    const h = harness("wizard", { step: 1, dirId: null, profileName: null });
    h.agent.showWizard(); await flush();
    expect(h.elements["wizard-profile-name"].disabled).toBe(false);
    expect(h.button("wizardCreateProfile").disabled).toBe(false);
  });
  it("rejects ghost IDs and restarts at creation without touching the risk-check provider", async () => {
    const h = harness("wizard", { step: 3, dirId: "deleted", profileName: "gone" });
    h.browser.list.mockResolvedValue([{ dirId: "other", name: "unrelated" }]);
    h.agent.showWizard(); await flush();
    expect(h.agent.state.wizardDirId).toBeNull();
    expect(h.button("wizardCreateProfile").disabled).toBe(false);
    expect(h.button("wizardLaunchAndCheck").disabled).toBe(true);
    h.agent.wizardLaunchAndCheck(); await flush();
    expect(h.agent.ensureExternalRiskConsent).not.toHaveBeenCalled();
    expect(h.browser.openRiskCheck).not.toHaveBeenCalled();
    expect(JSON.parse(h.storage.get(PROGRESS)!)).toMatchObject({ step: 1, dirId: null });
  });
  it("does not force onboarding on established installs without a checkpoint", async () => {
    const h = harness("wizard"); h.browser.list.mockResolvedValue([{ dirId: "legacy", name: "legacy" }]);
    h.agent.maybeShowWizard(); await flush(); expect(h.elements["dlg-wizard"].open).toBe(false);
  });
  it("keeps terms and permanent dismissal ahead of checkpoint resumption", async () => {
    for (const terms of [true, false]) {
      const h = harness("wizard", { step: 2, dirId: "existing" });
      if (terms) h.storage.delete(TERMS); else h.storage.set(DISMISSED, "1");
      h.agent.maybeShowWizard(); await flush();
      expect(h.elements["dlg-wizard"].open).toBe(false);
      expect(h.browser.binary).not.toHaveBeenCalled();
    }
  });
  it("ignores malformed progress and handles a rejected readiness lookup", async () => {
    const h = harness("wizard", { step: 900, dirId: "ghost" });
    h.browser.binary.mockRejectedValue(new Error("synthetic engine error"));
    h.agent.maybeShowWizard(); await flush();
    expect(h.elements["dlg-wizard"].open).toBe(true);
    expect(h.agent.state.wizardDirId).toBeNull();
    expect(h.button("wizardLaunchAndCheck").disabled).toBe(true);
  });
  it("preserves a checkpoint on list failure and retries without creating a second profile", async () => {
    const h = harness("wizard", { step: 2, dirId: "existing", profileName: "Synthetic" });
    h.browser.list.mockRejectedValueOnce(new Error("synthetic list unavailable")).mockResolvedValueOnce([{ dirId: "existing", name: "Synthetic" }]);
    h.agent.showWizard(); await flush();
    expect(h.agent.state.wizardDirId).toBeNull();
    expect(h.button("wizardCreateProfile").disabled).toBe(true);
    expect(h.button("wizardLaunchAndCheck").disabled).toBe(true);
    expect(JSON.parse(h.storage.get(PROGRESS)!)).toMatchObject({ step: 2, dirId: "existing" });
    h.agent.wizardVerifyBinary(); await flush();
    expect(h.agent.state.wizardDirId).toBe("existing");
    expect(h.browser.create).not.toHaveBeenCalled();
  });
  it("does not open a late checkpoint dialog after the user skips", async () => {
    const h = harness("wizard", { step: 2, dirId: "existing" });
    const pending = deferred<Array<{ dirId: string; name: string }>>(); h.browser.list.mockReturnValue(pending.promise);
    h.agent.showWizard(); h.agent.wizardSkip();
    pending.resolve([{ dirId: "existing", name: "Synthetic" }]); await flush();
    expect(h.elements["dlg-wizard"].open).toBe(false);
    expect(h.storage.has(PROGRESS)).toBe(false);
  });
  it("coalesces double-create, persists real synthetic index bytes, reloads/list/searches the one ID", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-synthetic-index-"));
    try {
      const index = path.join(dir, "profiles.json"); fs.writeFileSync(index, "[]");
      const h = harness("wizard", { step: 1 }); h.agent.showWizard(); await flush();
      const pending = deferred<any>();
      h.browser.create.mockImplementation(async p => {
        const rows = JSON.parse(fs.readFileSync(index, "utf8")); rows.push({ dirId: `synthetic-${rows.length}`, name: p.name });
        fs.writeFileSync(index, JSON.stringify(rows)); return pending.promise;
      });
      h.elements["wizard-profile-name"].value = "Synthetic double-click";
      h.agent.wizardCreateProfile(); h.agent.wizardCreateProfile(); await flush();
      expect(h.browser.create).toHaveBeenCalledTimes(1);
      const disk = JSON.parse(fs.readFileSync(index, "utf8")); expect(disk).toEqual([{ dirId: "synthetic-0", name: "Synthetic double-click" }]);
      pending.resolve(disk[0]); await flush();
      expect(h.agent.state.wizardDirId).toBe("synthetic-0");
      expect(JSON.parse(h.storage.get(PROGRESS)!)).toMatchObject({ step: 2, dirId: "synthetic-0" });
      const reload = harness("wizard", JSON.parse(h.storage.get(PROGRESS)!));
      reload.browser.list.mockImplementation(async () => JSON.parse(fs.readFileSync(index, "utf8")));
      reload.agent.maybeShowWizard(); await flush();
      expect(reload.agent.state.wizardDirId).toBe("synthetic-0");
      expect((await reload.browser.list()).filter(p => p.name.includes("double-click")).map(p => p.dirId)).toEqual(["synthetic-0"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("releases create guard on quota refusal and transport error; consent cancellation stays local", async () => {
    const h = harness("wizard", { step: 1 }); h.agent.showWizard(); await flush();
    h.browser.create.mockResolvedValueOnce({ success: false, code: "PROFILE_LIMIT" }).mockRejectedValueOnce(new Error("synthetic failure"));
    h.agent.interceptLicenseGate.mockReturnValueOnce(true);
    h.agent.wizardCreateProfile(); await flush(); expect(h.agent.interceptLicenseGate).toHaveBeenCalledWith({ success: false, code: "PROFILE_LIMIT" });
    expect(h.button("wizardCreateProfile").disabled).toBe(false);
    h.agent.wizardCreateProfile(); await flush(); expect(h.button("wizardCreateProfile").disabled).toBe(false);
    expect(h.elements["wizard-step2-status"].innerHTML).toContain("synthetic failure");
    h.agent.state.wizardDirId = "synthetic"; h.agent.wizardLaunchAndCheck(); await flush();
    expect(h.agent.ensureExternalRiskConsent).toHaveBeenCalled();
    expect(h.browser.status).not.toHaveBeenCalled(); expect(h.browser.openRiskCheck).not.toHaveBeenCalled();
  });
  it("ignores late verification after skip instead of restoring a cleared checkpoint", async () => {
    const h = harness("wizard"); h.agent.showWizard(); await flush();
    const pending = deferred<{ success: boolean }>(); h.browser.verifyBinary.mockReturnValue(pending.promise);
    h.agent.wizardVerifyBinary(); h.agent.wizardSkip(); pending.resolve({ success: true }); await flush();
    expect(h.storage.has(PROGRESS)).toBe(false);
    expect(h.elements["dlg-wizard"].open).toBe(false);
  });
  it("releases create controls when reopened while an older failed create is still pending", async () => {
    const h = harness("wizard", { step: 1 }); h.agent.showWizard(); await flush();
    const pending = deferred<any>(); h.browser.create.mockReturnValue(pending.promise);
    h.agent.wizardCreateProfile(); await flush(); h.elements["dlg-wizard"].close(); h.agent.showWizard(); await flush();
    expect(h.button("wizardCreateProfile").disabled).toBe(true);
    pending.reject(new Error("late synthetic failure")); await flush();
    expect(h.button("wizardCreateProfile").disabled).toBe(false);
    expect(h.elements["wizard-profile-name"].disabled).toBe(false);
  });
  it("ignores a late creation UI reply after skip instead of restoring a cleared checkpoint", async () => {
    const h = harness("wizard", { step: 1 }); h.agent.showWizard(); await flush();
    const pending = deferred<any>(); h.browser.create.mockReturnValue(pending.promise);
    h.agent.wizardCreateProfile(); h.agent.wizardSkip(); pending.resolve({ dirId: "created-late" }); await flush();
    expect(h.storage.has(PROGRESS)).toBe(false); expect(h.elements["dlg-wizard"].open).toBe(false);
  });
});

// A durable controlled provider, not a claim about native browser-manager storage.
// Retain new evidence under the filtered TMPDIR for independent byte/ID inspection.
function durableWizardFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-receipt-proof-"));
  const index = path.join(dir, "profiles.json"), checkpoint = path.join(dir, "checkpoint.json");
  fs.writeFileSync(index, "[]");
  const rows = (): Array<{ dirId: string; name: string }> => JSON.parse(fs.readFileSync(index, "utf8"));
  const h = harness("wizard", { step: 1 }, checkpoint);
  const pending = deferred<any>();
  h.browser.list.mockImplementation(async () => rows());
  h.browser.create.mockImplementation(async p => {
    const data = rows(), profile = { dirId: `receipt-${data.length}`, name: p.name };
    data.push(profile); fs.writeFileSync(index, JSON.stringify(data));
    return data.length === 1 ? pending.promise : profile;
  });
  return { h, pending, rows, index, checkpoint, dir };
}

describe("committed creation receipts and asynchronous wizard ownership", () => {
  for (const ordering of ["reopen-before-commit", "commit-while-closed"] as const) {
    it(`reconciles ${ordering} without a duplicate mutation, including disk/reload/list/search`, async () => {
      const { h, pending, rows, index, checkpoint, dir } = durableWizardFixture();
      h.agent.showWizard(); await flush();
      h.elements["wizard-profile-name"].value = "Receipt searchable original";
      h.agent.wizardCreateProfile(); await flush();
      const committedBytes = fs.readFileSync(index);
      expect(rows()).toEqual([{ dirId: "receipt-0", name: "Receipt searchable original" }]);
      h.elements["dlg-wizard"].close();
      if (ordering === "reopen-before-commit") h.agent.showWizard();
      const closedStatus = h.elements["wizard-step2-status"].innerHTML;
      pending.resolve(rows()[0]); await flush();
      if (ordering === "commit-while-closed") {
        expect(h.elements["dlg-wizard"].open).toBe(false);
        expect(h.elements["wizard-step2-status"].innerHTML).toBe(closedStatus);
        h.agent.showWizard(); await flush();
      }
      expect(h.agent.state.wizardDirId).toBe("receipt-0");
      expect(h.elements["wizard-profile-name"].value).toBe("Receipt searchable original");
      expect(h.button("wizardCreateProfile").disabled).toBe(true);
      expect(h.button("wizardLaunchAndCheck").disabled).toBe(false);
      h.agent.wizardCreateProfile(); await flush();
      expect(h.browser.create).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(index)).toEqual(committedBytes);
      const stored = JSON.parse(fs.readFileSync(checkpoint, "utf8"))[PROGRESS];
      expect(JSON.parse(stored)).toMatchObject({ step: 2, dirId: "receipt-0", profileName: "Receipt searchable original" });
      const reload = harness("wizard", JSON.parse(stored)); reload.browser.list.mockImplementation(async () => rows());
      reload.agent.maybeShowWizard(); await flush();
      expect(reload.agent.state.wizardDirId).toBe("receipt-0");
      expect((await reload.browser.list()).filter(p => p.name.includes("searchable")).map(p => p.dirId)).toEqual(["receipt-0"]);
      fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ ordering, index, checkpoint, ids: rows().map(p => p.dirId), bytes: committedBytes.toString() }));
    });
  }
  for (const dismiss of ["wizardSkip", "wizardNeverShow", "wizardConfigureAgent"]) {
    it(`retains a committed receipt after ${dismiss} without resurrecting its checkpoint or stale UI`, async () => {
      const { h, pending, rows, index, checkpoint } = durableWizardFixture();
      h.agent.showWizard(); await flush(); h.elements["wizard-profile-name"].value = "Dismissed receipt";
      h.agent.wizardCreateProfile(); await flush(); h.agent[dismiss]();
      const bytes = fs.readFileSync(index), deleted = fs.readFileSync(checkpoint), status = h.elements["wizard-step2-status"].innerHTML;
      pending.resolve(rows()[0]); await flush();
      expect(fs.readFileSync(checkpoint)).toEqual(deleted); expect(h.storage.has(PROGRESS)).toBe(false);
      expect(h.elements["dlg-wizard"].open).toBe(false); expect(h.elements["wizard-step2-status"].innerHTML).toBe(status);
      // Only an explicit restart may adopt the receipt; it must validate the actual ID/name.
      h.agent.restartWizard(); await flush();
      expect(h.agent.state.wizardDirId).toBe("receipt-0"); expect(h.button("wizardCreateProfile").disabled).toBe(true);
      h.agent.wizardCreateProfile(); await flush(); expect(h.browser.create).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(index)).toEqual(bytes);
      expect((await h.browser.list()).filter(p => p.name === "Dismissed receipt").map(p => p.dirId)).toEqual(["receipt-0"]);
    });
  }
  for (const result of ["rejection", "refusal"] as const) {
    it(`allows a truthful retry after late ${result} without clobbering a reopened name`, async () => {
      const h = harness("wizard", { step: 1 }); h.agent.showWizard(); await flush();
      const pending = deferred<any>(); h.browser.create.mockReturnValueOnce(pending.promise);
      h.elements["wizard-profile-name"].value = "Old submitted"; h.agent.wizardCreateProfile(); await flush();
      h.elements["dlg-wizard"].close(); h.agent.showWizard();
      h.elements["wizard-profile-name"].value = "New user input";
      const status = h.elements["wizard-step2-status"].innerHTML;
      if (result === "rejection") pending.reject(new Error("late transport refusal"));
      else pending.resolve({ success: false, code: "PROFILE_LIMIT" });
      await flush();
      expect(h.elements["wizard-profile-name"].value).toBe("New user input");
      expect(h.elements["wizard-step2-status"].innerHTML).toBe(status);
      expect(h.agent.interceptLicenseGate).not.toHaveBeenCalled();
      expect(h.button("wizardCreateProfile").disabled).toBe(false);
      h.agent.wizardCreateProfile(); await flush();
      expect(h.browser.create).toHaveBeenNthCalledWith(2, { name: "New user input" });
      expect(h.agent.state.wizardDirId).toBe("synthetic-created");
    });
  }
  for (const result of ["success", "refusal", "rejection"] as const) {
    it(`ignores risk ${result} after skip/reopen, while current consent and launch still work`, async () => {
      const h = harness("wizard", { step: 2, dirId: "risk-owned", profileName: "Risk owned" });
      h.browser.list.mockResolvedValue([{ dirId: "risk-owned", name: "Risk owned" }]);
      h.browser.status.mockResolvedValue({ running: true });
      h.agent.ensureExternalRiskConsent.mockImplementation((_id: string, cb: () => void) => cb());
      const pending = deferred<any>(); h.browser.openRiskCheck.mockReturnValueOnce(pending.promise);
      h.agent.showWizard(); await flush(); h.agent.wizardLaunchAndCheck(); await flush();
      expect(h.browser.openRiskCheck).toHaveBeenCalledTimes(1);
      h.agent.wizardSkip(); const storage = JSON.stringify(Object.fromEntries(h.storage));
      if (result === "rejection") pending.reject(new Error("late risk refusal"));
      else pending.resolve({ success: result === "success", error: "late refusal" });
      await flush();
      expect(JSON.stringify(Object.fromEntries(h.storage))).toBe(storage);
      expect(h.elements["dlg-wizard"].open).toBe(false);
      // Explicit current restart restores the real checkpoint and still obeys both gateways.
      h.storage.set(PROGRESS, JSON.stringify({ step: 2, dirId: "risk-owned", profileName: "Risk owned" }));
      h.agent.restartWizard(); await flush();
      h.browser.status.mockResolvedValue({ running: false });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
      try {
        h.agent.wizardLaunchAndCheck(); await flush();
        expect(h.agent.ensureExternalRiskConsent).toHaveBeenCalledTimes(2);
        expect(h.agent.confirm).toHaveBeenCalledTimes(1); expect(h.browser.openRiskCheck).toHaveBeenCalledTimes(1);
        h.agent.confirm.mock.calls[0][1](); await flush();
        expect(h.browser.openRiskCheck).toHaveBeenLastCalledWith("risk-owned", { allowLaunch: true });
        expect(JSON.parse(h.storage.get(PROGRESS)!)).toMatchObject({ step: 3, dirId: "risk-owned" });
      } finally { vi.restoreAllMocks(); }
    });
  }
  it("a receipt lookup failure blocks duplicate creation until Verify validates its renamed live ID", async () => {
    const { h, pending, rows, index } = durableWizardFixture(); h.agent.showWizard(); await flush();
    h.elements["wizard-profile-name"].value = "Original receipt"; h.agent.wizardCreateProfile(); await flush();
    h.elements["dlg-wizard"].close(); h.agent.showWizard();
    h.browser.list.mockRejectedValueOnce(new Error("receipt lookup unavailable"));
    pending.resolve(rows()[0]); await flush();
    expect(h.button("wizardCreateProfile").disabled).toBe(true); expect(h.button("wizardLaunchAndCheck").disabled).toBe(true);
    expect(JSON.parse(h.storage.get(PROGRESS)!)).toMatchObject({ step: 2, dirId: "receipt-0" });
    h.agent.wizardCreateProfile(); expect(h.browser.create).toHaveBeenCalledTimes(1);
    const renamed = rows(); renamed[0].name = "Renamed live receipt"; fs.writeFileSync(index, JSON.stringify(renamed));
    h.agent.wizardVerifyBinary(); await flush();
    expect(h.agent.state.wizardDirId).toBe("receipt-0"); expect(h.elements["wizard-profile-name"].value).toBe("Renamed live receipt");
    expect(h.button("wizardLaunchAndCheck").disabled).toBe(false);
  });
  it("skip then explicit restart during creation keeps the receipt, not an old checkpoint or old UI", async () => {
    const { h, pending, rows, checkpoint } = durableWizardFixture(); h.agent.showWizard(); await flush();
    h.agent.wizardCreateProfile(); await flush(); h.agent.wizardSkip(); h.agent.restartWizard();
    const deleted = fs.readFileSync(checkpoint), status = h.elements["wizard-step2-status"].innerHTML;
    pending.resolve(rows()[0]); await flush(); h.agent.wizardCreateProfile(); await flush();
    expect(fs.readFileSync(checkpoint)).toEqual(deleted); expect(h.elements["wizard-step2-status"].innerHTML).toBe(status);
    expect(h.browser.create).toHaveBeenCalledTimes(1);
    // Current explicit Verify may now reconcile; it never repeats the create.
    h.agent.wizardVerifyBinary(); await flush();
    expect(h.agent.state.wizardDirId).toBe("receipt-0"); expect(h.browser.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.storage.get(PROGRESS)!)).toMatchObject({ step: 2, dirId: "receipt-0" });
  });
  for (const result of ["success", "refusal", "rejection"] as const) {
    it(`late risk ${result} cannot overwrite a reopened wizard's name, controls or checkpoint`, async () => {
      const h = harness("wizard", { step: 2, dirId: "risk-owned" }), pending = deferred<any>();
      h.browser.list.mockResolvedValue([{ dirId: "risk-owned", name: "Risk" }]); h.browser.status.mockResolvedValue({ running: true });
      h.agent.ensureExternalRiskConsent.mockImplementation((_id: string, cb: () => void) => cb());
      h.browser.openRiskCheck.mockReturnValueOnce(pending.promise); h.agent.showWizard(); await flush();
      h.agent.wizardLaunchAndCheck(); await flush(); h.agent.wizardSkip();
      h.storage.set(PROGRESS, JSON.stringify({ step: 1 })); h.agent.restartWizard();
      h.elements["wizard-profile-name"].value = "Reopened user name";
      const before = JSON.stringify(Object.fromEntries(h.storage));
      if (result === "rejection") pending.reject(new Error("stale risk")); else pending.resolve({ success: result === "success", error: "stale risk" });
      await flush();
      expect(JSON.stringify(Object.fromEntries(h.storage))).toBe(before); expect(h.elements["wizard-profile-name"].value).toBe("Reopened user name");
      expect(h.button("wizardCreateProfile").disabled).toBe(false); expect(h.button("wizardLaunchAndCheck").disabled).toBe(true);
      expect(h.agent.helpers.scheduleProfilesRefresh).not.toHaveBeenCalled();
    });
  }
  it("rejects stale consent, status, and launch-confirmation callbacks before issuing a risk request", async () => {
    for (const stage of ["consent", "status", "confirmation"]) {
      const h = harness("wizard", { step: 2, dirId: "risk-owned" });
      h.browser.list.mockResolvedValue([{ dirId: "risk-owned", name: "Risk" }]);
      const pending = deferred<any>(); h.browser.status.mockReturnValue(pending.promise);
      h.agent.showWizard(); await flush(); h.agent.wizardLaunchAndCheck();
      const consent = h.agent.ensureExternalRiskConsent.mock.calls[0][1];
      if (stage !== "consent") { consent(); await flush(); }
      if (stage === "confirmation") { pending.resolve({ running: false }); await flush(); }
      h.agent.wizardSkip();
      if (stage === "consent") consent();
      if (stage === "status") pending.resolve({ running: true });
      if (stage === "confirmation") h.agent.confirm.mock.calls[0][1]();
      await flush(); expect(h.browser.openRiskCheck).not.toHaveBeenCalled(); expect(h.storage.has(PROGRESS)).toBe(false);
      if (stage === "status") expect(h.agent.confirm).not.toHaveBeenCalled();
    }
  });
});

describe("F10 license readiness UI (controlled provider, not a license bypass)", () => {
  it("discloses trial-only builds and blocks activation before clearing an entered code", async () => {
    const h = harness("license"); h.license.status.mockResolvedValue({ plan: "trial", canActivate: false, deviceId: "synthetic" });
    h.agent.showLicenseDialog(); await flush();
    expect(h.elements["license-activate-btn"].disabled).toBe(true);
    expect(h.elements["license-code-input"].disabled).toBe(true);
    expect(h.elements["license-error"].textContent).toContain("cannot verify licenses");
    h.elements["license-code-input"].value = "not-a-license"; h.elements["license-refund-ack"].checked = true;
    h.agent.submitLicenseActivation(); await flush();
    expect(h.license.activate).not.toHaveBeenCalled(); expect(h.elements["license-code-input"].value).toBe("not-a-license");
  });
  it("does not offer activation when the status lookup fails", async () => {
    const h = harness("license"); h.license.status.mockRejectedValue(new Error("synthetic status unavailable"));
    h.agent.showLicenseDialog(); await flush();
    expect(h.elements["dlg-license"].open).toBe(true);
    expect(h.elements["license-activate-btn"].disabled).toBe(true);
    expect(h.elements["license-error"].textContent).not.toBe("");
  });
  it("preserves refund acknowledgement and code checks on a ready build", async () => {
    const h = harness("license"); h.agent.showLicenseDialog(); await flush();
    expect(h.elements["license-activate-btn"].disabled).toBe(false);
    h.agent.submitLicenseActivation(); await flush(); expect(h.license.activate).not.toHaveBeenCalled();
    expect(h.elements["license-error"].textContent).toContain("acknowledgement");
    h.elements["license-refund-ack"].checked = true; h.agent.submitLicenseActivation(); await flush();
    expect(h.elements["license-error"].textContent).toContain("activation code first");
    h.elements["license-code-input"].value = "not-a-license"; h.agent.submitLicenseActivation();
    expect(h.elements["license-code-input"].value).toBe(""); await flush();
    expect(h.license.activate).toHaveBeenCalledWith("not-a-license"); expect(h.elements["license-error"].textContent).toBe("Synthetic refusal");
  });
  it("coalesces double activation and re-enables controls after rejection", async () => {
    const h = harness("license"); h.agent.showLicenseDialog(); await flush();
    const pending = deferred<any>(); h.license.activate.mockReturnValue(pending.promise);
    h.elements["license-refund-ack"].checked = true; h.elements["license-code-input"].value = "not-a-license";
    h.agent.submitLicenseActivation(); h.elements["license-code-input"].value = "second-invalid"; h.agent.submitLicenseActivation();
    expect(h.elements["license-activate-btn"].disabled).toBe(true); await flush();
    expect(h.license.activate).toHaveBeenCalledTimes(1);
    pending.reject(new Error("synthetic refusal")); await flush(); expect(h.elements["license-activate-btn"].disabled).toBe(false);
  });
  it("does not resurrect a cancelled dialog when status arrives late", async () => {
    const h = harness("license"); const pending = deferred<any>(); h.license.status.mockReturnValue(pending.promise);
    h.agent.showLicenseDialog(); await flush();
    h.elements["dlg-license"].close();
    pending.resolve({ plan: "trial", canActivate: true }); await flush();
    expect(h.elements["dlg-license"].open).toBe(false);
  });
  for (const ordering of ["older-first", "newer-first"] as const) {
    for (const latest of ["ready", "unavailable", "error"] as const) {
      it(`updates live activation controls for ${latest} with ${ordering} without stale writes`, async () => {
        const h = harness("license"), old = deferred<any>(), current = deferred<any>();
        h.license.status.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        h.agent.showLicenseDialog(); await flush(); h.agent.refreshLicense(); await flush();
        const settleOld = async () => { old.resolve({ plan: "trial", canActivate: latest !== "ready", deviceId: "stale-device" }); await flush(); };
        const settleCurrent = async () => {
          if (latest === "error") current.reject(new Error("latest unavailable"));
          else current.resolve({ plan: "trial", canActivate: latest === "ready", deviceId: "latest-device" });
          await flush();
        };
        if (ordering === "older-first") { await settleOld(); await settleCurrent(); }
        else { await settleCurrent(); await settleOld(); }
        expect(h.elements["license-activate-btn"].disabled).toBe(latest !== "ready");
        expect(h.elements["license-code-input"].disabled).toBe(latest !== "ready");
        expect(h.elements["license-device-id"].textContent).toBe(latest === "error" ? "—" : "latest-device");
        expect(h.elements["license-error"].style.display).toBe(latest === "ready" ? "none" : "");
        expect(h.elements["dlg-license"].open).toBe(true);
        if (latest === "ready") {
          h.elements["license-code-input"].value = "user controlled invalid code";
          h.agent.submitLicenseActivation(); expect(h.license.activate).not.toHaveBeenCalled();
          h.elements["license-refund-ack"].checked = true;
          h.agent.submitLicenseActivation(); await flush();
          expect(h.license.activate).toHaveBeenCalledWith("user controlled invalid code");
          expect(h.elements["license-error"].textContent).toBe("Synthetic refusal");
        } else {
          h.elements["license-code-input"].value = "never submit"; h.elements["license-refund-ack"].checked = true;
          h.agent.submitLicenseActivation(); await flush(); expect(h.license.activate).not.toHaveBeenCalled();
          expect(h.elements["license-code-input"].value).toBe("never submit");
        }
      });
    }
  }
  for (const ordering of ["older-first", "newer-first"]) {
    it(`stale status rejection cannot disable latest ready controls with ${ordering}`, async () => {
      const h = harness("license"), old = deferred<any>(), current = deferred<any>();
      h.license.status.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      h.agent.showLicenseDialog(); await flush(); h.elements["dlg-license"].close(); h.agent.showLicenseDialog(); await flush();
      h.elements["license-code-input"].value = "Preserved reopened input";
      const rejectOld = async () => { old.reject(new Error("stale rejection")); await flush(); };
      const ready = async () => { current.resolve({ plan: "trial", canActivate: true, deviceId: "reopened-device" }); await flush(); };
      if (ordering === "older-first") { await rejectOld(); await ready(); } else { await ready(); await rejectOld(); }
      expect(h.elements["dlg-license"].open).toBe(true); expect(h.elements["license-activate-btn"].disabled).toBe(false);
      expect(h.elements["license-device-id"].textContent).toBe("reopened-device"); expect(h.elements["license-code-input"].value).toBe("Preserved reopened input");
      expect(h.elements["license-error"].style.display).toBe("none");
    });
  }
  it("background truth updates an open dialog without clearing user input, consent, or activation error", async () => {
    const h = harness("license"); h.agent.showLicenseDialog(); await flush();
    h.elements["license-refund-ack"].checked = true; h.elements["license-code-input"].value = "synthetic invalid";
    h.agent.submitLicenseActivation(); await flush(); expect(h.elements["license-error"].textContent).toBe("Synthetic refusal");
    h.elements["license-code-input"].value = "New user text";
    h.license.status.mockResolvedValue({ plan: "trial", canActivate: true, deviceId: "fresh-device" });
    await h.agent.refreshLicense(); await flush();
    expect(h.elements["license-code-input"].value).toBe("New user text"); expect(h.elements["license-refund-ack"].checked).toBe(true);
    expect(h.elements["license-error"].textContent).toBe("Synthetic refusal");
    expect(h.elements["license-device-id"].textContent).toBe("fresh-device");
    h.license.status.mockResolvedValue({ plan: "trial", canActivate: false, deviceId: "fresh-device" });
    await h.agent.refreshLicense(); await flush();
    expect(h.elements["license-code-input"].disabled).toBe(true); expect(h.elements["license-code-input"].value).toBe("New user text");
    expect(h.elements["license-error"].textContent).toContain("cannot verify licenses");
  });
  for (const result of ["success", "refusal", "rejection"] as const) {
    it(`does not let late activation ${result} close or overwrite a reopened dialog`, async () => {
      const h = harness("license"), pending = deferred<any>(); h.agent.showLicenseDialog(); await flush();
      h.license.activate.mockReturnValueOnce(pending.promise);
      h.elements["license-refund-ack"].checked = true; h.elements["license-code-input"].value = "synthetic code";
      h.agent.submitLicenseActivation(); await flush(); h.elements["dlg-license"].close(); h.agent.showLicenseDialog(); await flush();
      h.elements["license-code-input"].value = "Reopened user text";
      expect(h.elements["license-refund-ack"].checked).toBe(false);
      expect(h.elements["license-activate-btn"].disabled).toBe(true);
      if (result === "rejection") pending.reject(new Error("stale activation error"));
      else pending.resolve({ ok: result === "success", error: "stale activation error" });
      await flush();
      expect(h.elements["dlg-license"].open).toBe(true); expect(h.elements["license-code-input"].value).toBe("Reopened user text");
      expect(h.elements["license-error"].textContent).not.toContain("stale activation error");
      expect(h.elements["license-activate-btn"].disabled).toBe(false); expect(h.elements["license-refund-ack"].checked).toBe(false);
    });
  }
  it("current successful activation closes only its own dialog and refreshes truth", async () => {
    const h = harness("license"); h.agent.showLicenseDialog(); await flush();
    h.license.activate.mockResolvedValue({ ok: true });
    h.elements["license-refund-ack"].checked = true; h.elements["license-code-input"].value = "controlled success response";
    h.agent.submitLicenseActivation(); await flush();
    expect(h.elements["dlg-license"].open).toBe(false); expect(h.license.status).toHaveBeenCalledTimes(2);
    expect(h.elements["license-code-input"].value).toBe("");
  });
  for (const latest of ["expired", "licensed", "lookup-error"] as const) {
    it(`prevents old profile-count bytes from overwriting the ${latest} banner`, async () => {
      const h = harness("license"), usage = deferred<any>();
      h.browser.list.mockReturnValue(usage.promise);
      h.license.status.mockResolvedValueOnce({ plan: "trial", daysLeft: 14, maxProfiles: 10, canActivate: true, expired: false });
      await h.agent.refreshLicense();
      if (latest === "lookup-error") h.license.status.mockRejectedValueOnce(new Error("latest unavailable"));
      else h.license.status.mockResolvedValueOnce(latest === "expired" ? { plan: "trial", daysLeft: 0, canActivate: true, expired: true } : { plan: "lifetime", canActivate: true });
      await h.agent.refreshLicense(); await flush();
      const current = h.elements["license-banner"].innerHTML, visible = h.elements["license-banner"].style.display;
      const body = h.elements["license-banner"].querySelector("span")?.innerHTML;
      usage.resolve([{ dirId: "one", name: "synthetic" }]); await flush();
      expect(h.elements["license-banner"].innerHTML).toBe(current);
      expect(h.elements["license-banner"].querySelector("span")?.innerHTML).toBe(body);
      expect(h.elements["license-banner"].style.display).toBe(visible);
      if (latest === "expired") expect(h.elements["license-banner"].querySelector("span")?.innerHTML || current).not.toContain("14 days left");
      if (latest === "lookup-error") expect(visible).toBe("none");
    });
  }
  it("current profile count still updates truthful trial usage", async () => {
    const h = harness("license"), usage = deferred<any>(); h.browser.list.mockReturnValue(usage.promise);
    await h.agent.refreshLicense(); usage.resolve([{ dirId: "one", name: "synthetic" }]); await flush();
    expect(h.elements["license-banner"].querySelector("span")?.innerHTML).toContain("14 days left · 1/10");
  });
  it("latest status failure or success cannot reopen a closed dialog; reopened requests supersede old dialogs", async () => {
    for (const result of ["success", "error"]) {
      const h = harness("license"), old = deferred<any>(); h.license.status.mockReturnValueOnce(old.promise);
      h.agent.showLicenseDialog(); await flush(); h.elements["dlg-license"].close();
      if (result === "error") old.reject(new Error("old status failed")); else old.resolve({ plan: "trial", canActivate: true });
      await flush(); expect(h.elements["dlg-license"].open).toBe(false);
      h.agent.showLicenseDialog(); await flush();
      expect(h.elements["license-activate-btn"].disabled).toBe(false); expect(h.elements["license-device-id"].textContent).toBe("synthetic-device");
    }
  });
  it("newer status wins over an older late response", async () => {
    const h = harness("license"); const old = deferred<any>();
    h.license.status.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ plan: "trial", canActivate: false });
    h.agent.refreshLicense(); await h.agent.refreshLicense();
    old.resolve({ plan: "trial", canActivate: true }); await flush();
    expect(h.agent.licenseStatus().canActivate).toBe(false);
  });
});
