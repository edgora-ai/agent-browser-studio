// F09: real isolated Electron, IPC/GUI, and storage readback (no browser launch).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f09-trash-e2e-"));
const CONFIG = path.join(USERDATA, "config.json");
const INDEX = path.join(USERDATA, "trash", "index.json");
// Default evidence belongs to this test's disposable userData. A runner may
// explicitly retain screenshots in a fresh directory without touching old runs.
const EVIDENCE_DIR = process.env.AGENT_BROWSER_F09_EVIDENCE_DIR
  ? path.resolve(process.env.AGENT_BROWSER_F09_EVIDENCE_DIR) : path.join(USERDATA, "evidence");
const screenshot = (name: string) => path.join(EVIDENCE_DIR, name);
const SCREENSHOT = screenshot("f09-trash-index-error.png");
const RECOVERY_SCREENSHOT = screenshot("f09-trash-recovery-warning.png");
const INCOMPLETE_SCREENSHOT = screenshot("f09-trash-incomplete-warning.png");
const BATCH_ERROR_SCREENSHOT = screenshot("f09-batch-error-detail.png");
const UNDO_ERROR_SCREENSHOT = screenshot("f09-undo-recovery-detail.png");
const UNDO_ERROR_BOTTOM_SCREENSHOT = screenshot("f09-undo-recovery-detail-bottom.png");
const STORE_URL = pathToFileURL(path.join(__dirname, "../../dist/main/services/config/store.js")).href;
const CONFIG_URL = pathToFileURL(path.join(__dirname, "../../dist/main/services/config-manager.js")).href;
const EXPORT_URL = pathToFileURL(path.join(__dirname, "../../dist/main/services/data-export.js")).href;
const disk = () => JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const index = () => JSON.parse(fs.readFileSync(INDEX, "utf8"));
const sourceFile = (id: string) => path.join(USERDATA, "profiles", id, "Default", "f09-sentinel.txt");
const trashFile = (id: string) => path.join(USERDATA, "trash", "profiles", id, "Default", "f09-sentinel.txt");

