// Profile menu RED: native summary activation and foreground geometry in real
// Electron. Never launch a profile browser; use only this mkdtemp-owned trial.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { setupTestApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-profile-menu-e2e-"));
const evidenceRoot = process.env.AGENT_BROWSER_MENU_EVIDENCE_ROOT;
if (evidenceRoot) fs.mkdirSync(evidenceRoot, { recursive: true });
const EVIDENCE = evidenceRoot
  ? fs.mkdtempSync(path.join(path.resolve(evidenceRoot), "profile-menu-"))
  : path.join(USERDATA, "evidence");
const CONFIG = path.join(USERDATA, "config.json");
const INDEX = path.join(USERDATA, "trash", "index.json");
const disk = () => JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const indexBytes = () => fs.existsSync(INDEX) ? fs.readFileSync(INDEX) : null;
const sentinel = (id: string) => path.join(USERDATA, "profiles", id, "Default", "menu-sentinel.txt");
let handle: TestAppHandle;
let requestedWindow: { width: number; height: number; zoom: number };
let traceSelector: string | null = null;
let traceNumber = 0;
const fixtures: Array<{ id: string; name: string; webApp: boolean }> = [];

// Read-only observations of this owned app, not focus/navigation repair. Keep
// bounded per-test events so a failed activation still leaves its first cause.
async function installActivationTrace() {
  await handle.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("index.html"))!;
    (globalThis as any).__menuNativeTrace = { events: [], dropped: 0 };
    const record = (type: string, extra: object = {}) => {
      const trace = (globalThis as any).__menuNativeTrace;
      if (trace.events.length >= 1000) { trace.dropped++; return; }
      trace.events.push({ at: Date.now(), type, bounds: win.getBounds(), content: win.getContentBounds(),
        zoom: win.webContents.getZoomFactor(), focused: win.isFocused(), ...extra });
    };
    for (const event of ["resize", "resized", "move", "moved", "focus", "blur", "enter-full-screen", "leave-full-screen"]) {
      win.on(event as any, () => record(event));
    }
    win.on("will-resize", (_event, bounds) => record("will-resize", { requested: bounds }));
    win.webContents.on("before-mouse-event", (_event, input) => {
      if (input.type !== "mouseMove") record("mouse", { input: { type: input.type, x: input.x, y: input.y, button: input.button } });
    });
  });
  await handle.page.evaluate(() => {
    (window as any).__menuRendererTrace = { events: [], dropped: 0 };
    const describe = (el: Element | null) => el ? { tag: el.tagName, id: el.id,
      action: el.getAttribute("data-action"), cmd: el.getAttribute("data-cmd"),
      profile: el.closest(".profile-card")?.getAttribute("data-dir-id"),
      proxy: el.closest(".profile-card")?.getAttribute("data-proxy-name") } : null;
    const record = (event: Event) => {
      const trace = (window as any).__menuRendererTrace;
      if (trace.events.length >= 1000) { trace.dropped++; return; }
      const target = event.target instanceof Element ? event.target : null;
      trace.events.push({ at: Date.now(), type: event.type, target: describe(target), focus: describe(document.activeElement),
        tab: (window as any).agentBrowser.state.currentTab, viewport: { width: innerWidth, height: innerHeight },
        contentScroll: document.querySelector("#content")?.scrollTop,
        key: event instanceof KeyboardEvent ? event.key : null,
        point: event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : null,
        dialogs: Array.from(document.querySelectorAll("dialog[open]")).map(d => d.id) });
    };
    for (const event of ["pointerdown", "click", "keydown", "focusin", "scroll", "cancel", "close", "toggle"]) {
      document.addEventListener(event, record, true);
    }
    window.addEventListener("resize", record);
  });
}

async function captureActivationState(name: string, selector: string | null = traceSelector) {
  traceSelector = selector;
  const renderer = await handle.page.evaluate(selector => {
    const summary = selector ? document.querySelector(selector + " > summary") : null;
    const chain = [];
    for (let el: Element | null = summary; el; el = el.parentElement) {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      chain.push({ tag: el.tagName, id: el.id, classes: el.getAttribute("class"), hidden: (el as HTMLElement).hidden,
        inert: (el as HTMLElement).inert, ariaHidden: el.getAttribute("aria-hidden"), display: style.display,
        visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    }
    return { tab: (window as any).agentBrowser.state.currentTab, chain,
      viewport: { width: innerWidth, height: innerHeight }, focus: { id: document.activeElement?.id,
        tag: document.activeElement?.tagName, cmd: document.activeElement?.getAttribute("data-cmd") },
      dialogs: Array.from(document.querySelectorAll("dialog")).map(d => ({ id: d.id, open: d.open,
        returnFocus: (d as any)._returnFocus?.getAttribute("data-action") || null,
        hasReturnFocus: !!(d as any)._returnFocus })), trace: (window as any).__menuRendererTrace };
  }, selector);
  const native = await handle.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("index.html"))!;
    return { outer: win.getBounds(), content: win.getContentBounds(), zoom: win.webContents.getZoomFactor(),
      focused: win.isFocused(), trace: (globalThis as any).__menuNativeTrace };
  });
  fs.writeFileSync(path.join(EVIDENCE, `${name}-activation-state.json`), JSON.stringify({
    requested: requestedWindow, selector, renderer, native }, null, 2));
  return { renderer, native };
}

async function assertRequestedWindow(name: string, selector: string | null = traceSelector) {
  const state = await captureActivationState(name, selector);
  expect(state.native.outer.width, `${name}: actual outer width`).toBe(requestedWindow.width);
  expect(state.native.outer.height, `${name}: actual outer height`).toBe(requestedWindow.height);
  expect(state.native.zoom, `${name}: actual zoom`).toBe(requestedWindow.zoom);
  expect(state.renderer.viewport.width).toBeCloseTo(state.native.content.width / requestedWindow.zoom, 0);
}

async function waitForDialogClose(selector: string) {
  await expect.poll(() => handle.page.locator(selector).evaluate((d: any) => !d.open && !d._returnFocus)).toBe(true);
}

// Keep this function self-contained: Playwright serializes it into the actual
// renderer. Sample edge midpoints, not rounded corners outside button paint.
function measureMenu(id: string) {
  const card = document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`)!;
  const details = card.querySelector(".card-menu") as HTMLDetailsElement;
  const trigger = details.querySelector("summary")!;
  const menu = details.querySelector(".card-menu-list") as HTMLElement;
  const del = menu.querySelector('[data-action="delete"]') as HTMLButtonElement;
  const content = document.querySelector("#content")!;
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const desc = (el: Element | null) => el ? {
    tag: el.tagName, id: el.id, classes: el.getAttribute("class"), action: el.getAttribute("data-action"),
    profileId: el.closest(".profile-card")?.getAttribute("data-dir-id"), text: (el.textContent || "").trim().slice(0, 120),
  } : null;
  const hit = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    return { x, y, hit: desc(el), deleteHit: !!el && (el === del || del.contains(el)) };
  };
  const r = box(del);
  const ancestors = [];
  for (let el: Element | null = menu; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    ancestors.push({ ...desc(el), rect: box(el), overflowX: s.overflowX, overflowY: s.overflowY,
      transform: s.transform, zIndex: s.zIndex, position: s.position, display: s.display, visibility: s.visibility,
      pointerEvents: s.pointerEvents, opacity: s.opacity, contain: s.contain, clipPath: s.clipPath,
      clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight, scrollTop: el.scrollTop });
  }
  return {
    id, webApp: !!card.querySelector('[data-action="open-app"]'), open: details.open,
    busy: card.getAttribute("aria-busy"), disabled: del.disabled,
    popover: menu.getAttribute("popover"), popoverOpen: menu.matches(":popover-open"),
    card: box(card), trigger: box(trigger), menu: box(menu), delete: r, content: box(content),
    viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    visualViewport: visualViewport ? { width: visualViewport.width, height: visualViewport.height,
      scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop } : null,
    scroll: { top: content.scrollTop, left: content.scrollLeft, width: content.clientWidth, scrollWidth: content.scrollWidth,
      height: content.clientHeight, scrollHeight: content.scrollHeight, rootTop: document.scrollingElement?.scrollTop || 0,
      rootLeft: document.scrollingElement?.scrollLeft || 0, documentWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth },
    menuScroll: { top: menu.scrollTop, height: menu.clientHeight, scrollHeight: menu.scrollHeight },
    hits: [hit(r.left + r.width / 2, r.top + r.height / 2), hit(r.left + 2, r.top + r.height / 2),
      hit(r.right - 2, r.top + r.height / 2), hit(r.left + r.width / 2, r.top + 2), hit(r.left + r.width / 2, r.bottom - 2)],
    owner: del.closest(".profile-card")?.getAttribute("data-dir-id"), containerContains: document.querySelector("#profile-list")!.contains(del),
    overlappingCards: Array.from(document.querySelectorAll("#profile-list .profile-card")).filter(el => el !== card)
      .map(el => ({ id: el.getAttribute("data-dir-id"), rect: box(el) }))
      .filter(({ rect: b }) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top), ancestors,
    // Diagnostic-only: distinguish a pre-existing narrow native-select/toolbar
    // overflow from a popover adding horizontal scroll. Never repair either.
    overflowingElements: Array.from(content.querySelectorAll("*"))
      .filter(el=>el.getClientRects().length>0&&!el.closest(".card-menu-list[popover]"))
      .map(el=>({ ...desc(el),rect:box(el),clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,
        minWidth:getComputedStyle(el).minWidth,width:getComputedStyle(el).width,
        whiteSpace:getComputedStyle(el).whiteSpace,overflowX:getComputedStyle(el).overflowX }))
      .filter(el=>el.rect.right>box(content).right+1||el.rect.left<box(content).left-1).slice(0,60),
  };
}
type Geometry = ReturnType<typeof measureMenu>;
type Box = Geometry["menu"];
const inside = (inner: Box, outer: Box) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1
  && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.width > 0 && inner.height > 0;
const cardSelector = (id: string) => `#profile-list .profile-card[data-dir-id="${id}"]`;

async function capture(name: string, id: string): Promise<Geometry> {
  const geometry = await handle.page.evaluate(measureMenu, id);
  const native = await handle.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("index.html"))!;
    return { png: (await win.webContents.capturePage()).toPNG().toString("base64"),
      bounds: win.getContentBounds(), outerBounds: win.getBounds(), zoom: win.webContents.getZoomFactor() };
  });
  // Capture the complete real webContents: locator screenshots misclip native
  // zoom and would auto-scroll the very obstruction this regression detects.
  fs.writeFileSync(path.join(EVIDENCE, `${name}.png`), Buffer.from(native.png, "base64"));
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), JSON.stringify({ ...geometry,
    window: { bounds: native.bounds, outerBounds: native.outerBounds, zoom: native.zoom }, stage: name }, null, 2));
  return geometry;
}

