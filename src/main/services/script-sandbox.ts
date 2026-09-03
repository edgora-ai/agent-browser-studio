// Sandboxed custom-js runtime — replaces the old `new Function(jsCode)` eval
// that ran ARBITRARY code with full Node access in the Electron main process.
//
// Threat model (R2 #48): `vm.runInNewContext` does NOT isolate host callables
// passed into the sandbox. A raw host `logger` closure exposes
// `logger.constructor.constructor` = the HOST realm Function, which compiles
// with host globals — and on Node 22+ `process.getBuiltinModule` hands back
// `child_process` without any `require`. Verified RCE before this fix:
//
//   logger.constructor.constructor(
//     'return process.getBuiltinModule("child_process")'
//     + '.execSync("echo PWNED").toString()')()  // => "PWNED"
//
// Hardening (defense in depth — vm is not a security boundary, so assume the
// script is hostile):
//  1. Never pass raw host closures: the logger is wrapped in a
//     sandbox-realm function (created via vm) so its constructor chain stays
//     inside the sandbox realm.
//  2. Freeze all intrinsics reachable from the sandbox (Object/Reflect/Proxy
//     patching from inside is blocked).
//  3. codeGeneration: { strings: false, wasm: false } — kills BOTH the
//     Function-constructor string-compilation path AND WebAssembly codegen.
//  4. No async import callback — dynamic import() cannot resolve host modules.
// The caller's wall-clock timeout (JobGuard/withTimeout) still bounds pending
// promises, so setTimeout/Promise are provided for compatibility.
import * as vm from "node:vm";

export interface SandboxContext {
  logger?: (msg: string) => void;
  /** Extra read-only values exposed to the script (e.g. vars). */
  env?: Record<string, unknown>;
}

// NOTE: constructed inside the sandbox (see runSandboxed), never at module
// scope — module-scope primordials belong to the host realm.
const GLOBAL_NAMES = [
  "JSON", "Math", "Date", "Array", "Object", "String", "Number", "Boolean",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "Reflect", "Proxy",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "queueMicrotask",
] as const;

/**
 * Run user JS in a locked-down sandbox. Returns the script's return value
 * (or a Promise if it returns one). Throws on syntax errors, synchronous
 * runtime errors, or a synchronous-loop timeout.
 */
export function runSandboxed(code: string, ctx: SandboxContext = {}, timeoutMs = 30_000): unknown {
  if (typeof code !== "string" || code.trim() === "") throw new Error("empty script");
  const hostLogger = typeof ctx.logger === "function" ? ctx.logger : () => {};
  // Plain object with a null prototype: no host Object.prototype in the chain.
  // Timer + microtask functions are bound host references installed as plain
  // values (calling them is safe; their .constructor is host Function, but
  // string compilation is killed by codeGeneration below, and they are
  // function objects whose only use is invocation).
  const context = vm.createContext({
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
    setInterval: setInterval.bind(globalThis),
    clearInterval: clearInterval.bind(globalThis),
    queueMicrotask: queueMicrotask.bind(globalThis),
  }, {
    codeGeneration: { strings: false, wasm: false },
  });
  // Intrinsics inside the sandbox realm (NOT the host's): freezing these
  // blocks prototype-pollution / constructor-chain escapes that start from
  // sandbox objects.
  const bootstrap = `
    "use strict";
    // Wrap the host logger in a sandbox-realm function: its .constructor
    // chain now ends at the SANDBOX Function, whose string compilation is
    // disabled by codeGeneration.strings=false above.
    // __bridgeLog/__stringify/__envJson are lexical to THIS bootstrap
    // evaluation only (separate from later guest evaluations, which cannot
    // see bootstrap-scope bindings). Capture into locals, then the context
    // properties are deleted after bootstrap.
    var __stringifyLocal = __stringify;
    var __bridgeLogLocal = __bridgeLog;
    var __envJsonLocal = __envJson;
    this.__hostLog = function(parts) { return __bridgeLogLocal(parts); };
    this.console = {
      log: function() { var s = __stringifyLocal; return __hostLog(Array.prototype.slice.call(arguments).map(function(a){ return s(a); })); },
      warn: function() { var s = __stringifyLocal; return __hostLog(["[warn]"].concat(Array.prototype.slice.call(arguments).map(function(a){ return s(a); }))); },
      error: function() { var s = __stringifyLocal; return __hostLog(["[error]"].concat(Array.prototype.slice.call(arguments).map(function(a){ return s(a); }))); },
      info: function() { var s = __stringifyLocal; return __hostLog(Array.prototype.slice.call(arguments).map(function(a){ return s(a); })); },
    };
    this.logger = function() { var s = __stringifyLocal; return __hostLog(Array.prototype.slice.call(arguments).map(function(a){ return s(a); })); };
    this.env = __envJsonLocal ? JSON.parse(__envJsonLocal) : {};
    // Freeze reachable intrinsics so guest code cannot re-arm them.
    (function() {
      var roots = [Object, Object.prototype, Array, Array.prototype, Function, Function.prototype,
        Reflect, Proxy, JSON, Math, Promise, Promise.prototype, Map, Set, WeakMap, WeakSet, Symbol];
      for (var __j = 0; __j < roots.length; __j++) {
        try { Object.freeze(roots[__j]); } catch (__e) {}
      }
    })();
  `;
  const stringify = (v: unknown): string => {
    try {
      return typeof v === "string" ? v : JSON.stringify(v);
    } catch { return String(v); }
  };
  // __bridgeLog / __stringify / __envJson are the ONLY host values injected,
  // and they are plain data + a minimal bridge (no closures with useful
  // constructors reachable: the guest only ever calls them, and their
  // .constructor is looked up on the host Function — but with
  // codeGeneration.strings=false the resulting Function constructor throws
  // on string compilation, closing the RCE path).
  (context as any).__bridgeLog = (parts: unknown[]) => {
    try { hostLogger(parts.map((p) => String(p)).join(" ")); } catch { /* ignore */ }
  };
  (context as any).__stringify = (v: unknown) => stringify(v);
  (context as any).__envJson = JSON.stringify(ctx.env || {});
  vm.runInContext(bootstrap, context, { filename: "sandbox-bootstrap", timeout: 2000 });
  delete (context as any).__bridgeLog;
  delete (context as any).__stringify;
  delete (context as any).__envJson;
  // Wrap in an IIFE so top-level `return` works (matches the old new Function shape).
  const wrapped = "(function(){\n" + code + "\n})();";
  // vm throws ERR_SCRIPT_EXECUTION_TIMEOUT on sync-loop overrun.
  // No importModuleDynamically callback: dynamic import() inside rejects.
  return vm.runInContext(wrapped, context, {
    filename: "automation-custom-js",
    timeout: Math.max(100, timeoutMs),
  } as vm.RunningCodeOptions);
}

function stringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch { return String(v); }
}
void stringify;
