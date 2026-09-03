// Sandboxed custom-js runtime — replaces the old `new Function(jsCode)` eval
// that ran ARBITRARY code with full Node access in the Electron main process.
//
// Threat model (R2 #48, R3 #53, R4): `vm` is NOT a security boundary — assume
// the script is hostile. Verified escapes before these fixes:
//   1. logger.constructor.constructor = HOST Function -> getBuiltinModule RCE.
//   2. host-bound timers in the context -> setTimeout.constructor host compile.
//   3. bootstrap top-level `var` aliases (__rawTimers etc.) persist as sandbox
//      globals pointing at host callables (delete missed the aliases).
//   4. timer wrappers returning raw host Timeout objects (t.constructor escape).
//
// Hardening (all four closed; each verified live pre/post fix):
//  1. codeGeneration { strings:false, wasm:false } on the context.
//  2. Bootstrap wrapped in an IIFE — NO top-level `var` survives as a global.
//     Bridge values (__bridgeLog/__stringify/__envJson/__timers) are consumed
//     inside the IIFE and deleted from the context afterwards.
//  3. Guest-visible timers/console/logger/env are sandbox-realm closures built
//     inside the bootstrap IIFE — their .constructor is the sandbox Function.
//  4. Timer handles are NUMERIC ids via a host-side Map (never host objects).
//  5. No async import callback — dynamic import() rejects.
//  6. Reachable intrinsics frozen from inside the sandbox realm.
// The caller's wall-clock timeout (JobGuard/withTimeout) still bounds pending
// promises, so setTimeout/Promise are provided for compatibility.
import * as vm from "node:vm";

export interface SandboxContext {
  logger?: (msg: string) => void;
  /** Extra read-only values exposed to the script (e.g. vars). */
  env?: Record<string, unknown>;
}

/** Handle to a finished sandbox evaluation: dispositions repeating timers. */
export interface SandboxHandle {
  result: unknown;
  /** Clear all pending interval timers created by this evaluation. */
  dispose(): void;
  /** Number of interval timers still pending. */
  pendingIntervals(): number;
}

/**
 * Run user JS in a locked-down sandbox. Returns the script's return value
 * (or a Promise if it returns one). Throws on syntax errors, synchronous
 * runtime errors, or a synchronous-loop timeout.
 */