async function resize(width: number, height: number, zoom: number) {
  requestedWindow = { width, height, zoom };
  await captureActivationState(`resize-${++traceNumber}-before`);
  const native = await handle.app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("index.html"))!;
    win.setBounds({ width: size.width, height: size.height }, false);
    win.webContents.setZoomFactor(size.zoom);
    return { outer: win.getBounds(), content: win.getContentBounds(), zoom: win.webContents.getZoomFactor() };
  }, { width, height, zoom });
  expect(native.outer.width).toBe(width); expect(native.outer.height).toBe(height); expect(native.zoom).toBe(zoom);
  await expect.poll(() => handle.page.evaluate(() => innerWidth)).toBeCloseTo(native.content.width / zoom, 0);
  fs.writeFileSync(path.join(EVIDENCE, `outer-window-${width}x${height}-z${zoom}.json`), JSON.stringify(native, null, 2));
  await handle.page.mouse.move(20, 20);
  await handle.page.waitForTimeout(250); // Production hover transform transition.
  await assertRequestedWindow(`resize-${traceNumber}-settled`);
}

async function assertStorageUnchanged(config: Buffer, index: Buffer | null) {
  expect(fs.readFileSync(CONFIG)).toEqual(config);
  expect(indexBytes()).toEqual(index);
  for (const f of fixtures) expect(fs.readFileSync(sentinel(f.id), "utf8")).toBe(`Menu sentinel ${f.id}`);
  expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig())).success).toBe(true);
  const listed = await handle.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
  for (const f of fixtures) {
    expect(disk().browserProfiles[f.id].name).toBe(f.name);
    expect(listed.find((p: any) => p.dirId === f.id)?.name).toBe(f.name);
    expect((await handle.page.evaluate(id => (window as any).agentBrowser.api.profile.get(id), f.id)).name).toBe(f.name);
  }
  const calls = await handle.page.evaluate(() => (window as any).__profileMenuCalls as string[]);
  expect(calls.filter(k => k.startsWith("profile.trash:"))).toEqual([]);
  expect(calls.filter(k => k.startsWith("browser.launch"))).toEqual([]);
}