async function main(op: "reload" | "role" | "lock" | "reintroduce" | "drop", id?: string): Promise<any> {
  return handle.app.evaluate(async (_app, args: { op: string; id?: string; storeUrl: string; configUrl: string }) => {
    const vm = process.getBuiltinModule("node:vm");
    const load = (url: string): Promise<any> => vm.runInThisContext(`import(${JSON.stringify(url)})`, {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const [store, config] = await Promise.all([load(args.storeUrl), load(args.configUrl)]);
    if (args.op === "role") {
      store.transact((draft: any) => {
        const own = draft.deviceId;
        draft.team = { name: "F09 synthetic team", ownerDeviceId: own, enabled: true, updatedAt: Date.now(),
          members: [{ deviceId: own, name: "F09 local", role: args.id, addedAt: Date.now() }] };
      });
    } else if (args.op === "lock") {
      store.transact((draft: any) => { draft.browserProfiles[args.id!].lock = { owner: "f09-other-device", ownerName: "F09 other", at: Date.now() }; });
    } else if (args.op === "reintroduce") {
      store.transact((draft: any) => { draft.browserProfiles[args.id!] = { dirId: args.id, name: "F09 recovery fixture", engine: "chromium" }; });
    } else if (args.op === "drop") {
      store.transact((draft: any) => { delete draft.browserProfiles[args.id!]; });
    } else config.reloadConfig();
    return args.id && args.op !== "role" ? config.getProfileMeta(args.id) : Object.keys(config.getConfig().browserProfiles);
  }, { op, id, storeUrl: STORE_URL, configUrl: CONFIG_URL });
}
let handle: TestAppHandle;
const ipc = async (method: "trash" | "trashList" | "trashRestore" | "trashPurge", id?: string) =>
  handle.page.evaluate(async ({ method, id }) => {
    const p = (window as any).agentBrowser.api.profile;
    return id ? p[method](id) : p[method]();
  }, { method, id });

// Read-only main-process observation of raw metadata and the real structured
// export. Neither getProfileMeta nor the GUI profile projection exposes createdAt.
async function createdAtReadback(id: string): Promise<any> {
  return handle.app.evaluate(async (_app, args: { id: string; configUrl: string; exportUrl: string }) => {
    const vm = process.getBuiltinModule("node:vm");
    const load = (url: string): Promise<any> => vm.runInThisContext(`import(${JSON.stringify(url)})`, {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const [config, exporter] = await Promise.all([load(args.configUrl), load(args.exportUrl)]);
    return {
      meta: config.getConfig().browserProfiles[args.id] ?? null,
      profiles: exporter.exportData("profiles").data.profiles.filter((p: any) => p.dirId === args.id),
    };
  }, { id, configUrl: CONFIG_URL, exportUrl: EXPORT_URL });
}

async function create(name: string): Promise<string> {
  const result = await handle.page.evaluate((label) => (window as any).agentBrowser.api.browser.create({
    name: label, platform: "windows", fingerprintMode: "off", proxyMode: "none", fingerprintSeed: 4242,
  }), name);
  expect(result.dirId, JSON.stringify(result)).toBeTruthy();
  return result.dirId;
}

// Retire only fixtures whose success/readback assertions already completed in
// this case. Real IPC keeps the suite within the unchanged trial quota, and the
// cleanup itself must prove config, index, files and query results agree.
async function retireVerifiedProfiles(ids: string[]): Promise<void> {
  for (const id of ids) {
    const sentinel = fs.readFileSync(sourceFile(id), "utf8");
    const meta = disk().browserProfiles[id];
    expect(meta).toBeDefined();
    expect(await ipc("trash", id)).toMatchObject({ success: true });
    expect(fs.existsSync(sourceFile(id))).toBe(false);
    expect(fs.readFileSync(trashFile(id), "utf8")).toBe(sentinel);
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
    expect(index().find((entry: any) => entry.dirId === id).meta).toMatchObject(meta);
    expect(await ipc("trashPurge", id)).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(USERDATA, "profiles", id))).toBe(false);
    expect(fs.existsSync(path.join(USERDATA, "trash", "profiles", id))).toBe(false);
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
    expect(index().some((entry: any) => entry.dirId === id)).toBe(false);
    expect(await main("reload", id)).toBeNull();
  }
  const live = await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
  const trashed = await ipc("trashList");
  expect(trashed.success).toBe(true);
  for (const id of ids) {
    expect(live.some((entry: any) => entry.dirId === id)).toBe(false);
    expect(trashed.entries.some((entry: any) => entry.dirId === id)).toBe(false);
  }
}

// Renderer-only IPC faults: the backend filesystem fault matrix is covered by
// the unit tests. These prove that a real button + dialog do not hide the full
// backend message when an IPC response fails or its promise rejects.
function singleError(action: "trash" | "restore" | "purge", id: string): string {
  const warning = action === "purge" ? "WARNING: deletion may already be irreversible; inspect remaining bytes." : "Do not assume the operation committed.";
  return `EACCES: permission denied during ${action}; ${"recovery context ".repeat(80)}\n` +
    `Recovery required: ${warning} Remaining paths: ${sourceFile(id)}, ${trashFile(id)}; ` +
    `disk config ${CONFIG}: unchanged; inspect <untrusted-file-name>; END-${id}`;
}

async function injectSingleErrors(action: string, returnedId: string, rejectedId: string): Promise<void> {
  await handle.page.evaluate(({ action, returnedId, rejectedId, returnedError, rejectedError }) => {
    const ipc = (window as any).agentBrowser.ipc;
    (window as any).__f09SingleOriginalCall = ipc.call;
    (window as any).__f09SingleCalls = [];
    (window as any).__f09SinglePending = {};
    ipc.call = function (key: string, fn: Function, opts: any) {
      (window as any).__f09SingleCalls.push(key);
      if (key === `profile.${action}:${returnedId}` || key === `profile.${action}:${rejectedId}`) {
        return new Promise((resolve, reject) => {
          (window as any).__f09SinglePending[key] = () => key.endsWith(`:${returnedId}`)
            ? resolve({ success: false, error: returnedError }) : reject(new Error(rejectedError));
        });
      }
      return (window as any).__f09SingleOriginalCall.call(this, key, fn, opts);
    };
  }, { action, returnedId, rejectedId,
    returnedError: singleError(action.replace(/^trash-/, "") as "trash" | "restore" | "purge", returnedId),
    rejectedError: singleError(action.replace(/^trash-/, "") as "trash" | "restore" | "purge", rejectedId) });
}

async function restoreSingleCalls(): Promise<void> {
  await handle.page.evaluate(() => {
    const ipc = (window as any).agentBrowser.ipc;
    ipc.call = (window as any).__f09SingleOriginalCall;
    delete (window as any).__f09SingleOriginalCall;
    delete (window as any).__f09SingleCalls;
    delete (window as any).__f09SinglePending;
  });
}

async function releaseSingleError(action: string, id: string): Promise<void> {
  await handle.page.evaluate(({ action, id }) => {
    const key = `profile.${action}:${id}`;
    const release = (window as any).__f09SinglePending[key];
    if (!release) throw new Error(`Missing pending F09 call: ${key}`);
    delete (window as any).__f09SinglePending[key];
    release();
  }, { action, id });
}

async function expectSingleBusy(action: "trash" | "trash-restore" | "trash-purge", id: string): Promise<void> {
  if (action === "trash") {
    const card = handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);
    expect(await card.getAttribute("aria-busy")).toBe("true");
    expect(await card.locator('[data-action="delete"]').isDisabled()).toBe(true);
    await handle.page.evaluate((id) => {
      (window as any).agentBrowser.delProfile(id);
      (window as any).agentBrowser.delProfile(id);
    }, id);
  } else {
    const restore = handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`);
    const purge = handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`);
    expect(await restore.isDisabled()).toBe(true);
    expect(await purge.isDisabled()).toBe(true);
    // Native disabled buttons block user input; explicit dispatch also proves
    // the per-ID guard prevents a JS/keyboard race across the two actions.
    for (const btn of [restore, purge]) await btn.dispatchEvent("click");
  }
  expect(await handle.page.locator("#dlg-confirm").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(false);
  const calls = await handle.page.evaluate(() => (window as any).__f09SingleCalls as string[]);
  expect(calls.filter((key) => key === `profile.${action}:${id}`)).toHaveLength(1);
  expect(calls.filter((key) => key.endsWith(`:${id}`))).toHaveLength(1);
}

async function expectNoFailureRefresh(): Promise<void> {
  const calls = await handle.page.evaluate(() => (window as any).__f09SingleCalls as string[]);
  expect(calls).not.toContain("profile.trash-list"); // This channel automatically sweeps expired entries.
  expect(calls).not.toContain("browser.list");
}

async function openTrashFromHeader(): Promise<void> {
  await handle.page.locator("#dlg-trash").evaluate((dlg: HTMLDialogElement) => { if (dlg.open) dlg.close(); });
  await handle.page.locator("#nav-profiles").click();
  await handle.page.locator("#profiles-more-menu summary").click();
  await handle.page.locator('#profiles-more-menu [data-cmd="showTrash"]').click();
  await expect.poll(() => handle.page.locator("#dlg-trash").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(true);
}

async function expectForegroundDetail(id: string, error: string, inDialog: boolean): Promise<void> {
  const host = inDialog ? handle.page.locator("#dlg-trash #trash-action-error") : handle.page.locator(".toast-stack .toast-error").last();
  const detail = host.locator(".toast-detail");
  await expect.poll(() => detail.textContent()).toBe(`${id}: ${error}`);
  const summary = await host.locator(inDialog ? ".trash-action-summary" : ".toast-msg").innerText();
  expect(summary).toMatch(/fail|could not/i);
  expect(summary).not.toMatch(/viewer|workspace role/i);
  // A DOM node may be `visible` but under a native showModal() top layer.
  // elementFromPoint proves the user can actually reach the message.
  const foreground = await detail.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && !!hit && (hit === el || el.contains(hit));
  });
  expect(foreground).toBe(true);
  expect(await detail.textContent()).toContain(`END-${id}`);
  expect(await detail.locator("untrusted-file-name").count()).toBe(0);
  const bottom = await detail.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const text = el.firstChild!;
    const range = document.createRange();
    range.setStart(text, (text.textContent || "").length - 1);
    range.setEnd(text, (text.textContent || "").length);
    const rect = range.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const result = { top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight,
      tailVisible: rect.width > 0 && rect.height > 0 && !!hit && (hit === el || el.contains(hit)) };
    el.scrollTop = 0;
    return result;
  });
  expect(bottom.top).toBeGreaterThan(0);
  // scrollTop is fractional on HiDPI; scrollHeight/clientHeight are rounded CSS pixels.
  expect(Math.abs(bottom.top - bottom.bottom)).toBeLessThanOrEqual(1);
  expect(bottom.tailVisible).toBe(true);
}

async function captureSingleDetail(action: "trash" | "restore" | "purge", suffix: string): Promise<void> {
  const host = action === "trash" ? handle.page.locator(".toast-stack .toast-error").last() : handle.page.locator("#dlg-trash");
  await host.screenshot({ path: screenshot(`f09-single-${action}-${suffix}.png`) });
  await host.locator(".toast-detail").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await host.screenshot({ path: screenshot(`f09-single-${action}-${suffix}-bottom.png`) });
}

async function withNarrowTrashWindow(check: () => Promise<void>): Promise<void> {
  const original = await handle.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))!;
    const bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    win.setContentSize(800, bounds.height); // Product's supported minimum window width.
    win.webContents.setZoomFactor(1.5); // Real accessible zoom also constrains the dialog, not emulated CSS.
    return { ...bounds, zoom };
  });
  try {
    await expect.poll(() => handle.page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(534);
    await check();
  } finally {
    await handle.app.evaluate(({ BrowserWindow }, bounds) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))!;
      win.webContents.setZoomFactor(bounds.zoom);
      win.setContentSize(bounds.width, bounds.height);
    }, original);
  }
}