export function runSandboxed(code: string, ctx: SandboxContext = {}, timeoutMs = 30_000): unknown {
  if (typeof code !== "string" || code.trim() === "") throw new Error("empty script");
  const hostLogger = typeof ctx.logger === "function" ? ctx.logger : () => {};
  // Raw host timers live ONLY as closure locals of this module function —
  // never as context properties, never named in sandbox-global scope.
  const rawSetTimeout = setTimeout.bind(globalThis);
  const rawClearTimeout = clearTimeout.bind(globalThis);
  const rawSetInterval = setInterval.bind(globalThis);
  const rawClearInterval = clearInterval.bind(globalThis);
  const rawQueueMicrotask = queueMicrotask.bind(globalThis);
  // Numeric timer handles: guest can never touch a host Timeout object.
  // Repeating vs one-shot are tracked separately so dispose() (R6 #72) can
  // clear intervals without killing a pending one-shot the caller awaits.
  let timerSeq = 0;
  const timers = new Map<number, unknown>();
  const intervals = new Map<number, unknown>();
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  // Everything inside ONE IIFE: no top-level var can leak as a sandbox
  // global (R4 fix - the previous top-level var aliases survived
  // delete and re-exposed host callables to guest code).
  const bootstrap = `
    "use strict";
    (function(__bridgeLog, __stringify, __envJson, __timers) {
      // NOTE: runs in strict mode, so bare this is undefined. The sandbox
      // global IS the context object; globalThis resolves to it from inside.
      var self = globalThis;
      function stringifyArgs(args) {
        return Array.prototype.slice.call(args).map(function(a) { return __stringify(a); });
      }
      function hostLog(parts) { return __bridgeLog(parts); }
      // Sandbox-realm wrappers: .constructor is the sandbox Function (string
      // compilation disabled by the context's codeGeneration lock).
      function setTimeout(fn, ms) {
        if (typeof fn !== "function") throw new TypeError("setTimeout callback must be a function");
        return __timers.setTimeout(fn, ms);
      }
      function clearTimeout(id) { return __timers.clearTimeout(id); }
      function setInterval(fn, ms) {
        if (typeof fn !== "function") throw new TypeError("setInterval callback must be a function");
        return __timers.setInterval(fn, ms);
      }
      function clearInterval(id) { return __timers.clearInterval(id); }
      function queueMicrotask(fn) {
        if (typeof fn !== "function") throw new TypeError("queueMicrotask callback must be a function");
        return __timers.queueMicrotask(fn);
      }
      self.setTimeout = setTimeout;
      self.clearTimeout = clearTimeout;
      self.setInterval = setInterval;
      self.clearInterval = clearInterval;
      self.queueMicrotask = queueMicrotask;
      self.console = {
        log: function() { return hostLog(stringifyArgs(arguments)); },
        warn: function() { return hostLog(["[warn]"].concat(stringifyArgs(arguments))); },
        error: function() { return hostLog(["[error]"].concat(stringifyArgs(arguments))); },
        info: function() { return hostLog(stringifyArgs(arguments)); },
      };
      self.logger = function() { return hostLog(stringifyArgs(arguments)); };
      self.env = __envJson ? JSON.parse(__envJson) : {};
      // Freeze reachable intrinsics so guest code cannot re-arm them.
      // NOTE: Promise itself is NOT frozen — freezing it breaks the
      // async/timer compat path (Promise capability + resolve functions).
      // The Function-constructor escape is already closed by
      // codeGeneration.strings=false, not by freezing.
      var roots = [Object, Object.prototype, Array, Array.prototype,
        Reflect, JSON, Math, Map, Set, WeakMap, WeakSet, Symbol];
      for (var __j = 0; __j < roots.length; __j++) {
        try { Object.freeze(roots[__j]); } catch (__e) {}
      }
    })(
      __bridgeLog,
      __stringify,
      __envJson,
      __timers
    );
  `;
  const stringify = (v: unknown): string => {
    try {
      return typeof v === "string" ? v : JSON.stringify(v);
    } catch { return String(v); }
  };
  (context as any).__bridgeLog = (parts: unknown[]) => {
    try { hostLogger(parts.map((p) => String(p)).join(" ")); } catch { /* ignore */ }
  };
  (context as any).__stringify = (v: unknown) => stringify(v);
  (context as any).__envJson = JSON.stringify(ctx.env || {});
  // Timer bridge: numeric ids only. Guest callbacks are invoked directly by
  // the host timer (a host->sandbox call, safe direction); the guest never
  // receives a host function or host object back. No extra runInContext
  // wrapper: the guest closure already carries its sandbox scope chain, and
  // an extra evaluate per tick only adds failure modes.
  (context as any).__timers = {
    setTimeout: (fn: (...a: unknown[]) => void, ms: unknown) => {
      const id = ++timerSeq;
      const invoke = () => {
        timers.delete(id);
        try { fn(); } catch { /* guest error in timer */ }
      };
      timers.set(id, rawSetTimeout(invoke, Number(ms) || 0));
      return id;
    },
    clearTimeout: (id: unknown) => {
      const h = timers.get(Number(id));
      if (h !== undefined) { timers.delete(Number(id)); rawClearTimeout(h as never); }
    },
    setInterval: (fn: (...a: unknown[]) => void, ms: unknown) => {
      const id = ++timerSeq;
      const invoke = () => {
        try { fn(); } catch { /* guest error in timer */ }
      };
      const handle = rawSetInterval(invoke, Number(ms) || 0);
      intervals.set(id, handle);
      trackSandboxInterval(id, handle);
      return id;
    },
    clearInterval: (id: unknown) => {
      const h = intervals.get(Number(id));
      if (h !== undefined) { intervals.delete(Number(id)); untrackSandboxInterval(Number(id)); rawClearInterval(h as never); }
    },
    queueMicrotask: (fn: () => void) => {
      rawQueueMicrotask(() => { try { fn(); } catch { /* ignore */ } });
    },
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
  // microtaskMode afterEvaluate: without it, a Promise resolved by a host
  // timer callback never settles its .then chain (the microtask checkpoint
  // only runs on evaluate return). Kept as a cast: the installed @types/node
  // predates the option, but the runtime honors it (verified live).
  //
  // Timer lifetime (R6 #72): the evaluation returns synchronously (possibly a
  // pending Promise), and one-shot host timers must be allowed to fire
  // afterwards — clearing everything in `finally` would kill every setTimeout
  // before it runs. One-shots self-remove on fire. INTERVALS repeat forever:
  // capture this evaluation's interval ids so the caller can dispose them.
  const result = vm.runInContext(wrapped, context, {
    filename: "automation-custom-js",
    timeout: Math.max(100, timeoutMs),
    microtaskMode: "afterEvaluate",
  } as vm.RunningCodeOptions);
  return result;
}

/**
 * runSandboxed + interval lifecycle (R6 #72). The caller MUST call dispose()
 * when the rule settles (or on timeout) so repeating timers cannot leak
 * across cron runs. One-shot timers self-remove on fire and need no action.
 *
 * Implemented via a shared interval ledger: runSandboxed records every
 * interval it creates; the handle snapshots the ledger at creation and
 * dispose() clears exactly this evaluation's intervals.
 */
const sandboxIntervalLedger: Array<{ id: number; handle: unknown }> = [];

function trackSandboxInterval(id: number, handle: unknown): void {
  sandboxIntervalLedger.push({ id, handle });
}

function untrackSandboxInterval(id: number): void {
  const i = sandboxIntervalLedger.findIndex((e) => e.id === id);
  if (i >= 0) sandboxIntervalLedger.splice(i, 1);
}

function clearSandboxIntervalById(id: number): void {
  const i = sandboxIntervalLedger.findIndex((e) => e.id === id);
  if (i < 0) return;
  const h = sandboxIntervalLedger[i].handle;
  sandboxIntervalLedger.splice(i, 1);
  try { clearInterval(h as never); } catch { /* ignore */ }
}

/** Test hook: how many intervals are currently tracked. */
export function _sandboxIntervalCountForTests(): number {
  return sandboxIntervalLedger.length;
}

export function runSandboxedWithHandle(
  code: string,
  ctx: SandboxContext = {},
  timeoutMs = 30_000,
): SandboxHandle {
  const before = new Set(sandboxIntervalLedger.map((e) => e.id));
  const result = runSandboxed(code, ctx, timeoutMs);
  const owned = new Set<number>();
  for (const e of sandboxIntervalLedger) if (!before.has(e.id)) owned.add(e.id);
  const dispose = () => {
    for (const id of owned) clearSandboxIntervalById(id);
    owned.clear();
  };
  const pendingIntervals = () => {
    let n = 0;
    for (const id of owned) {
      if (sandboxIntervalLedger.some((e) => e.id === id)) n++;
    }
    return n;
  };
  return { result, dispose, pendingIntervals };
}
