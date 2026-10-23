import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const sourcePath = resolve(__dirname, "../../src/renderer/js/app/tabs.js");
const source = readFileSync(sourcePath, "utf8");
const escape = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Small synthetic DOM, not browser/layout evidence. Parse the renderer's actual
// cards so escaped attributes and delegated cache clicks cross the DOM boundary.
class Element {
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: Element[] = [];
  parentElement: Element | null = null;
  onclick: ((event: { target: Element }) => void) | null = null;
  private text = "";
  private markup = "";
  constructor(public tagName = "div") {}
  get className() { return this.attributes.class || ""; }
  set className(value: string) { this.attributes.class = value; }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
  };
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) {
    this.children.forEach(child => { child.parentElement = null; });
    this.children = [];
    this.text = String(value);
    this.markup = "";
  }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.textContent = "";
    this.markup = value;
    const stack: Element[] = [this];
    for (const token of value.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith("<")) { stack[stack.length - 1].text += decode(token); continue; }
      const tag = /^<([\w-]+)/.exec(token)?.[1];
      if (!tag) continue;
      const child = new Element(tag);
      for (const attr of token.matchAll(/\s([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) child.setAttribute(attr[1], decode(attr[2] ?? attr[3]));
      stack[stack.length - 1].appendChild(child);
      if (!["br", "img", "input"].includes(tag)) stack.push(child);
    }
  }
  appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
  contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const attr = /^\[([\w-]+)=['"]([^'"]*)['"]\]$/.exec(selector);
    return attr ? this.attributes[attr[1]] === attr[2] : this.tagName === selector;
  }
  closest(selector: string): Element | null {
    for (let node: Element | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  click() { for (let node: Element | null = this; node; node = node.parentElement) node.onclick?.({ target: this }); }
}

interface StorageInfo {
  totalProfileBytes: number;
  availableDiskBytes: number;
  diskUsagePercent: number;
  profiles: Array<{ dirId: string; name: string; sizeBytes: number; lastModified: number }>;
}
const info = (overrides: Partial<StorageInfo> = {}): StorageInfo => ({
  totalProfileBytes: 1024, availableDiskBytes: 8192, diskUsagePercent: 25,
  profiles: [{ dirId: "fixture-profile", name: "Fixture profile", sizeBytes: 512, lastModified: 0 }],
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
interface StorageRenderer {
  loadStorage(): void;
  clearCache(dirId: string): Promise<void>;
  clearAllCaches(): Promise<void>;
}
function harness(translations: Record<string, string> = {}) {
  const nodes = new Map<string, Element>();
  for (const id of ["stat-profile-total", "stat-disk-available", "stat-disk-usage", "stat-disk-usage-bar", "storage-profile-list"]) nodes.set(id, new Element());
  const el = (id: string) => nodes.get(id)!;
  for (const id of ["stat-profile-total", "stat-disk-available", "stat-disk-usage"]) el(id).textContent = "--";
  const meter = new Element("span");
  meter.className = "meter meter-wide";
  const bar = meter.appendChild(el("stat-disk-usage-bar"));
  bar.style.width = "0%";
  const list = el("storage-profile-list");
  const requests: Array<ReturnType<typeof deferred<StorageInfo>>> = [];
  const api = { storage: {
    info: vi.fn(() => { const request = deferred<StorageInfo>(); requests.push(request); return request.promise; }),
    clearCache: vi.fn(async (_dirId?: string) => ({ message: "Fixture cache cleared" })),
  } };
  const helpers = { esc: escape, escAttr: escape, fmt: (bytes: number) => bytes + " bytes", toast: vi.fn(), relTime: () => "Fixture relative time" };
  const ipc = { call: vi.fn((_key: string, call: () => Promise<StorageInfo>, _options: { kind: string }) => call()) };
  const window = { agentBrowser: { api, R: api, helpers, state: {}, ipc }, i18n: { t: (key: string, fallback: string) => translations[key] ?? fallback } };
  // No real IPC/API, network, processes, timers, application or user-data access.
  runInNewContext(source, { window, document: { getElementById: (id: string) => nodes.get(id) || null } }, { filename: sourcePath, timeout: 1000 });
  const app = window.agentBrowser as typeof window.agentBrowser & StorageRenderer;
  return { app, api, helpers, ipc, el, meter, bar, list, requests };
}
type Harness = ReturnType<typeof harness>;
function expectUnknown(h: Harness) {
  for (const id of ["stat-profile-total", "stat-disk-available", "stat-disk-usage"]) expect(h.el(id).textContent).toBe("—");
  expect(h.bar.style.width).toBe("");
  expect(h.meter.style.display).toBe("none");
  for (const name of ["is-good", "is-watch", "is-poor"]) expect(h.meter.classList.contains(name)).toBe(false);
}
function expectValid(h: Harness, value: StorageInfo) {
  expect(h.el("stat-profile-total").textContent).toBe(value.totalProfileBytes + " bytes");
  expect(h.el("stat-disk-available").textContent).toBe(value.availableDiskBytes + " bytes");
  expect(h.el("stat-disk-usage").textContent).toBe(value.diskUsagePercent + "%");
  expect(h.bar.style.width).toBe(value.diskUsagePercent + "%");
  expect(h.meter.style.display || "").toBe("");
  const status = value.diskUsagePercent < 70 ? "is-good" : value.diskUsagePercent < 90 ? "is-watch" : "is-poor";
  for (const name of ["is-good", "is-watch", "is-poor"]) expect(h.meter.classList.contains(name)).toBe(name === status);
}
function snapshot(h: Harness) {
  return {
    metrics: ["stat-profile-total", "stat-disk-available", "stat-disk-usage"].map(id => h.el(id).textContent),
    width: h.bar.style.width, display: h.meter.style.display, classes: h.meter.className,
    list: h.list.innerHTML, onclick: h.list.onclick,
  };
}

describe("storage renderer request state — actual tabs.js in a synthetic DOM/VM", () => {
  it.each([25, 80, 95])("clears previous metrics and a %s percent meter immediately while refreshing", async diskUsagePercent => {
    const h = harness();
    const value = info({ diskUsagePercent });
    h.app.loadStorage(); h.requests[0].resolve(value); await flush();
    expectValid(h, value);
    h.app.loadStorage();
    expectUnknown(h);
    expect(h.list.querySelector(".loading")?.textContent).toBe("Loading...");
    h.requests[1].resolve(value); await flush();
    expectValid(h, value);
  });

  it("does not retain successful metrics or a green meter after a failed refresh", async () => {
    const h = harness();
    h.app.loadStorage(); h.requests[0].resolve(info()); await flush();
    expectValid(h, info());
    h.app.loadStorage(); h.requests[1].reject(new Error("Capacity <unavailable>")); await flush();
    expectUnknown(h);
    expect(h.list.innerHTML).toContain("Capacity &lt;unavailable&gt;");
    expect(h.list.querySelector('[data-cmd="loadStorage"]')?.textContent).toBe("Retry");
    expect(h.list.querySelector(".profile-card")).toBeNull();
    expect(h.api.storage.clearCache).not.toHaveBeenCalled();
  });

  it("preserves valid zero values and an empty list's create-profile action", async () => {
    const h = harness();
    const value = info({ totalProfileBytes: 0, availableDiskBytes: 0, diskUsagePercent: 0, profiles: [] });
    h.app.loadStorage(); h.requests[0].resolve(value); await flush();
    expectValid(h, value);
    expect(h.list.textContent).toContain("No profile storage yet.");
    expect(h.list.querySelector('[data-cmd="newProfile"]')?.textContent).toBe("Create profile");
    expect(h.ipc.call).toHaveBeenCalledWith("storage.info", expect.any(Function), { kind: "list" });
  });

  it("restores current metrics, meter and profiles after failure then a subsequent success", async () => {
    const h = harness();
    h.app.loadStorage(); h.requests[0].resolve(info()); await flush();
    h.app.loadStorage(); h.requests[1].reject(new Error("Fixture unavailable")); await flush();
    expectUnknown(h);
    h.app.loadStorage(); expectUnknown(h);
    const recovered = info({ totalProfileBytes: 2048, availableDiskBytes: 4096, diskUsagePercent: 92,
      profiles: [{ dirId: "recovered", name: "Recovered profile", sizeBytes: 2048, lastModified: 0 }] });
    h.requests[2].resolve(recovered); await flush();
    expectValid(h, recovered);
    expect(h.list.querySelector(".profile-card")?.dataset.dirId).toBe("recovered");
    expect(h.list.textContent).toContain("Recovered profile");
    expect(h.list.querySelector('[data-action="clear-cache"]')).not.toBeNull();
  });

  it.each([
    ["success", "failure"], ["failure", "success"], ["success", "success"],
    ["failure", "failure"], ["success", "pending"], ["failure", "pending"],
  ] as const)("ignores an older %s after a newer %s", async (older, newer) => {
    const h = harness();
    h.app.loadStorage(); h.app.loadStorage();
    const current = info({ totalProfileBytes: 3000, availableDiskBytes: 4000, diskUsagePercent: 81,
      profiles: [{ dirId: "current", name: "Current profile", sizeBytes: 3000, lastModified: 0 }] });
    if (newer === "success") h.requests[1].resolve(current);
    else if (newer === "failure") h.requests[1].reject(new Error("Current failure"));
    await flush();
    const before = snapshot(h);
    if (older === "success") h.requests[0].resolve(info());
    else h.requests[0].reject(new Error("Stale failure"));
    await flush();
    expect(snapshot(h)).toEqual(before);
    if (newer === "failure") {
      expectUnknown(h);
      expect(h.list.textContent).toContain("Current failure");
    } else {
      if (newer === "pending") { expectUnknown(h); h.requests[1].resolve(current); await flush(); }
      expectValid(h, current);
      expect(h.list.querySelector(".profile-card")?.dataset.dirId).toBe("current");
    }
  });

  it("keeps escaped profile markup, localized labels and contained delegated cache actions", async () => {
    const h = harness({ "profile.card.chromium": "Fixture Chromium", "storage.col.size": "Fixture size", "storage.col.modified": "Fixture modified", "storage.action.clear-cache": "Fixture clear" });
    const profile = { dirId: 'fixture-" onmouseover="bad\'<&', name: '<img src=x onerror="bad"> & "Profile"', sizeBytes: 128, lastModified: 1 };
    h.app.loadStorage(); h.requests[0].resolve(info({ profiles: [profile] })); await flush();
    expect(h.list.innerHTML).toContain(escape(profile.name));
    expect(h.list.innerHTML).toContain('data-dir-id="' + escape(profile.dirId) + '"');
    expect(h.list.querySelector("img")).toBeNull();
    const card = h.list.querySelector(".profile-card")!;
    expect(card.dataset.dirId).toBe(profile.dirId);
    expect(card.textContent).toContain(profile.name);
    for (const label of ["Fixture Chromium", "Fixture size", "Fixture modified", "Fixture relative time", "128 bytes"]) expect(card.textContent).toContain(label);
    const button = card.querySelector('[data-action="clear-cache"]')!;
    expect(button.textContent).toBe("Fixture clear");
    card.querySelector(".name")!.click();
    const outside = new Element("button"); outside.setAttribute("data-action", "clear-cache");
    h.list.onclick?.({ target: outside });
    expect(h.api.storage.clearCache).not.toHaveBeenCalled();
    button.appendChild(new Element("span")).click(); await flush();
    expect(h.api.storage.clearCache).toHaveBeenCalledExactlyOnceWith(profile.dirId);
    expect(h.helpers.toast).toHaveBeenCalledWith("Fixture cache cleared", "success");
    expect(h.api.storage.info).toHaveBeenCalledTimes(2);
    expectUnknown(h);
    h.requests[1].resolve(info({ profiles: [] })); await flush();
    expectValid(h, info());
    h.list.onclick?.({ target: button });
    expect(h.api.storage.clearCache).toHaveBeenCalledTimes(1);
  });

  it("keeps existing loading, empty and error/retry translations", async () => {
    const h = harness({ "common.loading": "Fixture loading", "storage.empty": "Fixture empty", "profiles.new": "Fixture create", "common.retry": "Fixture retry" });
    h.app.loadStorage();
    expect(h.list.textContent).toBe("Fixture loading");
    h.requests[0].resolve(info({ profiles: [] })); await flush();
    expect(h.list.textContent).toContain("Fixture empty");
    expect(h.list.querySelector('[data-cmd="newProfile"]')?.textContent).toBe("Fixture create");
    h.app.loadStorage(); h.requests[1].reject(new Error("Fixture capacity error")); await flush();
    expect(h.list.querySelector('[data-cmd="loadStorage"]')?.textContent).toBe("Fixture retry");
  });

  it("leaves clear-all-cache arguments and refresh behavior unchanged", async () => {
    const h = harness();
    await h.app.clearAllCaches(); await flush();
    expect(h.api.storage.clearCache).toHaveBeenCalledExactlyOnceWith();
    expect(h.helpers.toast).toHaveBeenCalledWith("Fixture cache cleared", "success");
    expect(h.api.storage.info).toHaveBeenCalledTimes(1);
    h.requests[0].resolve(info()); await flush();
    expectValid(h, info());
  });
});
