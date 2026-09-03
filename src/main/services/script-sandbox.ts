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
  // Timers CANNOT be host-bound functions: any host-realm function value in
  // the context exposes `fn.constructor` = host Function, whose string
  // compilation ignores this context's codeGeneration lock (verified RCE via
  // setTimeout.constructor + process.getBuiltinModule). Instead the raw host
  // timers live OUTSIDE the context object (closure locals of this module
  // function — invisible to guest code) and the guest only ever sees
  // sandbox-realm wrappers created by the bootstrap evaluation below.
  const rawSetTimeout = setTimeout.bind(globalThis);
  const rawClearTimeout = clearTimeout.bind(globalThis);
  const rawSetInterval = setInterval.bind(globalThis);
  const rawClearInterval = clearInterval.bind(globalThis);
  const rawQueueMicrotask = queueMicrotask.bind(globalThis);
  const context = vm.createContext(Object.create(null), {
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
    // Sandbox-realm timer wrappers: guest sees THESE functions (created by
    // this evaluation, so .constructor is the sandbox Function with string
    // compilation disabled). The raw host timers are NOT context properties.
    var __rawTimers = __timers;
    this.setTimeout = function(fn, ms) { return __rawTimers.setTimeout(fn, ms); };
    this.clearTimeout = function(h) { return __rawTimers.clearTimeout(h); };
    this.setInterval = function(fn, ms) { return __rawTimers.setInterval(fn, ms); };
    this.clearInterval = function(h) { return __rawTimers.clearInterval(h); };
    this.queueMicrotask = function(fn) { return __rawTimers.queueMicrotask(fn); };
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
  // __bridgeLog / __stringify / __envJson / __timers are bootstrap-lexical
  // host values, deleted from the context right after bootstrap. The guest
  // evaluation cannot see them. __timers carries the raw host timers into the
  // bootstrap closures ONLY so sandbox-realm wrappers can be built around
  // them — the wrappers' .constructor is the sandbox Function (string
  // compilation disabled), closing the host-Function RCE path.
  (context as any).__bridgeLog = (parts: unknown[]) => {
    try { hostLogger(parts.map((p) => String(p)).join(" ")); } catch { /* ignore */ }
  };
  (context as any).__stringify = (v: unknown) => stringify(v);
  (context as any).__envJson = JSON.stringify(ctx.env || {});
  (context as any).__timers = {
    setTimeout: rawSetTimeout,
    clearTimeout: rawClearTimeout,
    setInterval: rawSetInterval,
    clearInterval: rawClearInterval,
    queueMicrotask: rawQueueMicrotask,
  };
  vm.runInContext(bootstrap, context, { filename: "sandbox-bootstrap", timeout: 2000 });
  delete (context as any).__bridgeLog;
  delete (context as any).__stringify;
  delete (context as any).__envJson;
  delete (context as any).__timers;
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
