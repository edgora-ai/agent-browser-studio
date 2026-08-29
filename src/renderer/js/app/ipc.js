/**
 * Unified IPC wrapper for the renderer (review item TE-03).
 *
 * Before this module every call site did `api.x.y().then(...).catch(...)` with
 * no timeout, no trace id and no dedupe: if the main process hung, the button
 * stayed clickable and the UI sat there forever with no feedback.
 *
 * Guarantees:
 * - every call has a hard timeout drawn from a per-kind budget table;
 * - every call gets a traceId that is echoed to the log so a UI action can be
 *   joined to the main-process work it triggered;
 * - `dedupe: true` collapses repeat clicks on the same key into one IPC call;
 * - duration + outcome are recorded locally (never uploaded).
 */
(function () {
  "use strict";

  var api = window.agentBrowserAPI;

  // Per-kind timeout budget (TE-08 performance budget, ms).
  var TIMEOUTS = {
    launch: 30000,
    stop: 10000,
    detect: 20000,
    list: 5000,
    write: 15000,
    default: 15000,
  };

  var inflight = Object.create(null);
  var busyKeys = Object.create(null);
  var seq = 0;

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  /** Same shape as the main-process generator so ids join across processes. */
  function newTraceId() {
    seq = (seq + 1) % 0xffff;
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "-" + seq.toString(36);
  }

  function withTimeout(promise, ms, label, traceId) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var err = new Error(label + " timed out after " + Math.round(ms / 1000) + "s");
        err.code = "IPC_TIMEOUT";
        err.traceId = traceId;
        reject(err);
      }, ms);
      function done(fn) {
        return function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
      }
      promise.then(done(resolve), done(reject));
    });
  }

  // Observability writes are fire-and-forget and deliberately bypass this
  // wrapper: wrapping them would let a slow metrics call time out recursively.
  function report(kind, key, traceId, durationMs, ok, error) {
    if (!api || !api.observability) return;
    try {
      api.observability.timing("ipc." + key, durationMs).catch(function () {});
      api.observability.counter("ipc." + key + (ok ? ".success" : ".failure")).catch(function () {});
      if (!ok) {
        api.observability.log("error", "ipc.failed", {
          traceId: traceId,
          key: key,
          kind: kind,
          durationMs: durationMs,
          error: String((error && error.message) || error || ""),
        }).catch(function () {});
      }
    } catch (e) {
      /* observability must never break the caller */
    }
  }

  /**
   * Run an IPC call with timeout + trace + optional dedupe.
   *
   * @param {string} key        stable identifier, e.g. "browser.launch"
   * @param {Function} fn       () => Promise
   * @param {Object}   opts     { kind, timeoutMs, dedupe, traceId }
   */
  function call(key, fn, opts) {
    opts = opts || {};
    var kind = opts.kind || "default";
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : (TIMEOUTS[kind] || TIMEOUTS.default);
    var traceId = opts.traceId || newTraceId();

    // Dedupe: a second click while the first call is still in flight returns
    // the original promise instead of firing another IPC round trip.
    if (opts.dedupe && inflight[key]) return inflight[key];

    var started = now();
    busyKeys[key] = true;

    var promise = withTimeout(
      Promise.resolve().then(fn),
      timeoutMs,
      key,
      traceId,
    ).then(function (value) {
      report(kind, key, traceId, Math.round(now() - started), true, null);
      return value;
    }, function (error) {
      if (error && !error.traceId) error.traceId = traceId;
      report(kind, key, traceId, Math.round(now() - started), false, error);
      throw error;
    }).then(function (value) {
      cleanup(key);
      return value;
    }, function (error) {
      cleanup(key);
      throw error;
    });

    if (opts.dedupe) inflight[key] = promise;
    return promise;
  }

  function cleanup(key) {
    delete busyKeys[key];
    delete inflight[key];
  }

  /** True while a deduped call for this key is still in flight. */
  function isBusy(key) {
    return busyKeys[key] === true;
  }

  window.agentBrowser = window.agentBrowser || {};
  window.agentBrowser.ipc = {
    call: call,
    isBusy: isBusy,
    newTraceId: newTraceId,
    TIMEOUTS: TIMEOUTS,
    _inflightCount: function () { return Object.keys(inflight).length; },
  };
})();
