import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Only this repository source is read. The evaluated module receives NO real
// fs, Electron, process, require fallback, user data, or network capability.
const source = readFileSync(new URL("../../src/main/services/renderer-storage.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  transformers: { before: [context => root => ts.visitNode(root, function visit(node): ts.VisitResult<ts.Node> {
    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === "url") {
      return context.factory.createStringLiteral("file:///review-fixture/dist/main/services/renderer-storage.js");
    }
    return ts.visitEachChild(node, visit, context);
  }) as ts.SourceFile] },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

type Plan = { load?: () => Promise<unknown>; execute?: (script: string) => unknown; destroyThrows?: boolean };
function fixture(options: { marker?: boolean; legacy?: boolean; plans?: Plan[]; markerThrows?: boolean } = {}) {
  const legacy = { kind: "legacy" };
  const isolated = { kind: "isolated" };
  const legacyValues = new Map<string, string>([["agent-browser-studio-theme", "dark"], ["cloak-lite-language", "zh"]]);
  const uiValues = new Map<string, string>();
  const windows: any[] = [];
  const markerWrites: unknown[][] = [];
  const fs = {
    existsSync: vi.fn(() => options.marker === true),
    readdirSync: vi.fn(() => options.legacy === false ? ["LOCK"] : ["LOCK", "fixture.ldb"]),
    writeFileSync: vi.fn((...args: unknown[]) => {
      markerWrites.push(args);
      if (options.markerThrows) throw new Error("synthetic marker failure");
    }),
  };
  const fromPartition = vi.fn(() => isolated);
  class Window {
    destroyed = false;
    options: any;
    loadFile: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed = vi.fn(() => this.destroyed);
    webContents: { executeJavaScript: ReturnType<typeof vi.fn> };
    constructor(windowOptions: any) {
      this.options = windowOptions;
      const plan = options.plans?.[windows.length] || {};
      windows.push(this);
      this.loadFile = vi.fn(() => plan.load ? plan.load() : Promise.resolve());
      this.destroy = vi.fn(() => {
        if (plan.destroyThrows) throw new Error("synthetic destroy failure");
        this.destroyed = true;
      });
      this.webContents = { executeJavaScript: vi.fn((script: string) => {
        if (plan.execute) return Promise.resolve(plan.execute(script));
        const values = windowOptions.webPreferences.session === legacy ? legacyValues : uiValues;
        return Promise.resolve(vm.runInNewContext(script, { localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        } }));
      }) };
    }
  }
  const log = { warn: vi.fn(), error: vi.fn() };
  const modules: Record<string, unknown> = {
    "node:fs": fs, "node:path": path, "node:url": url,
    electron: { app: { getPath: vi.fn((name: string) => {
      if (name !== "userData") throw new Error(`Unexpected app path: ${name}`);
      return "/review-fixture/user-data";
    }) }, BrowserWindow: Window, session: { defaultSession: legacy, fromPartition } },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, { exports, console: log, setTimeout, clearTimeout,
    require(name: string) {
      if (!Object.hasOwn(modules, name)) throw new Error(`Forbidden import: ${name}`);
      return modules[name];
    },
  }, { filename: "renderer-storage.review.vm.cjs" });
  return { migrate: exports.migrateLegacyRendererStorage as (ms?: number) => Promise<void>,
    windows, fs, markerWrites, fromPartition, legacy, isolated, legacyValues, uiValues, log };
}

