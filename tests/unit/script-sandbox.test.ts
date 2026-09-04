import { describe, it, expect } from "vitest";
import { runSandboxed } from "../../src/main/services/script-sandbox.js";

describe("script-sandbox", () => {
  it("returns a plain value", () => {
    expect(runSandboxed("return 'ok';")).toBe("ok");
    expect(runSandboxed("return 1 + 2;")).toBe(3);
  });

  it("can use Promise + setTimeout (compat with existing rules)", async () => {
    const r = await Promise.resolve(runSandboxed("return new Promise(function(res){ setTimeout(function(){ res('done'); }, 5); });"));
    expect(r).toBe("done");
  });

  it("routes console.log to the injected logger", () => {
    const logs: string[] = [];
    runSandboxed("console.log('hello', 42); return 1;", { logger: (m) => logs.push(m) });
    expect(logs[0]).toContain("hello");
    expect(logs[0]).toContain("42");
  });

  it("exposes injected env values read-only-ish", () => {
    const r = runSandboxed("return env.foo + '_' + env.bar;", { env: { foo: "a", bar: "b" } });
    expect(r).toBe("a_b");
  });

  it("BLOCKS access to require (no module escape)", () => {
    expect(() => runSandboxed("return require('fs');")).toThrow();
  });

  it("BLOCKS access to process", () => {
    expect(() => runSandboxed("return process.env;")).toThrow();
  });

  it("BLOCKS access to the global object / main-thread globals", () => {
    // In a fresh vm context, globalThis is the sandbox — process is unreachable
    // (undefined), proving no escape to the Node main global.
    expect(runSandboxed("return typeof globalThis.process;")).toBe("undefined");
    expect(runSandboxed("return typeof globalThis.require;")).toBe("undefined");
  });

  it("kills a synchronous infinite loop via the timeout", () => {
    expect(() => runSandboxed("while(true){}", {}, 200)).toThrow();
  });

  it("BLOCKS the host-Function-constructor RCE path (R2 #48)", () => {
    // Before the fix: logger.constructor.constructor compiled in the HOST
    // realm, and process.getBuiltinModule('child_process') gave RCE.
    expect(() => runSandboxed("return logger.constructor.constructor('return 1')();")).toThrow();
    expect(() => runSandboxed("return [].map.constructor('return 1')();")).toThrow();
    expect(() => runSandboxed("return Function('return 1')();")).toThrow();
    expect(() => runSandboxed("return new Function('return 1')();")).toThrow();
    expect(() => runSandboxed("return typeof WebAssembly;")).not.toThrow();
  });

  it("BLOCKS the RCE payload end-to-end (getBuiltinModule path)", () => {
    // The exact pre-fix exploit: host-realm Function + getBuiltinModule.
    // codeGeneration.strings=false makes the compilation itself throw.
    expect(() => runSandboxed(
      "return logger.constructor.constructor('return process.getBuiltinModule(\"child_process\").execSync(\"echo PWNED\").toString()')();",
    )).toThrow(/code generation|disallowed/i);
  });

  it("BLOCKS the host-timer constructor path (R3: setTimeout was host-bound)", () => {
    // Round-3 regression: timers were host-realm functions, so
    // setTimeout.constructor compiled in the host realm. Timers are now
    // sandbox-realm wrappers; string compilation throws.
    expect(() => runSandboxed("return setTimeout.constructor('return 42')();")).toThrow(/code generation|disallowed/i);
    expect(() => runSandboxed(
      "return setTimeout.constructor('return process.getBuiltinModule(\"child_process\").execSync(\"echo PWNED\").toString()')();",
    )).toThrow(/code generation|disallowed/i);
    expect(() => runSandboxed("return queueMicrotask.constructor('return 1')();")).toThrow(/code generation|disallowed/i);
  });

  it("tracks intervals via handle and dispose() clears them (R6 #72)", async () => {
    const { runSandboxedWithHandle, _sandboxIntervalCountForTests } = await import("../../src/main/services/script-sandbox.js");
    const before = _sandboxIntervalCountForTests();
    const handle = runSandboxedWithHandle("setInterval(function(){}, 50); setInterval(function(){}, 50); return 'ok';", {}, 1000);
    expect(handle.result).toBe("ok");
    expect(handle.pendingIntervals()).toBe(2);
    expect(_sandboxIntervalCountForTests()).toBe(before + 2);
    handle.dispose();
    expect(handle.pendingIntervals()).toBe(0);
    expect(_sandboxIntervalCountForTests()).toBe(before);
  });

  it("throws on empty script", () => {
    expect(() => runSandboxed("   ")).toThrow(/empty/i);
  });

  it("propagates a thrown error", () => {
    expect(() => runSandboxed("throw new Error('boom-sentinel');")).toThrow(/boom-sentinel/);
  });
});