// Measure production DOM/text boxes rather than accepting `visible` on elements
// whose text can paint over neighbouring controls. This also runs on the old
// unclassed markup, so RED diagnoses the overlap instead of a missing selector.
async function expectTrashRowGeometry(name: string, warningText: string | null, evidence: string): Promise<void> {
  const list = handle.page.locator("#trash-list");
  const row = list.locator(":scope > div").filter({ has: handle.page.getByText(name, { exact: true }) });
  await row.evaluate(async (el) => {
    el.scrollIntoView({ block: "center" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  // Playwright's locator clip is in CSS pixels and misclips Electron at native
  // zoom. Capture the actual window through Electron, including the narrow case.
  const png = await handle.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))!;
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  });
  fs.writeFileSync(screenshot(`${evidence}.png`), Buffer.from(png, "base64"));
  const geometry = await row.evaluate((el, name) => {
    const box = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const textBoxes = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(range.getClientRects(), (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }));
    };
    const nameEl = Array.from(el.querySelectorAll("div")).find((child) => child.textContent === name)!;
    const warning = el.querySelector('[role="alert"]:not([hidden])') as HTMLElement | null;
    return {
      row: box(el), width: el.clientWidth, scrollWidth: el.scrollWidth,
      name: box(nameEl), nameText: textBoxes(nameEl), identity: box(nameEl.parentElement!),
      buttons: Array.from(el.querySelectorAll("button"), (button) => ({ box: box(button), text: textBoxes(button), label: button.textContent })),
      warning: warning ? { box: box(warning), text: textBoxes(warning), content: warning.textContent,
        overflow: getComputedStyle(warning).overflow, textOverflow: getComputedStyle(warning).textOverflow,
        lineClamp: getComputedStyle(warning).webkitLineClamp, height: warning.clientHeight, scrollHeight: warning.scrollHeight } : null,
    };
  }, name);
  fs.writeFileSync(screenshot(`${evidence}.json`), JSON.stringify(geometry, null, 2));
  type Box = typeof geometry.row;
  const overlaps = (a: Box, b: Box) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  const inside = (inner: Box, outer: Box) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  expect(geometry.scrollWidth, `${evidence}: row must not overflow horizontally`).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.name.width, `${evidence}: name must retain useful space`).toBeGreaterThanOrEqual(Math.min(160, geometry.row.width / 4));
  for (const rect of geometry.nameText) expect(inside(rect, geometry.name), `${evidence}: name text stays in its own box`).toBe(true);
  for (const [i, button] of geometry.buttons.entries()) {
    expect(inside(button.box, geometry.row), `${evidence}: ${button.label} stays in row`).toBe(true);
    expect(overlaps(button.box, geometry.identity), `${evidence}: ${button.label} must not overlap name/date`).toBe(false);
    for (const rect of button.text) expect(inside(rect, button.box), `${evidence}: button label must not overflow`).toBe(true);
    for (const other of geometry.buttons.slice(i + 1)) expect(overlaps(button.box, other.box), `${evidence}: buttons must not overlap`).toBe(false);
    for (const rect of geometry.nameText) expect(overlaps(rect, button.box), `${evidence}: name must not paint over buttons`).toBe(false);
  }
  if (warningText === null) expect(geometry.warning).toBeNull();
  else {
    expect(geometry.warning, `${evidence}: safety warning must be visible`).not.toBeNull();
    const warning = geometry.warning!;
    expect(warning.content).toBe(warningText);
    expect(warning.box.width, `${evidence}: warning owns a full separate line`).toBeGreaterThanOrEqual(geometry.row.width - 2);
    expect(warning.box.top, `${evidence}: warning follows name and actions`).toBeGreaterThanOrEqual(Math.max(geometry.identity.bottom, ...geometry.buttons.map((b) => b.box.bottom)) - 1);
    expect(warning.textOverflow).not.toBe("ellipsis");
    expect(warning.lineClamp).toBe("none");
    expect(warning.overflow).toBe("visible");
    expect(warning.scrollHeight).toBeLessThanOrEqual(warning.height + 1);
    for (const rect of warning.text) expect(inside(rect, warning.box), `${evidence}: full warning text is laid out, not clipped`).toBe(true);
    for (const button of geometry.buttons) expect(overlaps(warning.box, button.box), `${evidence}: warning must not overlap buttons`).toBe(false);
  }
}