async function deleteOnlyOpensExpectedConfirmation(id: string, config: Buffer, index: Buffer | null) {
  // Callers have ALREADY captured and proved geometry before this locator is
  // allowed to auto-scroll. Never use force, dispatchEvent, or DOM .click here.
  const card = handle.page.locator(cardSelector(id));
  await card.locator('[data-action="delete"]').click();
  await handle.page.locator("#dlg-confirm").waitFor({ state: "visible" });
  expect(await handle.page.locator("#dlg-confirm").evaluate((d: any) => d._returnFocus?.closest(".profile-card")?.getAttribute("data-dir-id"))).toBe(id);
  expect(await card.getAttribute("aria-busy")).toBe("true");
  for (const other of fixtures.filter(f => f.id !== id)) {
    expect(await handle.page.locator(cardSelector(other.id)).getAttribute("aria-busy")).toBe("false");
  }
  const foreground = await handle.page.locator('#dlg-confirm button[type="submit"]').evaluate(el => {
    const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  expect(foreground).toBe(true);
  await assertStorageUnchanged(config, index); // Before confirmation, no write.
  await handle.page.locator('#dlg-confirm [data-cmd="close-dialog"]').click();
  await expect.poll(() => card.getAttribute("aria-busy")).toBe("false");
  expect(await card.locator(".profile-select-checkbox").isChecked()).toBe(true);
  await assertStorageUnchanged(config, index);
}

// Initial RED matrix; lifecycle/Undo/top-level/proxy cases are extended after
// implementation. At 1100px these normal/Web App pairs occupy each row's left
// and rightmost columns. At 800px/1.5 zoom the same IDs exercise single columns.
const cases = [
  { label: "first-normal", fixture: 0 }, { label: "first-rightmost-webapp", fixture: 1 },
  { label: "middle-normal", fixture: 4 }, { label: "middle-rightmost-webapp", fixture: 5 },
  { label: "last-normal", fixture: 8 }, { label: "last-rightmost-webapp", fixture: 9 },
];

// Shared helpers for the additional acceptance cases. These inspect the real
// panel before an action locator can repair the geometry by auto-scrolling.
async function openProfileMenu(id: string, key?: "Enter" | "Space", centerAnchor = false) {
  await handle.page.evaluate(({id,centerAnchor}) => {
    document.scrollingElement!.scrollTop = 0;
    const card=document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`)!;
    card.scrollIntoView({ block: "center" });
    if(centerAnchor) {
      // Genuine content scroll places the trigger near mid-viewport, where
      // neither side fits the real menu. Do not manufacture panel dimensions.
      const r=card.querySelector(".card-menu > summary")!.getBoundingClientRect();
      document.querySelector("#content")!.scrollTop += r.top+r.height/2-innerHeight/2;
    }
  }, {id,centerAnchor});
  await handle.page.waitForTimeout(80); // Let pre-opening external scroll finish.
  const summary = handle.page.locator(`${cardSelector(id)} .card-menu > summary`);
  await summary.hover();
  await handle.page.waitForTimeout(250);
  if (centerAnchor) {
    // Hover may legitimately scroll the summary; center its settled box last.
    await summary.evaluate(el => {
      const r = el.getBoundingClientRect();
      document.querySelector("#content")!.scrollTop += r.top + r.height / 2 - innerHeight / 2;
    });
    await handle.page.waitForTimeout(120);
  }
  if (key) { await summary.focus(); await handle.page.keyboard.press(key); }
  else if (centerAnchor) {
    const box = await summary.boundingBox();
    if (!box) throw new Error("Centered menu summary has no visible box");
    await handle.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else await summary.click();
  await expect.poll(() => handle.page.locator(`${cardSelector(id)} .card-menu-list`).evaluate(el => el.matches(":popover-open"))).toBe(true);
}

async function noOpenPanels() {
  await expect.poll(() => handle.page.locator(".card-menu-list:popover-open").count()).toBe(0);
  expect(await handle.page.locator(".card-menu[open]").count()).toBe(0);
}

async function captureSurface(name: string, menuSelector: string, actionSelector: string) {
  // Native details toggle is an asynchronous task. Wait only for activation,
  // never scroll an action or adjust its geometry while waiting.
  await expect.poll(()=>handle.page.locator(menuSelector+" .card-menu-list").evaluate(el=>el.matches(":popover-open"))).toBe(true);
  const geometry = await handle.page.evaluate(({ menuSelector, actionSelector }) => {
    const owner = document.querySelector(menuSelector) as HTMLDetailsElement;
    const panel = owner.querySelector(".card-menu-list") as HTMLElement;
    const action = panel.querySelector(actionSelector) as HTMLButtonElement;
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top,
      right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const r = box(action), content = document.querySelector("#content")!, root = document.documentElement;
    return { open: owner.open, popover: panel.matches(":popover-open"), menu: box(panel), action: r,
      pageScroll: { contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth,
        documentWidth: root.clientWidth, documentScrollWidth: root.scrollWidth },
      ownerCard: owner.closest(".profile-card") ? box(owner.closest(".profile-card")!) : null,
      viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight },
      ancestry: { ownerContains: owner.contains(panel), dialog: panel.closest("dialog")?.id || null,
        form: panel.closest("form")?.id || null },
      scroll: { top: panel.scrollTop, height: panel.clientHeight, scrollHeight: panel.scrollHeight },
      hits: [[r.left+r.width/2,r.top+r.height/2],[r.left+2,r.top+r.height/2],[r.right-2,r.top+r.height/2],
        [r.left+r.width/2,r.top+2],[r.left+r.width/2,r.bottom-2]].map(([x,y]) => {
          const hit = document.elementFromPoint(x,y); return { x,y, own: !!hit && (hit===action || action.contains(hit)),
            tag: hit?.tagName, text: hit?.textContent?.slice(0,100) }; }) };
  }, { menuSelector, actionSelector });
  const png = await handle.app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("index.html"))!.webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(EVIDENCE, `${name}.png`), Buffer.from(png,"base64"));
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), JSON.stringify(geometry,null,2));
  expect(geometry.open).toBe(true); expect(geometry.popover).toBe(true);
  expect(geometry.ancestry.ownerContains).toBe(true);
  expect(inside(geometry.menu, geometry.viewport), name).toBe(true);
  expect(inside(geometry.action, geometry.menu), name).toBe(true);
  expect(inside(geometry.action, geometry.viewport), name).toBe(true);
  expect(geometry.hits.every(h => h.own), `${name}: actual center/edges must be foreground`).toBe(true);
  if (menuSelector.startsWith("#proxy-list")) {
    expect(geometry.pageScroll.contentScrollWidth, `${name}: proxy cards must not overflow content`).toBeLessThanOrEqual(geometry.pageScroll.contentWidth + 1);
    expect(geometry.pageScroll.documentScrollWidth, `${name}: no document horizontal overflow`).toBeLessThanOrEqual(geometry.pageScroll.documentWidth + 1);
  }
  return geometry;
}

describe("profile card menus — native Electron geometry", () => {
  beforeAll(async () => {
    expect(path.basename(USERDATA).startsWith("studio-profile-menu-e2e-")).toBe(true);
    handle = await setupTestApp({ userDataDir: USERDATA, resetUserData: false, keepInitialDialogs: true,
      env: { AGENT_BROWSER_CHROMIUM_CACHE_DIR: path.join(USERDATA, "chromium-cache"), AGENT_BROWSER_SECRET_BACKEND: "file" }, timeoutMs: 60_000 });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const pid = handle.app.process().pid!;
    fs.writeFileSync(path.join(EVIDENCE, "fixture-process.json"), JSON.stringify({ pid, userData: USERDATA,
      source: path.resolve(__dirname, "../.."), runnerPid: process.pid,
      command: process.platform === "darwin" ? execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8" }).trim() : null }, null, 2));
    const isolation = await handle.app.evaluate(({ app }) => ({ userData: app.getPath("userData"),
      home: process.getBuiltinModule("node:os").homedir(), arch: process.arch, electron: process.versions.electron,
      providers: Object.keys(process.env).filter(k => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(k)) }));
    expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(USERDATA));
    expect(fs.realpathSync(isolation.home)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(isolation.providers).toEqual([]);
    await handle.page.locator("#dlg-terms").waitFor({ state: "visible" });
    await handle.page.locator("#terms-ack").check();
    await handle.page.locator("#terms-accept-btn").click();
    await handle.page.evaluate(() => {
      (window as any).wizardDismissed = true;
      localStorage.setItem("agent-browser-studio-wizard-dismissed", "1");
      for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
      (window as any).i18n.set("en-US");
      (window as any).agentBrowser.switchTab("profiles");
    });
    const license = await handle.page.evaluate(() => (window as any).agentBrowser.api.license.status());
    expect(license.plan).toBe("trial"); expect(license.expired).toBe(false);
    expect(license.maxProfiles).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < 10; i++) {
      const f = { name: `Menu E2E ${String(i + 1).padStart(2, "0")} ${i % 2 ? "Web App" : "Normal"}`, webApp: !!(i % 2) };
      const created = await handle.page.evaluate(({ f, i }) => (window as any).agentBrowser.api.browser.create({
        name: f.name, platform: "windows", fingerprintMode: "off", proxyMode: "none", fingerprintSeed: 4242 + i,
        appUrl: f.webApp ? "data:text/html,<title>Menu fixture only</title>" : null,
      }), { f, i });
      expect(created.dirId, JSON.stringify(created)).toBeTruthy();
      fixtures.push({ ...f, id: created.dirId });
      fs.mkdirSync(path.dirname(sentinel(created.dirId)), { recursive: true });
      fs.writeFileSync(sentinel(created.dirId), `Menu sentinel ${created.dirId}`);
      expect(disk().browserProfiles[created.dirId].name).toBe(f.name);
    }
    // Persist canonical dated metadata on these newly-created fixture IDs only.
    // Native creation passes its real trial gate first. The store fixture does
    // not alter license/team/runtime state and gives Undo a meaningful dated
    // creation-time invariant instead of a legacy missing-timestamp ambiguity.
    await handle.app.evaluate(async({app},ids)=>{
      const p=process.getBuiltinModule("node:path"),u=process.getBuiltinModule("node:url");
      const vm=process.getBuiltinModule("node:vm");
      const url=u.pathToFileURL(p.join(app.getAppPath(),"dist/main/services/config-manager.js")).href;
      const cfg=await vm.runInThisContext(`import(${JSON.stringify(url)})`,{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
      const next=structuredClone(cfg.getConfig());
      ids.forEach((id:string,i:number)=>Object.assign(next.browserProfiles[id],{dirId:id,createdAt:1700000000000+i}));
      cfg.saveConfig(next);
    },fixtures.map(f=>f.id));
    for(const [i,f] of fixtures.entries())expect(disk().browserProfiles[f.id]).toMatchObject({dirId:f.id,createdAt:1700000000000+i,name:f.name});
    await handle.page.evaluate(() => {
      const ab = (window as any).agentBrowser;
      const original = ab.ipc.call;
      (window as any).__profileMenuCalls = [];
      ab.ipc.call = function (key: string, fn: Function, opts: any) {
        (window as any).__profileMenuCalls.push(key);
        return original.call(this, key, fn, opts);
      };
      ab.refresh();
    });
    await handle.page.waitForFunction(() => document.querySelectorAll("#profile-list .profile-card").length === 10);
    fs.writeFileSync(path.join(EVIDENCE, "fixture-isolation.json"), JSON.stringify({ isolation, license, fixtures, userData: USERDATA }, null, 2));
    console.log(`PROFILE_MENU_EVIDENCE ${EVIDENCE}; USERDATA ${USERDATA}`);
    await installActivationTrace();
  }, 90_000);

  beforeEach(async () => {
    traceSelector = null;
    await handle.app.evaluate(() => { (globalThis as any).__menuNativeTrace = { events: [], dropped: 0 }; });
    await handle.page.evaluate(() => { (window as any).__menuRendererTrace = { events: [], dropped: 0 }; });
  });

  afterEach(async () => {
    if (!handle) return;
    // Record the failing state before any existing cleanup can conceal it.
    await captureActivationState(`test-${++traceNumber}-before-cleanup`);
    // Cancellation only, never confirmation/purge. Native activation closes
    // details; do not silently set .open and bypass the lifecycle under test.
    if (await handle.page.locator("#dlg-confirm").evaluate((d: HTMLDialogElement) => d.open)) {
      await handle.page.keyboard.press("Escape");
    }
    for (const summary of await handle.page.locator("#profile-list .card-menu[open] > summary").all()) await summary.click();
    // A failed navigation assertion must not leave later independent tests on
    // Storage. This is cleanup after assertions, never a repair before them.
    await handle.page.evaluate(()=>{const ab=(window as any).agentBrowser;ab.closeCardMenus(document,false);
      for(const d of document.querySelectorAll("dialog[open]"))(d as HTMLDialogElement).close();
      if(ab.state.currentTab!=="profiles")ab.switchTab("profiles");});
    await handle.page.waitForTimeout(80);
  });

  afterAll(async () => {
    // This suite never launches a profile browser. Close only its owned app,
    // without using the shared browser-launch suites' pkill fallback.
    if (handle) await handle.app.close();
    // Intentionally retain test-owned userData, JSON and native screenshots for
    // RED/GREEN comparison. No real profile or installed process is touched.
  }, 90_000);

  it("persists and reads back all ten synthetic profiles within the genuine trial quota", async () => {
    const config = fs.readFileSync(CONFIG), index = indexBytes();
    expect(Object.keys(disk().browserProfiles)).toHaveLength(10);
    await assertStorageUnchanged(config, index);
  });

  for (const size of [1100, 800].flatMap(width => [1, 1.25, 1.5].map(zoom => ({ width, height: width === 1100 ? 750 : 600, zoom })))) {
    for (const c of cases) {
      it(`${c.label}: menu stays in viewport and Delete is foreground at ${size.width}x${size.height} zoom ${size.zoom}`, async () => {
        const f = fixtures[c.fixture], id = f.id, name = `${size.width}x${size.height}-z${size.zoom}-${c.label}`;
        await resize(size.width, size.height, size.zoom);
        const card = handle.page.locator(cardSelector(id));
        await card.locator(".profile-select-checkbox").check();
        await handle.page.evaluate(id => {
          // Explicit clean precondition, not a renderer layout repair. Native
          // activation may scroll hidden/root ancestors again; record that too.
          document.scrollingElement!.scrollTop = 0;
          document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`)!.scrollIntoView({ block: "center" });
        }, id);
        const before = await handle.page.evaluate(measureMenu, id);
        fs.writeFileSync(path.join(EVIDENCE, `${name}-pre-activation.json`), JSON.stringify(before, null, 2));
        await assertRequestedWindow(`${name}-before-click`, `${cardSelector(id)} .card-menu`);
        await card.locator(".card-menu > summary").click(); // Native details default action.
        await handle.page.waitForTimeout(250);
        const opened = await capture(`${name}-opened-before-delete-scroll`, id);
        await assertRequestedWindow(`${name}-after-click`);
        // ONLY the menu may scroll to its last action. No Delete locator action
        // or page scroll is permitted before this geometry and capturePage.
        await card.locator(".card-menu-list").evaluate(el => { el.scrollTop = el.scrollHeight; });
        const reachable = await capture(`${name}-after-menu-internal-scroll`, id);
        const config = fs.readFileSync(CONFIG), index = indexBytes();
        expect(opened.open).toBe(true); expect(opened.busy).toBe("false"); expect(opened.disabled).toBe(false);
        expect(opened.webApp).toBe(f.webApp);
        expect.soft(inside(opened.menu, opened.viewport), `${name}: complete menu must fit viewport within 1 CSS px`).toBe(true);
        expect.soft(opened.scroll.scrollWidth, `${name}: no content horizontal overflow`).toBeLessThanOrEqual(opened.scroll.width + 1);
        expect.soft(opened.scroll.documentScrollWidth, `${name}: no document horizontal overflow`).toBeLessThanOrEqual(opened.scroll.documentWidth + 1);
        expect.soft(inside(reachable.delete, reachable.viewport), `${name}: Delete reachable in viewport after menu-only scroll`).toBe(true);
        expect.soft(inside(reachable.delete, reachable.menu), `${name}: Delete visible inside menu scrollport`).toBe(true);
        expect.soft(Math.abs(reachable.scroll.top - opened.scroll.top), `${name}: menu-only scroll must not scroll content`).toBeLessThanOrEqual(1);
        expect(reachable.owner).toBe(id); expect(reachable.containerContains).toBe(true);
        // Hard guard prevents Playwright auto-scroll from concealing RED or a
        // stray click from reaching an adjacent profile's control.
        expect(reachable.hits.every(h => h.deleteHit), `${name}: Delete center and four edge midpoints must hit its own enabled button; evidence ${EVIDENCE}`).toBe(true);
        await deleteOnlyOpensExpectedConfirmation(id, config, index);
      });
    }
  }

  for (const fixture of [4, 5]) {
    it(`does not let a sibling cover viewport-contained Delete on ${fixture === 4 ? "Normal" : "Web App"}`, async () => {
      const f = fixtures[fixture], id = f.id, name = `sibling-contained-${f.webApp ? "webapp" : "normal"}`;
      await resize(1100, 750, 1);
      const card = handle.page.locator(cardSelector(id));
      await card.locator(".profile-select-checkbox").check();
      await handle.page.evaluate(id => {
        document.scrollingElement!.scrollTop = 0;
        const content = document.querySelector("#content")!;
        const summary = document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"] summary`)!;
        content.scrollTop += summary.getBoundingClientRect().top - 250;
      }, id);
      await card.locator(".card-menu > summary").click();
      await handle.page.waitForTimeout(250);
      const measured = await capture(`${name}-before-delete-click`, id);
      expect(inside(measured.delete, measured.viewport), "Control precondition separates sibling cover from viewport clipping").toBe(true);
      expect(measured.disabled).toBe(false); expect(measured.busy).toBe("false");
      expect(measured.hits.every(h => h.deleteHit), `${name}: viewport-contained Delete must hit own button, not next profile; evidence ${EVIDENCE}`).toBe(true);
      await deleteOnlyOpensExpectedConfirmation(id, fs.readFileSync(CONFIG), indexBytes());
    });
  }

  it("distinguishes intentionally busy/disabled controls from an enabled menu being covered", async () => {
    await resize(1100, 750, 1);
    const id = fixtures[4].id, config = fs.readFileSync(CONFIG), index = indexBytes();
    // Existing real confirmation path makes the synthetic card busy without a
    // profile browser or a storage write. This is a control, not menu activation.
    await handle.page.evaluate(id => (window as any).agentBrowser.delProfile(id), id);
    await handle.page.locator("#dlg-confirm").waitFor({ state: "visible" });
    const card = handle.page.locator(cardSelector(id));
    expect(await card.getAttribute("aria-busy")).toBe("true");
    expect(await card.locator('[data-action="delete"]').isDisabled()).toBe(true);
    expect(await card.evaluate(el => getComputedStyle(el).pointerEvents)).toBe("none");
    await assertStorageUnchanged(config, index);
    await handle.page.keyboard.press("Escape");
    await expect.poll(() => card.getAttribute("aria-busy")).toBe("false");
    expect(await card.locator('[data-action="delete"]').isEnabled()).toBe(true);
    await assertStorageUnchanged(config, index);
  });

  for (const key of ["Enter", "Space"] as const) {
    it(`genuine ${key}, Tab/Shift-Tab and Escape retain native summary/button focus`, async () => {
      await resize(1100,750,1);
      const id=fixtures[4].id, summary=handle.page.locator(`${cardSelector(id)} .card-menu > summary`);
      await openProfileMenu(id,key);
      await capture("keyboard-"+key,id);
      await handle.page.keyboard.press("Tab");
      expect(await handle.page.evaluate(() => document.activeElement?.getAttribute("data-action"))).toBe("rename");
      await handle.page.keyboard.press("Shift+Tab");
      expect(await summary.evaluate(el => el===document.activeElement)).toBe(true);
      await handle.page.keyboard.press("Tab");
      await handle.page.keyboard.press("Escape");
      await noOpenPanels();
      expect(await summary.evaluate(el => el===document.activeElement)).toBe(true);
    });
  }

  it("repeat activation and header/card coordination keep exactly one original panel", async () => {
    await resize(1100,750,1);
    const id=fixtures[0].id, summary=handle.page.locator(`${cardSelector(id)} .card-menu > summary`);
    for(let i=0;i<3;i++) {
      await openProfileMenu(id);
      expect(await handle.page.locator(".card-menu-list:popover-open").count()).toBe(1);
      await summary.click(); await noOpenPanels();
    }
    await openProfileMenu(id);
    await handle.page.locator("#profiles-more-menu > summary").click();
    await expect.poll(() => handle.page.locator("#profiles-more-menu .card-menu-list").evaluate(el=>el.matches(":popover-open"))).toBe(true);
    expect(await handle.page.locator(".card-menu-list:popover-open").count()).toBe(1);
    expect(await handle.page.locator(`${cardSelector(id)} .card-menu`).evaluate((el:HTMLDetailsElement)=>el.open)).toBe(false);
    await handle.page.keyboard.press("Escape"); await noOpenPanels();
  });

  it("outside input click dismisses without stealing the newly acquired focus", async () => {
    await resize(1100,750,1); await openProfileMenu(fixtures[0].id);
    await handle.page.locator("#profile-tag-filter").click();
    await noOpenPanels();
    expect(await handle.page.locator("#profile-tag-filter").evaluate(el=>el===document.activeElement)).toBe(true);
  });

  it("internal wheel exposes Delete without scrolling content; external wheel dismisses", async () => {
    await resize(800,600,1.5); const id=fixtures[5].id;
    await openProfileMenu(id,undefined,true);
    const before=await capture("wheel-before",id);
    expect(before.menuScroll.scrollHeight).toBeGreaterThan(before.menuScroll.height);
    await handle.page.mouse.move(before.menu.left+before.menu.width/2,before.menu.top+before.menu.height/2);
    await handle.page.mouse.wheel(0,1200);
    await expect.poll(() => handle.page.locator(`${cardSelector(id)} .card-menu-list`).evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    const after=await capture("wheel-internal-after",id);
    expect(after.open).toBe(true); expect(after.popoverOpen).toBe(true);
    expect(Math.abs(after.scroll.top-before.scroll.top)).toBeLessThanOrEqual(1);
    expect(inside(after.delete,after.menu)).toBe(true); expect(after.hits.every(h=>h.deleteHit)).toBe(true);
    const outside = { x: after.content.right - 20, y: Math.min(after.content.bottom - 3, after.content.top + 70) };
    expect(await handle.page.evaluate(({x,y}) => {
      const hit = document.elementFromPoint(x,y);
      return !!hit && document.querySelector("#content")!.contains(hit) && !hit.closest(".card-menu-list");
    }, outside), "external wheel must really target content, not the top-layer panel").toBe(true);
    await handle.page.mouse.move(outside.x, outside.y);
    expect(await handle.page.locator(`${cardSelector(id)} .card-menu-list`).evaluate(el => el.matches(":popover-open"))).toBe(true);
    await handle.page.mouse.wheel(0,140);
    await noOpenPanels();
  });

  for(const change of ["resize","zoom"] as const) {
    it(`${change} closes synchronously and reopening uses the new native viewport`, async () => {
      await resize(1100,750,1); const id=fixtures[0].id; await openProfileMenu(id);
      await handle.app.evaluate(({BrowserWindow},change)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("index.html"))!;
        if(change==="resize")w.setContentSize(800,600);else w.webContents.setZoomFactor(1.25);},change);
      await noOpenPanels(); await openProfileMenu(id);
      const g=await capture("lifecycle-"+change,id); expect(inside(g.menu,g.viewport)).toBe(true);
      await handle.page.keyboard.press("Escape");
    });
  }

  it("programmatic tab transition precloses without restoring into hidden profile content", async () => {
    await resize(1100,750,1); const id=fixtures[0].id; await openProfileMenu(id);
    await handle.page.keyboard.press("Tab");
    const transition=await handle.page.evaluate(async()=>{const ab=(window as any).agentBrowser;ab.switchTab("storage");
      const panels=document.querySelectorAll(".card-menu-list:popover-open").length;
      const immediateFocus=document.activeElement?.getAttribute("data-action");
      // Assert closure in the same task; observe native unfocusing only after
      // the actual tab-hide layout has run. No test focus() repair is allowed.
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      return {panels,immediateFocus,settledFocus:document.activeElement?.tagName,
        focusedHiddenItem:!!document.activeElement?.closest(".card-menu-list"),
        profileHidden:getComputedStyle(document.querySelector("#tab-profiles")!).display==="none"};});
    fs.writeFileSync(path.join(EVIDENCE,"programmatic-tab-transition.json"),JSON.stringify(transition,null,2));
    expect(transition.panels).toBe(0); expect(transition.focusedHiddenItem).toBe(false); expect(transition.profileHidden).toBe(true);
    await handle.page.evaluate(()=>(window as any).agentBrowser.switchTab("profiles"));
    await expect.poll(()=>handle.page.locator("#profile-list .profile-card").count()).toBe(10);
  });

  for(const operation of ["hidden","removed"] as const) {
    it(`UI-only owner ${operation} fixture cleans native state and restores DOM without persistence claims`, async () => {
      await resize(1100,750,1); const id=fixtures[0].id,config=fs.readFileSync(CONFIG),index=indexBytes();
      await openProfileMenu(id);
      await handle.page.evaluate(({id,operation})=>{const card=document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`) as HTMLElement;
        (window as any).__menuUiOwner={card,parent:card.parentNode,next:card.nextSibling,hidden:card.hidden,panel:card.querySelector(".card-menu-list")};
        if(operation==="hidden")card.hidden=true;else card.remove();},{id,operation});
      try {
        await expect.poll(()=>handle.page.evaluate(()=>(window as any).__menuUiOwner.panel.matches(":popover-open"))).toBe(false);
        expect(await handle.page.evaluate(()=>(window as any).__menuUiOwner.card.querySelector(".card-menu").open)).toBe(false);
        await assertStorageUnchanged(config,index);
      }finally{
        await handle.page.evaluate(()=>{const f=(window as any).__menuUiOwner;f.card.hidden=f.hidden;
          if(!f.card.isConnected)f.parent.insertBefore(f.card,f.next?.isConnected?f.next:null);delete (window as any).__menuUiOwner;});
      }
      await openProfileMenu(id); await handle.page.keyboard.press("Escape"); await noOpenPanels();
    });
  }

  it("unchanged soft refresh preserves panel/node/focus; real metadata rerender closes before replacement", async () => {
    await resize(1100,750,1); const f=fixtures[0],id=f.id; await openProfileMenu(id); await handle.page.keyboard.press("Tab");
    await handle.page.evaluate(id=>{const card=document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`)!;
      (window as any).__menuRefreshCard=card;(window as any).__menuRefreshFocus=document.activeElement;
      (window as any).__menuRefreshBeforeHtml=card.outerHTML;
      (window as any).agentBrowser.refreshProfilesSoft();},id);
    await handle.page.waitForTimeout(350);
    fs.writeFileSync(path.join(EVIDENCE, "soft-refresh-node-readback.json"), JSON.stringify(await handle.page.evaluate(id => {
      const after = document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`)!;
      return { beforeHtml: (window as any).__menuRefreshBeforeHtml, afterHtml: after.outerHTML,
        sameNode: after === (window as any).__menuRefreshCard };
    }, id), null, 2));
    expect(await handle.page.evaluate(id=>document.querySelector(`#profile-list .profile-card[data-dir-id="${id}"]`)===(window as any).__menuRefreshCard,id)).toBe(true);
    expect(await handle.page.evaluate(()=>document.activeElement===(window as any).__menuRefreshFocus)).toBe(true);
    expect((await capture("unchanged-soft-refresh",id)).popoverOpen).toBe(true);
    const name=f.name+" rerender-owned-fixture";
    expect(await handle.page.evaluate(({id,name})=>(window as any).agentBrowser.api.browser.setMeta(id,{name}),{id,name})).toMatchObject({success:true});
    try {
      expect(disk().browserProfiles[id].name).toBe(name);
      await handle.page.evaluate(()=>(window as any).agentBrowser.refreshProfilesSoft());
      await expect.poll(()=>handle.page.locator(`${cardSelector(id)} .name`).innerText()).toBe(name);
      await noOpenPanels();
      expect(await handle.page.evaluate(()=>document.activeElement?.closest(".card-menu-list")!==null)).toBe(false);
      expect((await handle.page.evaluate(id=>(window as any).agentBrowser.api.profile.get(id),id)).name).toBe(name);
    }finally{
      expect(await handle.page.evaluate(({id,name})=>(window as any).agentBrowser.api.browser.setMeta(id,{name}),{id,name:f.name})).toMatchObject({success:true});
      await handle.page.evaluate(()=>(window as any).agentBrowser.refreshProfilesSoft());
      await expect.poll(()=>handle.page.locator(`${cardSelector(id)} .name`).innerText()).toBe(f.name);
      await handle.page.evaluate(()=>{delete (window as any).__menuRefreshCard;delete (window as any).__menuRefreshFocus;});
    }
  });

  for(const cancel of ["cancel","close","escape"] as const) {
    it(`actual Delete -> ${cancel} preserves expected fixture, selection, bytes, index and zero trash IPC`, async () => {
      await resize(1100,750,1);const id=fixtures[4].id,card=handle.page.locator(cardSelector(id));
      await card.locator(".profile-select-checkbox").check();await openProfileMenu(id);
      await card.locator(".card-menu-list").evaluate(el=>{el.scrollTop=el.scrollHeight;});
      const g=await capture("delete-cancel-"+cancel,id);expect(g.hits.every(h=>h.deleteHit)).toBe(true);
      const config=fs.readFileSync(CONFIG),index=indexBytes();await card.locator('[data-action="delete"]').click();
      await handle.page.locator("#dlg-confirm").waitFor({state:"visible"});
      expect(await handle.page.locator("#dlg-confirm").evaluate((d:any)=>d._returnFocus?.closest(".profile-card")?.getAttribute("data-dir-id"))).toBe(id);
      await noOpenPanels();await assertStorageUnchanged(config,index);
      if(cancel==="escape")await handle.page.keyboard.press("Escape");
      else if(cancel==="close")await handle.page.locator("#dlg-confirm > .dialog-close").click();
      else await handle.page.locator('#dlg-confirm [data-cmd="close-dialog"]').click();
      await expect.poll(()=>card.getAttribute("aria-busy")).toBe("false");
      expect(await card.locator(".profile-select-checkbox").isChecked()).toBe(true);
      await assertStorageUnchanged(config,index);
    });
  }

  it("UI-only scrolling modal/form panel retains ancestry, inert background, two Escape layers and no accidental submit", async () => {
    await resize(800,600,1.5);const config=fs.readFileSync(CONFIG),index=indexBytes();
    await handle.page.evaluate(()=>{const dialog=document.createElement("dialog");dialog.id="menu-ui-modal";
      dialog.style.cssText="width:320px;max-height:280px;overflow:auto";
      dialog.innerHTML='<form id="menu-ui-form" method="dialog"><input id="menu-ui-input" aria-label="Fixture input"><div style="height:120px">UI-only modal-descendant fixture</div><details class="card-menu" id="menu-ui-details"><summary>Fixture actions</summary><div class="card-menu-list" popover="manual"><button type="button" id="menu-ui-action">Harmless action</button></div></details><div style="height:180px"></div><button type="submit" id="menu-ui-submit">Fixture submit</button></form>';
      document.body.appendChild(dialog);(window as any).__menuUiCounts={actions:0,submits:0};
      dialog.querySelector("#menu-ui-action")!.addEventListener("click",()=>{(window as any).__menuUiCounts.actions++;});
      dialog.querySelector("form")!.addEventListener("submit",()=>{(window as any).__menuUiCounts.submits++;});
      (dialog as any)._returnFocus=document.querySelector("#profile-status-filter");dialog.showModal();});
    try {
      const summary=handle.page.locator("#menu-ui-details > summary");await summary.click();
      const g=await captureSurface("modal-retained-dom","#menu-ui-details","#menu-ui-action");
      expect(g.ancestry.dialog).toBe("menu-ui-modal");expect(g.ancestry.form).toBe("menu-ui-form");
      expect(await handle.page.locator("#profile-status-filter").evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el;})).toBe(false);
      await handle.page.locator("#menu-ui-action").click();expect(await handle.page.evaluate(()=>(window as any).__menuUiCounts)).toEqual({actions:1,submits:0});
      await handle.page.keyboard.press("Escape");await noOpenPanels();
      expect(await handle.page.locator("#menu-ui-modal").evaluate((el:HTMLDialogElement)=>el.open)).toBe(true);
      await handle.page.keyboard.press("Escape");
      await expect.poll(()=>handle.page.locator("#menu-ui-modal").evaluate((el:HTMLDialogElement)=>el.open)).toBe(false);
      expect(await handle.page.locator("#profile-status-filter").evaluate(el=>el===document.activeElement)).toBe(true);
      await handle.page.evaluate(()=>{const d=document.querySelector("#menu-ui-modal") as HTMLDialogElement;(d as any)._returnFocus=document.querySelector("#profile-status-filter");d.showModal();});
      await summary.click();await handle.page.locator("#menu-ui-submit").click();
      await expect.poll(()=>handle.page.locator("#menu-ui-modal").evaluate((el:HTMLDialogElement)=>el.open)).toBe(false);
      await noOpenPanels();expect(await handle.page.evaluate(()=>(window as any).__menuUiCounts)).toEqual({actions:1,submits:1});
      await assertStorageUnchanged(config,index);
    }finally{await handle.page.evaluate(()=>{const d=document.querySelector("#menu-ui-modal") as HTMLDialogElement;if(d?.open)d.close();d?.remove();delete (window as any).__menuUiCounts;});}
  });

  for(const width of [1100,800])for(const zoom of [1,1.25,1.5]) {
    it(`header Bulk Import -> Cancel stays foreground at ${width}x${width===1100?750:600} zoom ${zoom}`, async () => {
      await resize(width,width===1100?750:600,zoom);await handle.page.evaluate(()=>{document.querySelector("#content")!.scrollTop=0;});
      const config=fs.readFileSync(CONFIG),index=indexBytes(),summary=handle.page.locator("#profiles-more-menu > summary");
      await summary.click();await handle.page.waitForTimeout(250);
      await captureSurface(`header-${width}-z${zoom}`,"#profiles-more-menu",'[data-cmd="bulkImport"]');
      await handle.page.locator('#profiles-more-menu [data-cmd="bulkImport"]').click();
      await handle.page.locator("#dlg-bulk-import").waitFor({state:"visible"});await noOpenPanels();
      const close=handle.page.locator('#dlg-bulk-import [data-cmd="close-dialog"]');
      const before=await handle.page.locator('#dlg-bulk-import').evaluate(el=>({scrollTop:el.scrollTop,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,
        cancelTop:el.querySelector('[data-cmd="close-dialog"]')!.getBoundingClientRect().top}));
      const captureDialog=async(stage:string)=>{const png=await handle.app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("index.html"))!.webContents.capturePage()).toPNG().toString("base64"));
        fs.writeFileSync(path.join(EVIDENCE,stage+".png"),Buffer.from(png,"base64"));};
      await captureDialog(`header-dialog-${width}-z${zoom}-before-footer-scroll`);
      // Long dialogs intentionally own a scrollbar. Expose the footer through
      // that scrollbar before any item locator can auto-scroll or click it.
      const contentTop=await handle.page.locator('#content').evaluate(el=>el.scrollTop);
      await handle.page.locator('#dlg-bulk-import').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      await handle.page.waitForTimeout(80);
      expect(await handle.page.locator('#content').evaluate(el=>el.scrollTop)).toBe(contentTop);
      await captureDialog(`header-dialog-${width}-z${zoom}-after-footer-scroll`);
      fs.writeFileSync(path.join(EVIDENCE,`header-dialog-${width}-z${zoom}.json`),JSON.stringify({before,after:await close.evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom};})},null,2));
      expect(await close.evaluate(el=>{const r=el.getBoundingClientRect(),h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return h===el||el.contains(h);})).toBe(true);
      const physical=await close.evaluate(el=>{const r=el.getBoundingClientRect();return {rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
        viewport:{left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight},
        hits:[[r.left+r.width/2,r.top+r.height/2],[r.left+2,r.top+r.height/2],[r.right-2,r.top+r.height/2],[r.left+r.width/2,r.top+2],[r.left+r.width/2,r.bottom-2]].map(([x,y])=>{const h=document.elementFromPoint(x,y);return{x,y,own:h===el||!!h&&el.contains(h),tag:h?.tagName};})};});
      fs.writeFileSync(path.join(EVIDENCE,`header-dialog-${width}-z${zoom}-physical-cancel.json`),JSON.stringify(physical,null,2));
      expect(inside(physical.rect,physical.viewport)).toBe(true);
      expect(physical.hits.every(h=>h.own),"Cancel center and all four edge midpoints must remain foreground after dialog-only scroll").toBe(true);
      await close.click();await expect.poll(()=>summary.evaluate(el=>el===document.activeElement)).toBe(true);await assertStorageUnchanged(config,index);
    });
  }

  it("proxy first/middle/last/rightmost menus use the same top layer and real History/Bind/Delete cancellation owners", async () => {
    // Backend names intentionally obey its ASCII/64-character validation. Long
    // Chinese action text comes from real zh-CN i18n, not invalid stored names.
    const names=["Proxy-first-long-English-label-"+"read-only-".repeat(3),"Proxy-rightmost-"+"longNativeLabel".repeat(3),"Proxy-middle","Proxy-middle-right","Proxy-last","Proxy-last-rightmost"];
    for(const [i,name] of names.entries())expect(await handle.page.evaluate(({name,i})=>(window as any).agentBrowser.api.proxy.add(name,{type:"http",host:"127.0.0.1",port:24000+i}),{name,i})).toMatchObject({success:true});
    await handle.page.evaluate(()=>(window as any).agentBrowser.switchTab("proxy"));
    await expect.poll(()=>handle.page.locator("#proxy-list .profile-card").count()).toBe(names.length);
    await expect.poll(()=>handle.page.locator("#tab-proxy").isVisible()).toBe(true);
    try {
      const config=fs.readFileSync(CONFIG),index=indexBytes();
      for(const width of [1100,800])for(const zoom of [1,1.25,1.5])for(const i of [0,1,2,4,5]) {
        await resize(width,width===1100?750:600,zoom);
        const card=handle.page.locator("#proxy-list .profile-card").filter({has:handle.page.locator(`[data-proxy-name="${names[i]}"]`)});
        // Exact owner from attribute, not text matching a neighbour.
        const selector=await handle.page.evaluate(name=>{const c=Array.from(document.querySelectorAll("#proxy-list .profile-card")).find(c=>c.getAttribute("data-proxy-name")===name)!;c.scrollIntoView({block:"center"});return '#proxy-list .profile-card[data-proxy-name="'+CSS.escape(name)+'"] .card-menu';},names[i]);
        const owner=handle.page.locator(selector);
        await assertRequestedWindow(`proxy-${width}-z${zoom}-owner-${i}-before-hover`,selector);
        expect(await handle.page.evaluate(()=>(window as any).agentBrowser.state.currentTab)).toBe("proxy");
        expect(await handle.page.locator("#tab-proxy").isVisible()).toBe(true);
        await owner.locator("summary").hover();await handle.page.waitForTimeout(250);
        await captureActivationState(`proxy-${width}-z${zoom}-owner-${i}-before-click`,selector);
        await owner.locator("summary").click();await handle.page.waitForTimeout(250);
        await assertRequestedWindow(`proxy-${width}-z${zoom}-owner-${i}-after-click`,selector);
        await owner.locator(".card-menu-list").evaluate(el=>{el.scrollTop=el.scrollHeight;});
        await captureSurface(`proxy-${width}-z${zoom}-owner-${i}`,selector,'[data-action="delete-proxy"]');
        await owner.locator('[data-action="delete-proxy"]').click();await handle.page.locator("#dlg-confirm").waitFor({state:"visible"});
        expect(await handle.page.locator("#dlg-confirm-msg").innerText()).toContain(names[i]);await noOpenPanels();
        await handle.page.keyboard.press("Escape");await waitForDialogClose("#dlg-confirm");
        await captureActivationState(`proxy-${width}-z${zoom}-owner-${i}-after-cancel`,selector);
        await assertStorageUnchanged(config,index);
      }
      await resize(1100,750,1);
      const selector=await handle.page.evaluate(name=>'#proxy-list .profile-card[data-proxy-name="'+CSS.escape(name)+'"] .card-menu',names[0]);
      const owner=handle.page.locator(selector);
      await owner.locator("summary").click();await captureSurface("proxy-bind",selector,'[data-action="bind-profiles"]');
      await owner.locator('[data-action="bind-profiles"]').click();await handle.page.locator("#dlg-proxy-bind").waitFor({state:"visible"});
      expect(await handle.page.locator("#dlg-proxy-bind-proxy").innerText()).toBe(names[0]);await noOpenPanels();await handle.page.keyboard.press("Escape");
      await waitForDialogClose("#dlg-proxy-bind");
      await owner.locator("summary").click();await captureSurface("proxy-history",selector,'[data-action="toggle-history"]');
      await owner.locator('[data-action="toggle-history"]').click();await noOpenPanels();
      await assertStorageUnchanged(config,index);
      expect((await handle.page.evaluate(()=>(window as any).__profileMenuCalls)).filter((k:string)=>/proxy\.(delete|setProfile|test)/.test(k))).toEqual([]);
    }finally{await handle.page.evaluate(()=>(window as any).agentBrowser.switchTab("profiles"));await expect.poll(()=>handle.page.locator("#profile-list .profile-card").count()).toBe(10);}
  },120_000);

  for(const language of ["en-US","zh-CN"])for(const width of [1100,800])for(const zoom of [1,1.25,1.5]) {
    it(`long ${language} synthetic owner and localized actions remain foreground at ${width} zoom ${zoom}`,async()=>{
      const f=fixtures[9],originalName=f.name;
      const name=(language==="zh-CN"?"下拉菜单验收专用长名称与完整中文操作标签".repeat(6):"Synthetic long English owner label "+"unbrokenCardTitle".repeat(8)).slice(0,120);
      await handle.page.evaluate(language=>(window as any).i18n.set(language),language);
      await resize(width,width===1100?750:600,zoom);
      expect(await handle.page.evaluate(({id,name})=>(window as any).agentBrowser.api.browser.setMeta(id,{name}),{id:f.id,name})).toMatchObject({success:true});
      f.name=name;
      try {
        expect(disk().browserProfiles[f.id].name).toBe(name);
        await handle.page.evaluate(()=>(window as any).agentBrowser.refreshProfilesSoft());
        await expect.poll(()=>handle.page.locator(`${cardSelector(f.id)} .name`).innerText()).toBe(name);
        await handle.page.locator(`${cardSelector(f.id)} .profile-select-checkbox`).check();
        await capture(`long-label-${language}-${width}-z${zoom}-pre-activation`,f.id);
        await openProfileMenu(f.id);
        const opened=await capture(`long-label-${language}-${width}-z${zoom}-before-action-scroll`,f.id);
        expect(inside(opened.menu,opened.viewport)).toBe(true);
        expect(opened.scroll.scrollWidth).toBeLessThanOrEqual(opened.scroll.width+1);
        await handle.page.locator(`${cardSelector(f.id)} .card-menu-list`).evaluate(el=>{el.scrollTop=el.scrollHeight;});
        const reached=await capture(`long-label-${language}-${width}-z${zoom}-after-internal-scroll`,f.id);
        expect(inside(reached.delete,reached.menu)).toBe(true);expect(reached.hits.every(h=>h.deleteHit)).toBe(true);
        await deleteOnlyOpensExpectedConfirmation(f.id,fs.readFileSync(CONFIG),indexBytes());
      }finally{
        f.name=originalName;
        expect(await handle.page.evaluate(({id,name})=>(window as any).agentBrowser.api.browser.setMeta(id,{name}),{id:f.id,name:originalName})).toMatchObject({success:true});
        await handle.page.evaluate(()=>{(window as any).i18n.set("en-US");(window as any).agentBrowser.refreshProfilesSoft();});
        await expect.poll(()=>handle.page.locator(`${cardSelector(f.id)} .name`).innerText()).toBe(originalName);
        expect(disk().browserProfiles[f.id].name).toBe(originalName);
      }
    });
  }

  // Additive layout regressions; native acceptance is NOT-RUN until the unified
  // source-hash snapshot is authorized. These do not replace any earlier menu,
  // five-point, scroll-height, no-horizontal-overflow or cancellation assertion.
  for (const language of ["en-US", "zh-CN"] as const) {
    it(`closed long valid proxy option -> wheel -> five Delete hits -> confirm Cancel at exact outer 800x600/1.5 (${language})`, async () => {
      // A middle Web App card has real scroll space below its anchor; the last
      // card cannot reach the viewport center when content scroll is clamped.
      const id = fixtures[5].id, card = handle.page.locator(cardSelector(id));
      const proxyName = `Menu-clearance-${language.replace("-", "")}-` + "NativeOption".repeat(3);
      const proxyConfig = { type: "http", host: "192.0.2.226", port: 24226 };
      const stage = `clearance-${language}-outer800x600-z1.5`;
      // Genuine persisted proxy fixture, ASCII/64-char backend-valid. No proxy
      // test, browser launch, assignment, network connection or real data.
      expect(proxyName).toMatch(/^[A-Za-z0-9_-]{55,64}$/);
      expect(await handle.page.evaluate(({ name, config }) =>
        (window as any).agentBrowser.api.proxy.add(name, config), { name: proxyName, config: proxyConfig })).toMatchObject({ success: true });
      expect(disk().proxies[proxyName]).toMatchObject(proxyConfig);
      expect(await handle.page.evaluate(name => (window as any).agentBrowser.api.proxy.get(name), proxyName)).toMatchObject(proxyConfig);
      expect((await handle.page.evaluate(() => (window as any).agentBrowser.api.proxy.list())).find((p: any) => p.name === proxyName)).toBeTruthy();
      await handle.page.evaluate(language => (window as any).i18n.set(language), language);
      try {
        await resize(800, 600, 1.5); // Verifies native OUTER bounds and actual zoom.
        await handle.page.evaluate(() => (window as any).agentBrowser.refreshProfilesSoft());
        const select = handle.page.locator("#batch-assign-proxy");
        await expect.poll(() => select.locator(`option[value="${proxyName}"]`).count()).toBe(1);
        await card.locator(".profile-select-checkbox").check();
        const config = fs.readFileSync(CONFIG), index = indexBytes();
        // Selection setup only, not native option-popup paint/input evidence.
        // Keep the complete native option/value; never truncate its DOM text.
        expect(await select.selectOption(proxyName)).toEqual([proxyName]);
        await select.scrollIntoViewIfNeeded(); // Closed-toolbar setup, before menu activation/measurement.
        await handle.page.waitForTimeout(80);
        await noOpenPanels();
        const closed = await capture(`${stage}-closed-long-option`, id);
        const batch = await select.evaluate(el => {
          const select = el as HTMLSelectElement, bar = document.querySelector("#profile-batch-actions")!;
          const box = (node: Element) => { const r = node.getBoundingClientRect(); return {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const s = getComputedStyle(select);
          return { select: box(select), bar: box(bar), clientWidth: bar.clientWidth, scrollWidth: bar.scrollWidth,
            value: select.value, selectedText: select.selectedOptions[0]?.textContent,
            optionText: Array.from(select.options).find(o => o.value === select.value)?.textContent,
            sizing: { minWidth: s.minWidth, maxWidth: s.maxWidth, boxSizing: s.boxSizing },
            barWrap: getComputedStyle(bar).flexWrap, locale: document.documentElement.lang };
        });
        fs.writeFileSync(path.join(EVIDENCE, `${stage}-batch-closed.json`), JSON.stringify(batch, null, 2));
        expect(closed.open).toBe(false); expect(closed.popoverOpen).toBe(false);
        expect(closed.scroll.scrollWidth, "closed-menu baseline must already be free of page overflow").toBeLessThanOrEqual(closed.scroll.width + 1);
        expect(closed.scroll.documentScrollWidth).toBeLessThanOrEqual(closed.scroll.documentWidth + 1);
        expect(batch.scrollWidth).toBeLessThanOrEqual(batch.clientWidth + 1);
        expect(inside(batch.select, batch.bar)).toBe(true);
        expect(inside(batch.select, closed.viewport)).toBe(true);
        expect(batch.value).toBe(proxyName); expect(batch.selectedText).toBe(proxyName); expect(batch.optionText).toBe(proxyName);
        expect(batch.sizing).toEqual({ minWidth: "0px", maxWidth: "100%", boxSizing: "border-box" });
        expect(batch.barWrap).toBe("wrap"); expect(batch.locale).toBe(language === "en-US" ? "en" : "zh-CN");
        await assertStorageUnchanged(config, index);

        const originalPanel = await card.locator(".card-menu-list").elementHandle();
        expect(originalPanel).not.toBeNull();
        try {
          await openProfileMenu(id, undefined, true); // Actual content scroll, centered trigger.
          const before = await capture(`${stage}-opened-before-wheel`, id);
          expect(before.open).toBe(true); expect(before.popoverOpen).toBe(true); expect(before.popover).toBe("manual");
          expect(before.busy).toBe("false"); expect(before.disabled).toBe(false);
          expect(before.menuScroll.scrollHeight).toBeGreaterThan(before.menuScroll.height);
          expect(inside(before.menu, before.viewport)).toBe(true);
          expect(before.scroll.scrollWidth).toBeLessThanOrEqual(before.scroll.width + 1);
          expect(before.scroll.documentScrollWidth).toBeLessThanOrEqual(before.scroll.documentWidth + 1);
          await handle.page.mouse.move(before.menu.left + before.menu.width / 2, before.menu.top + before.menu.height / 2);
          await handle.page.mouse.wheel(0, 1200); // No scrollTop assignment or action locator repair.
          await expect.poll(() => card.locator(".card-menu-list").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          const reached = await capture(`${stage}-immediate-after-wheel`, id);
          expect(reached.open).toBe(true); expect(reached.popoverOpen).toBe(true);
          expect(reached.owner).toBe(id); expect(reached.containerContains).toBe(true);
          expect(await card.locator(".card-menu-list").evaluate((node, original) => node === original, originalPanel)).toBe(true);
          expect(reached.menuScroll.top).toBeGreaterThan(before.menuScroll.top);
          expect(reached.menuScroll.scrollHeight).toBeGreaterThan(reached.menuScroll.height);
          expect(Math.abs(reached.scroll.top - before.scroll.top)).toBeLessThanOrEqual(1);
          expect(inside(reached.delete, reached.menu)).toBe(true); expect(inside(reached.delete, reached.viewport)).toBe(true);
          expect(reached.delete.height).toBeGreaterThanOrEqual(28);
          expect(reached.hits).toHaveLength(5);
          expect(reached.hits.every(h => h.deleteHit), "center and all FOUR edge midpoints, including active-scrollbar edge").toBe(true);
          expect(reached.scroll.scrollWidth).toBeLessThanOrEqual(reached.scroll.width + 1);
          expect(reached.scroll.documentScrollWidth).toBeLessThanOrEqual(reached.scroll.documentWidth + 1);

          // Only after geometry/foreground proof may the action locator click.
          await card.locator('[data-action="delete"]').click();
          await handle.page.locator("#dlg-confirm").waitFor({ state: "visible" });
          await noOpenPanels();
          expect(await handle.page.locator("#dlg-confirm").evaluate((d: any) => d._returnFocus?.closest(".profile-card")?.getAttribute("data-dir-id"))).toBe(id);
          expect(await card.getAttribute("aria-busy")).toBe("true");
          const cancel = handle.page.locator('#dlg-confirm [data-cmd="close-dialog"]');
          const cancelGeometry = await cancel.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
              viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight },
              hits: [[r.left+r.width/2,r.top+r.height/2],[r.left+2,r.top+r.height/2],[r.right-2,r.top+r.height/2],
                [r.left+r.width/2,r.top+2],[r.left+r.width/2,r.bottom-2]].map(([x,y]) => {
                  const hit = document.elementFromPoint(x,y); return { x, y, own: hit === el || !!hit && el.contains(hit) }; }) };
          });
          // capture() retains full native screenshot, outer/content bounds,
          // actual zoom/viewport and menu ancestry at every named stage.
          await capture(`${stage}-confirmation-before-cancel`, id);
          fs.writeFileSync(path.join(EVIDENCE, `${stage}-confirm-cancel-hits.json`), JSON.stringify(cancelGeometry, null, 2));
          expect(inside(cancelGeometry.rect, cancelGeometry.viewport)).toBe(true);
          expect(cancelGeometry.hits).toHaveLength(5); expect(cancelGeometry.hits.every(h => h.own)).toBe(true);
          await assertStorageUnchanged(config, index);
          await cancel.click();
          await expect.poll(() => card.getAttribute("aria-busy")).toBe("false");
          expect(await card.locator(".profile-select-checkbox").isChecked()).toBe(true);
          expect(await card.locator(".card-menu > summary").evaluate(el => el === document.activeElement)).toBe(true);
          expect(await select.inputValue()).toBe(proxyName);
          const cancelled = await capture(`${stage}-cancelled`, id);
          expect(cancelled.open).toBe(false); expect(cancelled.popoverOpen).toBe(false);
          expect(cancelled.scroll.scrollWidth).toBeLessThanOrEqual(cancelled.scroll.width + 1);
          expect(cancelled.scroll.documentScrollWidth).toBeLessThanOrEqual(cancelled.scroll.documentWidth + 1);
          await assertStorageUnchanged(config, index);
        } finally { await originalPanel?.dispose(); }
      } finally { await handle.page.evaluate(() => (window as any).i18n.set("en-US")); }
    }, 60_000);
  }

  it("exactly one confirmed soft-trash then real Undo restores the same ID, metadata, index and sentinel", async () => {
    await resize(1100,750,1);const f=fixtures[4],id=f.id,card=handle.page.locator(cardSelector(id));
    const meta=disk().browserProfiles[id],bytes=fs.readFileSync(sentinel(id)),trashSentinel=path.join(USERDATA,"trash","profiles",id,"Default","menu-sentinel.txt");
    await openProfileMenu(id);await card.locator(".card-menu-list").evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const g=await capture("confirm-trash-before-action",id);expect(g.hits.every(h=>h.deleteHit)).toBe(true);
    await card.locator('[data-action="delete"]').click();await handle.page.locator("#dlg-confirm").waitFor({state:"visible"});
    expect(await handle.page.locator("#dlg-confirm").evaluate((d:any)=>d._returnFocus?.closest(".profile-card")?.getAttribute("data-dir-id"))).toBe(id);
    expect(fs.readFileSync(sentinel(id))).toEqual(bytes);expect(indexBytes()).toBeNull();
    await handle.page.locator('#dlg-confirm button[type="submit"]').click();
    await expect.poll(()=>card.count()).toBe(0);
    expect((await handle.page.evaluate(()=>(window as any).__profileMenuCalls)).filter((k:string)=>k===`profile.trash:${id}`)).toHaveLength(1);
    expect(disk().browserProfiles[id]).toBeUndefined();expect(fs.existsSync(sentinel(id))).toBe(false);expect(fs.readFileSync(trashSentinel)).toEqual(bytes);
    const entries=JSON.parse(fs.readFileSync(INDEX,"utf8"));expect(entries).toHaveLength(1);expect(entries[0].dirId).toBe(id);expect(entries[0].meta).toEqual(meta);
    expect((await handle.page.evaluate(()=>(window as any).agentBrowser.api.profile.trashList())).entries.map((e:any)=>e.dirId)).toEqual([id]);
    expect((await handle.page.evaluate(()=>(window as any).agentBrowser.api.browser.list())).some((p:any)=>p.dirId===id)).toBe(false);
    // profile:get is non-nullable by design and returns a default info shape
    // for an absent directory. Use the real list lookup for absence, not a
    // fictitious null contract; retain the exact null/ID-search assertion.
    expect((await handle.page.evaluate(async id=>(await (window as any).agentBrowser.api.profile.list()).find((p:any)=>p.dirId===id)||null,id))).toBeNull();
    fs.writeFileSync(path.join(EVIDENCE,"confirmed-trash-readback.json"),JSON.stringify({id,meta,entries,sentinel:bytes.toString()},null,2));
    await handle.page.locator(".toast-stack .toast-success").last().locator(".toast-action").click();
    await expect.poll(()=>fs.existsSync(sentinel(id))).toBe(true);await expect.poll(()=>card.count()).toBe(1);
    expect(fs.readFileSync(sentinel(id))).toEqual(bytes);expect(fs.existsSync(trashSentinel)).toBe(false);expect(JSON.parse(fs.readFileSync(INDEX,"utf8"))).toEqual([]);
    expect(disk().browserProfiles[id]).toEqual(meta);
    expect(await handle.page.evaluate(()=>(window as any).agentBrowser.api.app.reloadConfig())).toMatchObject({success:true});
    // ProfileInfo nests only fingerprint fields; raw stored metadata belongs
    // to config-manager. Read that actual runtime store after reload, then also
    // verify the public profile:get's ID/name/fingerprint representation.
    expect(await handle.app.evaluate(async({app},id)=>{
      const p=process.getBuiltinModule("node:path"),u=process.getBuiltinModule("node:url");
      const vm=process.getBuiltinModule("node:vm");
      const url=u.pathToFileURL(p.join(app.getAppPath(),"dist/main/services/config-manager.js")).href;
      const cfg=await vm.runInThisContext(`import(${JSON.stringify(url)})`,{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
      return cfg.getConfig().browserProfiles[id];
    },id)).toMatchObject(meta);
    expect(await handle.page.evaluate(id=>(window as any).agentBrowser.api.profile.get(id),id)).toMatchObject({dirId:id,name:meta.name,fingerprint:{fingerprintSeed:meta.fingerprintSeed,platform:meta.platform}});
    expect((await handle.page.evaluate(()=>(window as any).agentBrowser.api.browser.list())).find((p:any)=>p.dirId===id)?.name).toBe(f.name);
    const calls=await handle.page.evaluate(()=>(window as any).__profileMenuCalls as string[]);
    expect(calls.filter(k=>k===`profile.trash:${id}`)).toHaveLength(1);expect(calls.filter(k=>k===`profile.trash-restore:${id}`)).toHaveLength(1);expect(calls.filter(k=>k.startsWith("browser.launch"))).toEqual([]);
    fs.writeFileSync(path.join(EVIDENCE,"undo-readback.json"),JSON.stringify({id,meta:disk().browserProfiles[id],index:JSON.parse(fs.readFileSync(INDEX,"utf8")),calls,sentinel:fs.readFileSync(sentinel(id),"utf8")},null,2));
  });
});
