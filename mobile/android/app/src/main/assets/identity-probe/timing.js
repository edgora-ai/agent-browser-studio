(function (root) {
  'use strict';

  function budget(realm, milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError();
    const performance = realm.performance;
    const now = performance && typeof performance.now === 'function'
      ? performance.now.bind(performance) : realm.Date.now.bind(realm.Date);
    let previous = now();
    if (!Number.isFinite(previous)) throw new TypeError();
    const end = previous + milliseconds;
    function remaining() {
      const current = now();
      if (!Number.isFinite(current) || current < previous) throw new TypeError();
      previous = current;
      return Math.max(0, end - current);
    }
    return Object.freeze({ remaining, expired: () => remaining() === 0 });
  }

  // Recheck the clock on settlement: a queued message cannot beat an overdue timer.
  // Rejections, including late ones after a timeout, always have a handler.
  function within(realm, milliseconds, operation, codes = {}) {
    const timeoutCode = codes.timeout || 'DEADLINE_EXCEEDED';
    const errorCode = codes.error || 'INTERNAL_ERROR';
    return new Promise((resolve) => {
      let clock;
      let timer;
      let settled = false;
      try {
        clock = budget(realm, milliseconds);
      } catch (error) {
        resolve({ ok: false, code: 'CLOCK_FAILED' });
        return;
      }
      function finish(ok, value, code) {
        if (settled) return;
        try {
          if (clock.expired()) {
            ok = false;
            code = timeoutCode;
          }
        } catch (error) {
          ok = false;
          code = 'CLOCK_FAILED';
        }
        try {
          if (timer !== undefined) realm.clearTimeout(timer);
        } catch (error) {
          ok = false;
          code = 'CLOCK_FAILED';
        }
        settled = true;
        resolve(ok ? { ok: true, value } : { ok: false, code });
      }
      try {
        timer = realm.setTimeout(() => finish(false, undefined, timeoutCode), milliseconds);
      } catch (error) {
        finish(false, undefined, 'CLOCK_FAILED');
        return;
      }
      Promise.resolve().then(() => {
        try {
          if (clock.expired()) {
            finish(false, undefined, timeoutCode);
            return undefined;
          }
        } catch (error) {
          finish(false, undefined, 'CLOCK_FAILED');
          return undefined;
        }
        return operation();
      }).then((value) => finish(true, value), () => finish(false, undefined, errorCode));
    });
  }

  root.AbsIdentityTiming = Object.freeze({ budget, within });
})(globalThis);