describe("F09 — isolated Electron trash consistency", () => {
  beforeAll(async () => {
    handle = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: "0" } });
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const env = await handle.app.evaluate(({ app }) => ({
      home: process.env.HOME, nodeHome: process.getBuiltinModule("node:os").homedir(),
      userData: app.getPath("userData"), cache: process.env.AGENT_BROWSER_CHROMIUM_CACHE_DIR,
      providers: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(env.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(env.home!)).toBe(fs.realpathSync(env.nodeHome));
    expect(fs.realpathSync(env.userData)).toBe(fs.realpathSync(USERDATA));
    expect(env.cache).toBe(path.join(USERDATA, "chromium-cache"));
    expect(env.providers).toEqual([]);
    const llm = await handle.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
  }, 90_000);

  afterAll(async () => {
    if (handle) await closeApp(handle);
    if (path.dirname(USERDATA) !== os.tmpdir() || !path.basename(USERDATA).startsWith("studio-f09-trash-e2e-")) {
      throw new Error("Unsafe F09 cleanup path");
    }
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90_000);

  it("creates, trashes, lists, restores, reads by ID, then permanently purges real files", async () => {
    const id = await create("F09 recoverable synthetic");
    fs.writeFileSync(sourceFile(id), "F09-original-sentinel");
    const original = disk().browserProfiles[id];
    expect(original).toMatchObject({ name: "F09 recoverable synthetic", fingerprintSeed: 4242 });
    expect(await ipc("trash", id)).toMatchObject({ success: true });
    expect(fs.existsSync(sourceFile(id))).toBe(false);
    expect(fs.readFileSync(trashFile(id), "utf8")).toBe("F09-original-sentinel");
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
    expect(index().find((item: any) => item.dirId === id).meta).toMatchObject(original);
    expect(await ipc("trashList")).toMatchObject({ success: true, entries: [{ dirId: id, recoverable: true }] });
    expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((p: any) => p.dirId === id)).toBe(false);
    expect(await main("reload", id)).toBeNull();
    expect(await ipc("trashRestore", id)).toMatchObject({ success: true });
    expect(fs.readFileSync(sourceFile(id), "utf8")).toBe("F09-original-sentinel");
    expect(fs.existsSync(trashFile(id))).toBe(false);
    expect(index()).toEqual([]);
    expect(disk().browserProfiles[id]).toMatchObject({ name: original.name, fingerprintSeed: original.fingerprintSeed });
    expect(await main("reload", id)).toMatchObject({ name: original.name, fingerprintSeed: 4242 });
    expect((await handle.page.evaluate((id) => (window as any).agentBrowser.api.profile.get(id), id)).name).toBe(original.name);
    expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((p: any) => p.dirId === id)).toBe(true);
    expect(await ipc("trash", id)).toMatchObject({ success: true });
    expect(await ipc("trashPurge", id)).toMatchObject({ success: true });
    expect(index()).toEqual([]);
    expect(fs.existsSync(trashFile(id))).toBe(false);
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
    expect(await main("reload", id)).toBeNull();
    expect((await ipc("trashList")).entries).toEqual([]);
  }, 60_000);

  it.each([
    { label: "dated", initial: 1700000000123 },
    { label: "missing", initial: undefined },
  ])("preserves createdAt through real Delete/Undo and repeated Trash restore ($label)", async ({ label, initial }) => {
    // One ordinary synthetic profile at a time; no license or quota overrides.
    const id = await create(`F09 createdAt ${label} synthetic`);
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 42]);
    fs.writeFileSync(sourceFile(id), bytes);
    const seeded = disk();
    if (initial === undefined) delete seeded.browserProfiles[id].createdAt;
    else seeded.browserProfiles[id].createdAt = initial;
    fs.writeFileSync(CONFIG, JSON.stringify(seeded, null, 2));
    await main("reload", id); // Fixture setup only; mutations below use real UI buttons.
    const original = disk().browserProfiles[id];
    const unrelated = Object.fromEntries(Object.entries(disk().browserProfiles).filter(([key]) => key !== id));
    let expectedMeta = original;
    let expectedCreatedAt = initial;
    await handle.page.evaluate(() => (window as any).i18n.set("en-US"));
    await handle.page.evaluate(() => (window as any).agentBrowser.clearProfileFilters());
    await handle.page.locator("#nav-profiles").click();
    const card = handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);

    for (const cycle of [1, 2]) {
      await expect.poll(() => card.count()).toBe(1);
      await expect.poll(() => card.getAttribute("aria-busy")).not.toBe("true");
      await card.locator(".card-menu summary").click();
      await card.locator('[data-action="delete"]').click();
      await handle.page.locator('#dlg-confirm button[type="submit"]').click();
      await expect.poll(() => card.count()).toBe(0);
      expect(fs.existsSync(path.join(USERDATA, "profiles", id))).toBe(false);
      expect(fs.readFileSync(trashFile(id))).toEqual(bytes);
      expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
      expect(index().filter((entry: any) => entry.dirId === id)).toHaveLength(1);
      expect(index().find((entry: any) => entry.dirId === id).meta).toEqual(expectedMeta);
      expect(await main("reload", id)).toBeNull();
      expect(await createdAtReadback(id)).toEqual({ meta: null, profiles: [] });
      expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((p: any) => p.dirId === id)).toBe(false);

      if (cycle === 2) {
        await openTrashFromHeader();
        await expect.poll(() => handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).count()).toBe(1);
        // Ensure a resetting implementation cannot pass because both clocks fell
        // in one millisecond. This observes the real clock, never changes it.
        await expect.poll(() => handle.app.evaluate(() => Date.now())).toBeGreaterThan(expectedCreatedAt!);
      }
      const restoreLower = await handle.app.evaluate(() => Date.now());
      if (cycle === 1) {
        const undo = handle.page.locator(".toast-stack .toast-success").last().locator(".toast-action");
        expect(await undo.innerText()).toBe("Undo");
        await undo.click();
      } else await handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).click();
      await expect.poll(() => fs.existsSync(sourceFile(id))).toBe(true);
      await expect.poll(() => index().some((entry: any) => entry.dirId === id)).toBe(false);
      const restoreUpper = await handle.app.evaluate(() => Date.now());
      const saved = disk().browserProfiles[id];
      if (cycle === 1 && initial === undefined) {
        expect(Number.isInteger(saved.createdAt)).toBe(true);
        expect(saved.createdAt).toBeGreaterThanOrEqual(restoreLower);
        expect(saved.createdAt).toBeLessThanOrEqual(restoreUpper);
        expectedCreatedAt = saved.createdAt;
      }
      expectedMeta = { ...original, dirId: id, createdAt: expectedCreatedAt };
      expect(saved).toEqual(expectedMeta);
      expect(fs.readFileSync(sourceFile(id))).toEqual(bytes);
      expect(fs.existsSync(path.join(USERDATA, "trash", "profiles", id))).toBe(false);
      expect(index().some((entry: any) => entry.dirId === id)).toBe(false);
      expect(await main("reload", id)).toMatchObject({ name: original.name, fingerprintSeed: original.fingerprintSeed });
      const readback = await createdAtReadback(id);
      expect(readback.meta).toEqual(expectedMeta);
      expect(readback.profiles).toHaveLength(1);
      expect(readback.profiles[0]).toMatchObject({ dirId: id, name: original.name, createdAt: expectedCreatedAt });
      expect((await handle.page.evaluate((id) => (window as any).agentBrowser.api.profile.get(id), id)).dirId).toBe(id);
      const listed = await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
      expect(listed.filter((p: any) => p.dirId === id)).toMatchObject([{ dirId: id, name: original.name }]);
      expect(Object.fromEntries(Object.entries(disk().browserProfiles).filter(([key]) => key !== id))).toEqual(unrelated);
      await expect.poll(() => card.count()).toBe(1);
      if (cycle === 2) await handle.page.locator('#dlg-trash [data-cmd="close-dialog"]').click();
      fs.writeFileSync(screenshot(`f09-createdat-${label}-${cycle}.json`), JSON.stringify({
        id, cycle, diskMeta: saved, reloadedMeta: readback.meta, exportedProfiles: readback.profiles,
        index: index(), listedIds: listed.map((p: any) => p.dirId),
        sentinelSha256: createHash("sha256").update(fs.readFileSync(sourceFile(id))).digest("hex"),
      }, null, 2));
      await handle.page.screenshot({ path: screenshot(`f09-createdat-${label}-${cycle}.png`) });
    }

    // Retire this verified fixture via the same visible actions, keeping later
    // existing cases inside the genuine trial cap without direct operation IPC.
    await card.locator(".card-menu summary").click();
    await card.locator('[data-action="delete"]').click();
    await handle.page.locator('#dlg-confirm button[type="submit"]').click();
    await expect.poll(() => card.count()).toBe(0);
    expect(fs.readFileSync(trashFile(id))).toEqual(bytes);
    expect(index().find((entry: any) => entry.dirId === id).meta).toEqual(expectedMeta);
    await openTrashFromHeader();
    await handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`).click();
    await handle.page.locator('#dlg-confirm button[type="submit"]').click();
    await expect.poll(() => index().some((entry: any) => entry.dirId === id)).toBe(false);
    expect(fs.existsSync(path.join(USERDATA, "profiles", id))).toBe(false);
    expect(fs.existsSync(path.join(USERDATA, "trash", "profiles", id))).toBe(false);
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
    expect(await main("reload", id)).toBeNull();
    expect(await createdAtReadback(id)).toEqual({ meta: null, profiles: [] });
    expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((p: any) => p.dirId === id)).toBe(false);
    await handle.page.locator('#dlg-trash [data-cmd="close-dialog"]').click();
  }, 90_000);

  it("shows malformed index error in the actual Trash dialog, not an empty state", async () => {
    const id = await create("F09 corruption synthetic");
    fs.writeFileSync(sourceFile(id), "F09-intact-during-corruption");
    const beforeConfig = fs.readFileSync(CONFIG);
    fs.writeFileSync(INDEX, "{F09 malformed index");
    const response = await ipc("trashList");
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/JSON|Unexpected|property|position/i);
    expect(await ipc("trash", id)).toMatchObject({ success: false });
    await handle.page.evaluate(() => (window as any).agentBrowser.showTrash());
    const content = handle.page.locator("#trash-list");
    await expect.poll(() => content.innerText()).toMatch(/JSON|Unexpected|property|position/i);
    expect(await content.innerText()).not.toMatch(/Trash is empty|回收站是空的/);
    expect(fs.readFileSync(CONFIG)).toEqual(beforeConfig);
    expect(fs.readFileSync(INDEX, "utf8")).toBe("{F09 malformed index");
    expect(fs.readFileSync(sourceFile(id), "utf8")).toBe("F09-intact-during-corruption");
    await main("reload", id);
    expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((p: any) => p.dirId === id)).toBe(true);
    await handle.page.locator("#dlg-trash").screenshot({ path: SCREENSHOT });
    // The screenshot is read visually after the test rather than trusting DOM assertions alone.
    fs.writeFileSync(INDEX, "[]");
  }, 60_000);

  it("survives restart without sweeping the only recovery copy of an expired config conflict", async () => {
    const id = await create("F09 failed-compensation synthetic");
    fs.writeFileSync(sourceFile(id), "F09-only-recovery-copy");
    expect(await ipc("trash", id)).toMatchObject({ success: true });
    await main("reintroduce", id); // persisted outcome of a failed restore config compensation
    const entries = index();
    entries.find((en: any) => en.dirId === id).deletedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(INDEX, JSON.stringify(entries));
    expect(fs.existsSync(sourceFile(id))).toBe(false);
    expect(fs.readFileSync(trashFile(id), "utf8")).toBe("F09-only-recovery-copy");
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(true);
    await closeApp(handle);
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(true);
    expect(fs.readFileSync(trashFile(id), "utf8")).toBe("F09-only-recovery-copy");
    handle = await setupTestApp({ userDataDir: USERDATA, resetUserData: false, env: { AGENT_BROWSER_API_PORT: "0" } });
    const env = await handle.app.evaluate(({ app }) => ({
      home: process.env.HOME, nodeHome: process.getBuiltinModule("node:os").homedir(),
      userData: app.getPath("userData"), providers: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(env.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(env.home!)).toBe(fs.realpathSync(env.nodeHome));
    expect(fs.realpathSync(env.userData)).toBe(fs.realpathSync(USERDATA));
    expect(env.providers).toEqual([]);
    expect((await handle.page.evaluate(() => (window as any).agentBrowserAPI.agent.detectLlmConfig()))?.hasApiKey ?? false).toBe(false);
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(true);
    expect(index().some((en: any) => en.dirId === id)).toBe(true);
    expect(fs.existsSync(sourceFile(id))).toBe(false);
    expect(fs.readFileSync(trashFile(id), "utf8")).toBe("F09-only-recovery-copy");
    expect(await main("reload", id)).not.toBeNull();
    const response = await ipc("trashList");
    expect(response).toMatchObject({ success: false, entries: [{ dirId: id, recoverable: false, recoveryRequired: true }] });
    expect(response.error).toMatch(/recovery required/i);
    await handle.page.evaluate(() => (window as any).agentBrowser.showTrash());
    const content = handle.page.locator("#trash-list");
    await expect.poll(() => content.innerText()).toMatch(/recovery required/i);
    expect(await content.innerText()).toContain("F09 failed-compensation synthetic");
    expect(await content.locator("[data-trash-purge]").count()).toBe(0);
    expect(await ipc("trashPurge", id)).toMatchObject({ success: false });
    expect(fs.readFileSync(trashFile(id), "utf8")).toBe("F09-only-recovery-copy");
    await handle.page.locator("#dlg-trash").screenshot({ path: RECOVERY_SCREENSHOT });
    await main("drop", id);
    expect(await ipc("trashRestore", id)).toMatchObject({ success: true });
    expect(fs.readFileSync(sourceFile(id), "utf8")).toBe("F09-only-recovery-copy");
    expect(index()).toEqual([]);
    expect(await main("reload", id)).not.toBeNull();
  }, 90_000);

  it("never presents a partly deleted directory as a complete restore", async () => {
    const id = await create("F09 incomplete synthetic");
    fs.writeFileSync(sourceFile(id), "F09-to-be-lost");
    expect(await ipc("trash", id)).toMatchObject({ success: true });
    fs.writeFileSync(path.join(path.dirname(trashFile(id)), "survivor.txt"), "F09-survivor");
    fs.rmSync(trashFile(id)); // synthetic state after a partial recursive rm
    const entries = index();
    entries.find((en: any) => en.dirId === id).deletionAttempted = true;
    fs.writeFileSync(INDEX, JSON.stringify(entries));
    expect(await ipc("trashList")).toMatchObject({ success: true, entries: [{ dirId: id, incomplete: true, recoverable: false }] });
    await handle.page.evaluate(() => (window as any).agentBrowser.showTrash());
    const content = handle.page.locator("#trash-list");
    await expect.poll(() => content.innerText()).toMatch(/incomplete|partial|不完整/i);
    expect(await content.locator("[data-trash-restore]").count()).toBe(0);
    await handle.page.locator("#dlg-trash").screenshot({ path: INCOMPLETE_SCREENSHOT });
    const rejected = await ipc("trashRestore", id);
    expect(rejected.success).toBe(false);
    expect(rejected.error).toMatch(/incomplete/i);
    expect(fs.readFileSync(path.join(path.dirname(trashFile(id)), "survivor.txt"), "utf8")).toBe("F09-survivor");
    expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
    expect(await main("reload", id)).toBeNull();
    expect(await ipc("trashPurge", id)).toMatchObject({ success: true });
    expect(index()).toEqual([]);
    expect(fs.existsSync(path.dirname(trashFile(id)))).toBe(false);
  }, 60_000);

  it("keeps viewer RBAC and another-device profile locks on trash operations", async () => {
    const id = await create("F09 protected synthetic");
    fs.writeFileSync(sourceFile(id), "F09-protected-sentinel");
    await main("lock", id);
    const locked = await ipc("trash", id);
    expect(locked.success).toBe(false);
    expect(locked.error).toMatch(/locked/i);
    expect(fs.readFileSync(sourceFile(id), "utf8")).toBe("F09-protected-sentinel");
    expect(disk().browserProfiles[id]).toBeDefined();
    await main("role", "viewer");
    expect((await ipc("trash", id)).success).toBe(false);
    expect((await ipc("trashRestore", id)).success).toBe(false);
    expect((await ipc("trashPurge", id)).success).toBe(false);
    expect(fs.readFileSync(sourceFile(id), "utf8")).toBe("F09-protected-sentinel");
    expect(disk().browserProfiles[id]).toBeDefined();
    expect(index()).toEqual([]);
    await main("role", "owner");
  }, 45_000);

  it("shows failed batch IDs and original errors, retaining only failed selections", async () => {
    const collisionId = await create("F09 batch conflict synthetic");
    const movedId = await create("F09 batch success synthetic");
    fs.writeFileSync(sourceFile(collisionId), "F09-live-batch-sentinel");
    fs.writeFileSync(sourceFile(movedId), "F09-moved-batch-sentinel");
    fs.mkdirSync(path.dirname(trashFile(collisionId)), { recursive: true });
    fs.writeFileSync(trashFile(collisionId), "F09-prior-copy-sentinel");
    const beforeIndex = fs.existsSync(INDEX) ? index() : [];
    const beforeConfig = disk();
    await handle.page.locator("#dlg-trash").evaluate((dlg: HTMLDialogElement) => { if (dlg.open) dlg.close(); });
    await handle.page.evaluate(() => (window as any).i18n.set("en-US"));
    await handle.page.evaluate(() => (window as any).agentBrowser.clearProfileFilters());
    await handle.page.locator("#nav-profiles").click();
    for (const id of [collisionId, movedId]) {
      await handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"] .profile-select-checkbox`).check();
    }
    expect(await handle.page.locator("#profile-selected-count").innerText()).toBe("2");
    await handle.page.evaluate(() => (window as any).agentBrowser.batchDeleteSelected());
    await handle.page.locator('#dlg-confirm button[type="submit"]').click();
    const errorToast = handle.page.locator(".toast-stack .toast-error").last();
    await expect.poll(async () => (await errorToast.locator(".toast-detail").count())
      ? errorToast.locator(".toast-detail").innerText() : "").toContain(collisionId);
    expect(await errorToast.locator(".toast-detail").innerText()).toMatch(/trashed copy.*already exists/i);
    expect(await errorToast.locator(".toast-msg").innerText()).toMatch(/1\/2.*1 failed/);
    expect(await handle.page.locator("#profile-selected-count").innerText()).toBe("1");
    expect(await handle.page.locator(`#profile-list .profile-card[data-dir-id="${collisionId}"] .profile-select-checkbox`).isChecked()).toBe(true);
    expect(await handle.page.locator(`#profile-list .profile-card[data-dir-id="${movedId}"]`).count()).toBe(0);
    expect(fs.readFileSync(sourceFile(collisionId), "utf8")).toBe("F09-live-batch-sentinel");
    expect(fs.readFileSync(trashFile(collisionId), "utf8")).toBe("F09-prior-copy-sentinel");
    expect(fs.existsSync(sourceFile(movedId))).toBe(false);
    expect(fs.readFileSync(trashFile(movedId), "utf8")).toBe("F09-moved-batch-sentinel");
    expect(disk().browserProfiles[collisionId]).toEqual(beforeConfig.browserProfiles[collisionId]);
    expect(Object.hasOwn(disk().browserProfiles, movedId)).toBe(false);
    expect(index()).toEqual([...beforeIndex, expect.objectContaining({ dirId: movedId })]);
    expect(await main("reload", collisionId)).toMatchObject({ name: "F09 batch conflict synthetic" });
    expect(await main("reload", movedId)).toBeNull();
    const listed = await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    expect(listed.some((p: any) => p.dirId === collisionId)).toBe(true);
    expect(listed.some((p: any) => p.dirId === movedId)).toBe(false);
    await errorToast.screenshot({ path: BATCH_ERROR_SCREENSHOT });
  }, 60_000);

  it("shows all recovery paths from both failed IPC responses and rejected Undo calls", async () => {
    const returnedId = await create("F09 undo returned-error synthetic");
    const rejectedId = await create("F09 undo rejected-error synthetic");
    const ids = [returnedId, rejectedId];
    ids.forEach((id) => fs.writeFileSync(sourceFile(id), `F09-undo-${id}-sentinel`));
    await handle.page.locator("#dlg-trash").evaluate((dlg: HTMLDialogElement) => { if (dlg.open) dlg.close(); });
    await handle.page.evaluate(() => (window as any).i18n.set("en-US"));
    await handle.page.evaluate(() => (window as any).agentBrowser.clearProfileFilters());
    for (const id of ids) await handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"] .profile-select-checkbox`).check();
    await handle.page.evaluate(() => (window as any).agentBrowser.batchDeleteSelected());
    await handle.page.locator('#dlg-confirm button[type="submit"]').click();
    const successToast = handle.page.locator(".toast-stack .toast-success").last();
    await expect.poll(() => successToast.locator(".toast-action").count()).toBe(1);
    for (const id of ids) {
      expect(fs.readFileSync(trashFile(id), "utf8")).toBe(`F09-undo-${id}-sentinel`);
      expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
      expect(index().some((entry: any) => entry.dirId === id)).toBe(true);
    }
    // Controlled renderer-only responses exercise both Undo branches; these
    // are not actual physical disk faults or failed backend compensation.
    const recovery = (id: string) => `Recovery required: directory compensation failed; Remaining paths: ${sourceFile(id)}, ${trashFile(id)}; disk config ${CONFIG}: profile absent`;
    await handle.page.evaluate(({ returnedId, rejectedId, returnedError, rejectedError }) => {
      const ipc = (window as any).agentBrowser.ipc;
      (window as any).__f09Call = ipc.call;
      ipc.call = function (key: string, fn: Function, opts: any) {
        if (key === `profile.trash-restore:${returnedId}`) return Promise.resolve({ success: false, error: returnedError });
        if (key === `profile.trash-restore:${rejectedId}`) return Promise.reject(new Error(rejectedError));
        return (window as any).__f09Call.call(this, key, fn, opts);
      };
    }, { returnedId, rejectedId, returnedError: recovery(returnedId), rejectedError: recovery(rejectedId) });
    try {
      await successToast.locator(".toast-action").click();
      const errorToast = handle.page.locator(".toast-stack .toast-error").last();
      await expect.poll(async () => (await errorToast.locator(".toast-detail").count())
        ? errorToast.locator(".toast-detail").innerText() : "").toContain(recovery(rejectedId));
      const detail = await errorToast.locator(".toast-detail").innerText();
      expect(detail).toContain(recovery(returnedId));
      expect(detail).toContain(`\n${rejectedId}: `);
      expect(await errorToast.locator(".toast-msg").innerText()).toMatch(/2 could not be restored/);
      await errorToast.screenshot({ path: UNDO_ERROR_SCREENSHOT });
      const scroll = await errorToast.locator(".toast-detail").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return { top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight };
      });
      expect(scroll.top).toBeGreaterThan(0);
      expect(scroll.top).toBe(scroll.bottom);
      await errorToast.screenshot({ path: UNDO_ERROR_BOTTOM_SCREENSHOT });
    } finally {
      await handle.page.evaluate(() => {
        const ipc = (window as any).agentBrowser.ipc;
        ipc.call = (window as any).__f09Call;
        delete (window as any).__f09Call;
      });
    }
    for (const id of ids) {
      expect(fs.existsSync(sourceFile(id))).toBe(false);
      expect(fs.readFileSync(trashFile(id), "utf8")).toBe(`F09-undo-${id}-sentinel`);
      expect(Object.hasOwn(disk().browserProfiles, id)).toBe(false);
      expect(index().some((entry: any) => entry.dirId === id)).toBe(true);
      expect(await main("reload", id)).toBeNull();
      expect((await ipc("trashList")).entries.some((entry: any) => entry.dirId === id)).toBe(true);
      expect(await ipc("trashRestore", id)).toMatchObject({ success: true });
      expect(fs.readFileSync(sourceFile(id), "utf8")).toBe(`F09-undo-${id}-sentinel`);
      expect(fs.existsSync(trashFile(id))).toBe(false);
      expect(index().some((entry: any) => entry.dirId === id)).toBe(false);
      expect(disk().browserProfiles[id]).toBeDefined();
      expect(await main("reload", id)).toMatchObject({ name: id === returnedId ? "F09 undo returned-error synthetic" : "F09 undo rejected-error synthetic" });
      expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((p: any) => p.dirId === id)).toBe(true);
    }
  }, 60_000);

  it("shows full EACCES and long recovery details on single-card delete refusal and rejection", async () => {
    const returnedId = await create("F09 single trash returned-error synthetic");
    const rejectedId = await create("F09 single trash rejected-error synthetic");
    const ids = [returnedId, rejectedId];
    ids.forEach((id) => fs.writeFileSync(sourceFile(id), `F09-single-live-${id}`));
    await handle.page.locator("#dlg-trash").evaluate((dlg: HTMLDialogElement) => { if (dlg.open) dlg.close(); });
    await handle.page.evaluate(() => (window as any).i18n.set("en-US"));
    await handle.page.evaluate(() => (window as any).agentBrowser.clearProfileFilters());
    await handle.page.locator("#nav-profiles").click();
    const configBefore = fs.readFileSync(CONFIG);
    const indexBefore = fs.readFileSync(INDEX);
    await injectSingleErrors("trash", returnedId, rejectedId);
    try {
      for (const id of ids) {
        const card = handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);
        await card.locator(".profile-select-checkbox").check();
        await card.locator(".card-menu summary").click();
        await card.locator('[data-action="delete"]').click();
        expect(await card.getAttribute("aria-busy")).toBe("true");
        await handle.page.locator('#dlg-confirm button[type="submit"]').click();
        await expectSingleBusy("trash", id);
        await releaseSingleError("trash", id);
        await expectForegroundDetail(id, singleError("trash", id), false);
        await expect.poll(() => card.getAttribute("aria-busy")).toBe("false");
        expect(await card.locator(".profile-select-checkbox").isChecked()).toBe(true);
        expect(fs.readFileSync(sourceFile(id), "utf8")).toBe(`F09-single-live-${id}`);
        expect(fs.existsSync(trashFile(id))).toBe(false);
        expect(disk().browserProfiles[id]).toBeDefined();
        await captureSingleDetail("trash", id === returnedId ? "refusal" : "rejection");
      }
      await expectNoFailureRefresh();
    } finally { await restoreSingleCalls(); }
    expect(fs.readFileSync(CONFIG)).toEqual(configBefore);
    expect(fs.readFileSync(INDEX)).toEqual(indexBefore);
    for (const id of ids) {
      expect(await main("reload", id)).not.toBeNull();
      expect((await ipc("trashList")).entries.some((entry: any) => entry.dirId === id)).toBe(false);
      const card = handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);
      await card.locator(".card-menu summary").click();
      await card.locator('[data-action="delete"]').click();
      await handle.page.locator('#dlg-confirm button[type="submit"]').click();
      await expect.poll(() => card.count()).toBe(0); // Successful retry refreshes the real profile list.
      expect(fs.readFileSync(trashFile(id), "utf8")).toBe(`F09-single-live-${id}`);
      expect(fs.existsSync(sourceFile(id))).toBe(false);
      expect(disk().browserProfiles[id]).toBeUndefined();
      expect(index().some((entry: any) => entry.dirId === id)).toBe(true);
      expect(await main("reload", id)).toBeNull();
      const undo = handle.page.locator(".toast-stack .toast-success").last().locator(".toast-action");
      await undo.click(); // The single-card success path still offers a real Undo.
      await expect.poll(() => fs.existsSync(sourceFile(id))).toBe(true);
      expect(fs.readFileSync(sourceFile(id), "utf8")).toBe(`F09-single-live-${id}`);
      await expect.poll(() => index().some((entry: any) => entry.dirId === id)).toBe(false);
      expect(disk().browserProfiles[id]).toBeDefined();
      expect(await main("reload", id)).not.toBeNull();
      expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((entry: any) => entry.dirId === id)).toBe(true);
      await expect.poll(() => card.count()).toBe(1);
    }
    await retireVerifiedProfiles(ids);
  }, 90_000);

  it("shows full restore errors inside the open Trash modal and keeps recoverable entries", async () => {
    const returnedId = await create("F09 single restore returned-error synthetic");
    const rejectedId = await create("F09 single restore rejected-error synthetic");
    const ids = [returnedId, rejectedId];
    ids.forEach((id) => fs.writeFileSync(sourceFile(id), `F09-single-restore-${id}`));
    for (const id of ids) expect(await ipc("trash", id)).toMatchObject({ success: true });
    await handle.page.evaluate(() => (window as any).i18n.set("en-US"));
    await openTrashFromHeader();
    const configBefore = fs.readFileSync(CONFIG);
    const indexBefore = fs.readFileSync(INDEX);
    await injectSingleErrors("trash-restore", returnedId, rejectedId);
    try {
      for (const id of ids) {
        await handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).click();
        await expectSingleBusy("trash-restore", id);
        await releaseSingleError("trash-restore", id);
        await expectForegroundDetail(id, singleError("restore", id), true);
        expect(await handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).isEnabled()).toBe(true);
        expect(fs.readFileSync(trashFile(id), "utf8")).toBe(`F09-single-restore-${id}`);
        expect(fs.existsSync(sourceFile(id))).toBe(false);
        expect(disk().browserProfiles[id]).toBeUndefined();
        await captureSingleDetail("restore", id === returnedId ? "refusal" : "rejection");
      }
      await expectNoFailureRefresh();
    } finally { await restoreSingleCalls(); }
    expect(fs.readFileSync(CONFIG)).toEqual(configBefore);
    expect(fs.readFileSync(INDEX)).toEqual(indexBefore);
    for (const id of ids) {
      expect((await ipc("trashList")).entries.some((entry: any) => entry.dirId === id)).toBe(true);
      expect(await main("reload", id)).toBeNull();
      const restore = handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`);
      await restore.click();
      await expect.poll(() => restore.count()).toBe(0);
      expect(await handle.page.locator("#trash-action-error").isVisible()).toBe(false);
      expect(fs.readFileSync(sourceFile(id), "utf8")).toBe(`F09-single-restore-${id}`);
      expect(fs.existsSync(trashFile(id))).toBe(false);
      expect(disk().browserProfiles[id]).toBeDefined();
      expect(index().some((entry: any) => entry.dirId === id)).toBe(false);
      expect(await main("reload", id)).not.toBeNull();
      expect((await handle.page.evaluate((id) => (window as any).agentBrowser.api.profile.get(id), id)).dirId).toBe(id);
      expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((entry: any) => entry.dirId === id)).toBe(true);
      await expect.poll(() => handle.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`).count()).toBe(1);
    }
    await retireVerifiedProfiles(ids);
  }, 90_000);

  it("shows full irreversible-purge errors inside the Trash modal without false removal", async () => {
    const names = [
      "F09 single purge returned-error synthetic — long profile name with recovery evidence " + "LongUnbrokenProfileIdentifier".repeat(3),
      "F09 single purge rejected-error synthetic — long profile name with recovery evidence " + "LongUnbrokenProfileIdentifier".repeat(3),
    ];
    const returnedId = await create(names[0]);
    const rejectedId = await create(names[1]);
    const ids = [returnedId, rejectedId];
    ids.forEach((id) => fs.writeFileSync(sourceFile(id), `F09-single-purge-${id}`));
    for (const id of ids) expect(await ipc("trash", id)).toMatchObject({ success: true });
    await handle.page.evaluate(() => (window as any).i18n.set("en-US"));
    await openTrashFromHeader();
    const configBefore = fs.readFileSync(CONFIG);
    const indexBefore = fs.readFileSync(INDEX);
    await injectSingleErrors("trash-purge", returnedId, rejectedId);
    try {
      for (const id of ids) {
        await handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`).click();
        expect(await handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).isDisabled()).toBe(true);
        await handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`).dispatchEvent("click");
        await handle.page.locator('#dlg-confirm button[type="submit"]').click();
        await expectSingleBusy("trash-purge", id);
        await releaseSingleError("trash-purge", id);
        await expectForegroundDetail(id, singleError("purge", id), true);
        expect(await handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).isDisabled()).toBe(true);
        expect(await handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`).isEnabled()).toBe(true);
        await handle.page.locator(`#dlg-trash [data-trash-restore="${id}"]`).dispatchEvent("click");
        expect(await handle.page.locator("#dlg-confirm").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(false);
        expect(fs.readFileSync(trashFile(id), "utf8")).toBe(`F09-single-purge-${id}`);
        expect(fs.existsSync(sourceFile(id))).toBe(false);
        expect(disk().browserProfiles[id]).toBeUndefined();
        await captureSingleDetail("purge", id === returnedId ? "refusal" : "rejection");
        await expectTrashRowGeometry(names[ids.indexOf(id)],
          "Data may be incomplete after a purge attempt; do not restore as complete.",
          `f09-layout-failed-purge-${id === returnedId ? "refusal" : "rejection"}`);
      }
      await withNarrowTrashWindow(async () => {
        for (const [i, name] of names.entries()) await expectTrashRowGeometry(name,
          "Data may be incomplete after a purge attempt; do not restore as complete.",
          `f09-layout-failed-purge-${i === 0 ? "refusal" : "rejection"}-narrow`);
      });
      await expectNoFailureRefresh();
    } finally { await restoreSingleCalls(); }
    expect(fs.readFileSync(CONFIG)).toEqual(configBefore);
    expect(fs.readFileSync(INDEX)).toEqual(indexBefore);
    for (const id of ids) {
      expect((await ipc("trashList")).entries.some((entry: any) => entry.dirId === id)).toBe(true);
      expect(await main("reload", id)).toBeNull();
      const purge = handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`);
      await purge.click();
      expect(await handle.page.locator("#dlg-confirm").evaluate((dlg: HTMLDialogElement) => dlg.open)).toBe(true);
      expect(fs.readFileSync(trashFile(id), "utf8")).toBe(`F09-single-purge-${id}`); // Retry still requires confirmation.
      await handle.page.locator('#dlg-confirm button[type="submit"]').click();
      await expect.poll(() => purge.count()).toBe(0);
      expect(await handle.page.locator("#trash-action-error").isVisible()).toBe(false);
      expect(fs.existsSync(trashFile(id))).toBe(false);
      expect(fs.existsSync(sourceFile(id))).toBe(false);
      expect(disk().browserProfiles[id]).toBeUndefined();
      expect(index().some((entry: any) => entry.dirId === id)).toBe(false);
      expect(await main("reload", id)).toBeNull();
      expect((await ipc("trashList")).entries.some((entry: any) => entry.dirId === id)).toBe(false);
      expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list())).some((entry: any) => entry.dirId === id)).toBe(false);
    }
  }, 90_000);

  it("keeps long names, safety warnings and actions separate in every trash state at normal and narrow widths", async () => {
    // Presentation fixtures only: no added license slots and no shared storage
    // changes. The existing cases above prove the real IPC/disk state matrix.
    const entries = [
      { dirId: "f09_layout_recoverable", recoverable: true },
      { dirId: "f09_layout_recovery_required", recoverable: false, recoveryRequired: true },
      { dirId: "f09_layout_incomplete", recoverable: false, incomplete: true },
      { dirId: "f09_layout_missing", recoverable: false },
    ].map((entry) => ({ ...entry, deletedAt: Date.now(), name: `${entry.dirId} — long synthetic profile name ` + "LongUnbrokenProfileIdentifier".repeat(4) }));
    const configBefore = fs.readFileSync(CONFIG), indexBefore = fs.readFileSync(INDEX);
    await handle.page.evaluate((entries) => {
      const ipc = (window as any).agentBrowser.ipc;
      (window as any).__f09LayoutOriginalCall = ipc.call;
      ipc.call = function (key: string, fn: Function, opts: any) {
        return key === "profile.trash-list" ? Promise.resolve({ success: true, entries })
          : (window as any).__f09LayoutOriginalCall.call(this, key, fn, opts);
      };
      (window as any).i18n.set("en-US");
    }, entries);
    try {
      await openTrashFromHeader();
      await expect.poll(() => handle.page.locator('#dlg-trash [data-trash-restore="f09_layout_recoverable"]').count()).toBe(1);
      expect(await handle.page.locator('#dlg-trash [data-trash-purge="f09_layout_recovery_required"]').count()).toBe(0);
      for (const entry of entries.slice(1)) expect(await handle.page.locator(`#dlg-trash [data-trash-restore="${entry.dirId}"]`).count()).toBe(0);
      for (const id of ["f09_layout_recoverable", "f09_layout_incomplete", "f09_layout_missing"]) {
        expect(await handle.page.locator(`#dlg-trash [data-trash-purge="${id}"]`).isEnabled()).toBe(true);
      }
      const warnings = [null,
        "Recovery required — a live profile still uses this ID; resolve the conflict before deleting.",
        "Data may be incomplete after a purge attempt; do not restore as complete.", "data missing"];
      const check = async (suffix: string) => {
        for (const [i, entry] of entries.entries()) await expectTrashRowGeometry(entry.name, warnings[i], `f09-layout-state-${i}-${suffix}`);
      };
      await check("normal");
      await withNarrowTrashWindow(() => check("narrow"));
    } finally {
      await handle.page.evaluate(() => {
        (window as any).agentBrowser.ipc.call = (window as any).__f09LayoutOriginalCall;
        delete (window as any).__f09LayoutOriginalCall;
      });
    }
    expect(fs.readFileSync(CONFIG)).toEqual(configBefore);
    expect(fs.readFileSync(INDEX)).toEqual(indexBefore);
  }, 60_000);
});
