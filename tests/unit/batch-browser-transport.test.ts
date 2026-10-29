import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";

// Complete production queue and IPC batch handlers. No Electron, app graph,
// real timers, launch/process/network effects, config writes, or user data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function parse(file: string) { return ts.createSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true); }
function evaluate(context: any, text: string) {
  const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  expect(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  runInContext(result.outputText, context, { timeout: 1000 });
}
function deferred<T = any>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
function fixture() {
  const handlers = new Map<string, any>(), pending: Array<ReturnType<typeof deferred> & { settled: boolean }> = [];
  let active = 0, maxActive = 0;
  const c: any = createContext({ exports: {}, Error, Date, setTimeout, clearTimeout,
    newTraceId: () => "synthetic-batch", recordCounter: vi.fn(), recordTiming: vi.fn(), obsLog: vi.fn(), logInfo: vi.fn(),
    getConfig: () => ({}), validateDirId: vi.fn(), stopBrowser: vi.fn(() => true),
    handleBrowser: (name: string, handler: any) => handlers.set(name, handler),
    gatedLaunch: vi.fn(() => {
      active++; maxActive = Math.max(maxActive, active); const item = { ...deferred(), settled: false }; pending.push(item);
      return item.promise.finally(() => { active--; item.settled = true; });
    }),
  });
  const queue = parse("src/main/services/batch-queue.ts");
  evaluate(c, queue.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(queue)).join("\n"));
  c.runBatch = vi.fn(c.runBatch);
  const ipc = parse("src/main/ipc/browser.ts"), selected: string[] = [];
  const functions = new Set(["profileName", "emitProgress", "runBrowserBatch"]);
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && functions.has(node.name.text)) { selected.push(node.getText(ipc)); return; }
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "activeBatchJobs")) {
      selected.push(node.getText(ipc)); return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (ts.isIdentifier(call.expression) && call.expression.text === "handleBrowser" && ts.isStringLiteral(call.arguments[0]) &&
          ["batch-launch", "batch-stop", "batch-cancel"].includes(call.arguments[0].text)) { selected.push(node.getText(ipc)); return; }
    }
    ts.forEachChild(node, visit);
  }
  visit(ipc); expect(selected).toHaveLength(7); evaluate(c, selected.join("\n"));
  const sender: any = new EventEmitter(); sender.isDestroyed = () => false; sender.send = vi.fn();
  return { c, handlers, pending, sender, active: () => active, maxActive: () => maxActive,
    finishActive: () => { for (const item of pending.filter(item => !item.settled)) item.resolve({ pid: 100, cdpPort: 9001 }); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("uncancellable browser launches keep real queue occupancy", () => {
  it.each([1, 2, 3])("never exceeds %i active launches even after the generic 20s timeout", async concurrency => {
    const f = fixture(), ids = Array.from({ length: 7 }, (_, index) => "synthetic-" + index);
    const result = f.handlers.get("batch-launch")({ sender: f.sender }, { dirIds: ids, concurrency, jobId: "bounded" });
    await flush(); expect(f.active()).toBe(concurrency); expect(f.c.runBatch.mock.calls[0][0].timeoutMs).toBe(0);
    for (let wave = 0; wave < Math.ceil(ids.length / concurrency); wave++) {
      const started = f.c.gatedLaunch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.c.gatedLaunch).toHaveBeenCalledTimes(started); expect(f.active()).toBeLessThanOrEqual(concurrency);
      f.finishActive(); await flush();
    }
    expect(await result).toMatchObject({ total: 7, succeeded: 7, failed: 0, cancelled: false });
    expect(f.maxActive()).toBe(concurrency); expect(f.active()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancellation skips queued starts but cannot pretend an active launch settled", async () => {
    const f = fixture(); let settled = false;
    const result = f.handlers.get("batch-launch")({ sender: f.sender }, { dirIds: ["a", "b", "c", "d"], concurrency: 2, jobId: "cancel" });
    result.then(() => { settled = true; }); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.c.gatedLaunch).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
    expect(await f.handlers.get("batch-cancel")({ sender: {} }, "cancel")).toMatchObject({ success: false });
    expect(await f.handlers.get("batch-cancel")({ sender: f.sender }, "cancel")).toEqual({ success: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(settled).toBe(false); expect(f.active()).toBe(2);
    f.finishActive(); const summary = await result;
    expect(summary).toMatchObject({ cancelled: true, succeeded: 2, failed: 2 });
    expect(summary.results.slice(2).every((item: any) => item.error === "Cancelled")).toBe(true);
    expect(f.c.gatedLaunch).toHaveBeenCalledTimes(2); expect(f.sender.listenerCount("destroyed")).toBe(0);
  });
  it("renderer destruction also cancels only queued work", async () => {
    const f = fixture(); const result = f.handlers.get("batch-launch")({ sender: f.sender }, { dirIds: ["a", "b"], concurrency: 1 });
    await flush(); f.sender.emit("destroyed"); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.c.gatedLaunch).toHaveBeenCalledTimes(1); expect(f.active()).toBe(1);
    f.finishActive(); expect(await result).toMatchObject({ cancelled: true, succeeded: 1, failed: 1 });
  });
  it("retains the normal timeout policy outside launch jobs", async () => {
    const f = fixture();
    await f.handlers.get("batch-stop")({ sender: f.sender }, { dirIds: ["a"], concurrency: 1 });
    expect(f.c.runBatch.mock.calls[0][0].timeoutMs).toBeUndefined();
    const pending = deferred(), result = f.c.runBatch({ items: ["normal"], worker: () => pending.promise, concurrency: 1 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ succeeded: 0, failed: 1 });
    pending.resolve(undefined); await flush(); expect(vi.getTimerCount()).toBe(0);
  });
});