describe("renderer storage migration owns one bounded startup deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("skips marked storage without reading legacy storage or making a window", async () => {
    const f = fixture({ marker: true });
    await f.migrate();
    expect(f.fs.readdirSync).not.toHaveBeenCalled();
    expect(f.windows).toHaveLength(0);
    expect(f.markerWrites).toHaveLength(0);
  });

  it("marks a missing/LOCK-only legacy store with mode 0600 and no Electron work", async () => {
    const f = fixture({ legacy: false });
    await f.migrate();
    expect(f.windows).toHaveLength(0);
    expect(f.fromPartition).not.toHaveBeenCalled();
    expect(f.markerWrites).toEqual([["/review-fixture/user-data/.ui-storage-migrated-v1", "1\n", { mode: 0o600 }]]);
  });

  it("copies only the known UI keys before publishing the single marker", async () => {
    const f = fixture();
    f.legacyValues.set("not-a-ui-key", "must-not-copy");
    await f.migrate(1000);
    expect(Object.fromEntries(f.uiValues)).toEqual({ "agent-browser-studio-theme": "dark", "cloak-lite-language": "zh" });
    expect(f.windows).toHaveLength(2);
    expect(f.windows.every(w => w.destroyed)).toBe(true);
    expect(f.windows.map(w => w.options.webPreferences.session)).toEqual([f.legacy, f.isolated]);
    expect(f.windows.every(w => w.options.show === false && w.options.webPreferences.sandbox === true && w.options.webPreferences.contextIsolation === true)).toBe(true);
    expect(f.markerWrites).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it.each(["load", "execute"] as const)("bounds a hung legacy %s and fences its late continuation", async phase => {
    const held = deferred<any>();
    const f = fixture({ plans: [phase === "load" ? { load: () => held.promise } : { execute: () => held.promise }] });
    let settled = false;
    const running = f.migrate(1000).then(() => { settled = true; });
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(f.windows).toHaveLength(1);
    expect(f.windows[0].destroyed).toBe(true);
    expect(f.markerWrites).toHaveLength(1);
    expect(f.fromPartition).not.toHaveBeenCalled();
    const callsAtTimeout = f.windows[0].webContents.executeJavaScript.mock.calls.length;
    held.resolve(phase === "load" ? undefined : { "agent-browser-studio-theme": "late" });
    await flush();
    expect(f.windows).toHaveLength(1);
    expect(f.fromPartition).not.toHaveBeenCalled();
    expect(f.windows[0].webContents.executeJavaScript).toHaveBeenCalledTimes(callsAtTimeout);
    expect(f.markerWrites).toHaveLength(1);
    expect(f.uiValues.size).toBe(0);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  it.each(["load", "execute"] as const)("uses the remaining whole-operation budget for a hung writer %s", async phase => {
    const read = deferred<any>();
    const write = deferred<any>();
    const f = fixture({ plans: [{ execute: () => read.promise }, phase === "load" ? { load: () => write.promise } : { execute: () => write.promise }] });
    let settled = false;
    const running = f.migrate(1000).then(() => { settled = true; });
    await flush();
    await vi.advanceTimersByTimeAsync(700);
    read.resolve({ "agent-browser-studio-theme": "dark" });
    await flush();
    expect(f.windows).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(f.windows.every(w => w.destroyed)).toBe(true);
    const dispatched = f.windows[1].webContents.executeJavaScript.mock.calls.length;
    write.resolve(undefined);
    await flush();
    expect(f.windows[1].webContents.executeJavaScript).toHaveBeenCalledTimes(dispatched);
    expect(f.markerWrites).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // An already-dispatched writer cannot be rolled back by this timeout.
    if (phase === "load") expect(dispatched).toBe(0);
  });

  it.each(["load", "execute"] as const)("contains a rejected legacy %s and retains marker-on-failure policy", async phase => {
    const fail = () => Promise.reject(new Error("synthetic storage failure"));
    const f = fixture({ plans: [phase === "load" ? { load: fail } : { execute: fail }] });
    await f.migrate(1000);
    expect(f.windows[0].destroyed).toBe(true);
    expect(f.fromPartition).not.toHaveBeenCalled();
    expect(f.markerWrites).toHaveLength(1);
    expect(f.log.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains late rejection after timeout without a second failure marker", async () => {
    const held = deferred<any>();
    const f = fixture({ plans: [{ execute: () => held.promise }] });
    const running = f.migrate(100);
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await running;
    held.reject(new Error("late synthetic rejection"));
    await flush();
    expect(f.markerWrites).toHaveLength(1);
    expect(f.fromPartition).not.toHaveBeenCalled();
    expect(f.log.error).not.toHaveBeenCalled();
  });

  it("fences late work even if owned-window destroy throws", async () => {
    const held = deferred<any>();
    const f = fixture({ plans: [{ load: () => held.promise, destroyThrows: true }] });
    const running = f.migrate(100);
    await vi.advanceTimersByTimeAsync(100);
    await running;
    held.resolve(undefined);
    await flush();
    expect(f.windows[0].destroy).toHaveBeenCalled();
    expect(f.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(f.fromPartition).not.toHaveBeenCalled();
    expect(f.markerWrites).toHaveLength(1);
  });

  it("does not turn best-effort marker failure into a startup rejection", async () => {
    const f = fixture({ legacy: false, markerThrows: true });
    await expect(f.migrate()).resolves.toBeUndefined();
    expect(f.markerWrites).toHaveLength(1);
  });
});
