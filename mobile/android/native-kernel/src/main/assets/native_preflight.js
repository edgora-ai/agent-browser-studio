(() => {
  'use strict';
  if (typeof window.__absNativePreflightCancelV1 === 'function') {
    window.__absNativePreflightCancelV1();
  }
  const result = {schemaVersion: 1, state: 'RUNNING', window: null, workers: []};
  window.__absNativePreflightV1 = result;
  let cancelled = false;
  let cancelWorker = null;
  window.__absNativePreflightCancelV1 = () => {
    cancelled = true;
    if (cancelWorker) cancelWorker();
  };

  function sample() {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offsetMinutes = new Date().getTimezoneOffset();
    if (typeof timeZone !== 'string' || !timeZone || !Number.isInteger(offsetMinutes)) {
      throw new Error('INVALID_REALM_SAMPLE');
    }
    return {timeZone, offsetMinutes};
  }

  async function dedicatedWorker() {
    if (cancelled) throw new Error('CANCELLED');
    return new Promise((resolve, reject) => {
      let worker = null;
      let url = null;
      let timer = null;
      let settled = false;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
        }
        if (url !== null) URL.revokeObjectURL(url);
        cancelWorker = null;
        callback(value);
      }
      cancelWorker = () => finish(reject, new Error('CANCELLED'));
      try {
        const source = `self.onmessage = () => { self.postMessage((${sample.toString()})()); self.close(); };`;
        url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
        worker = new Worker(url);
        worker.onmessage = event => finish(resolve, event.data);
        worker.onerror = event => {
          event.preventDefault();
          finish(reject, new Error('WORKER_FAILED'));
        };
        timer = setTimeout(() => finish(reject, new Error('WORKER_DEADLINE')), 3000);
        worker.postMessage('sample');
      } catch (failure) {
        finish(reject, new Error('WORKER_INITIALIZATION_FAILED'));
      }
    });
  }

  (async () => {
    try {
      result.window = sample();
      result.workers.push(await dedicatedWorker());
      result.workers.push(await dedicatedWorker());
      if (cancelled) throw new Error('CANCELLED');
      result.state = 'COMPLETE';
    } catch (failure) {
      result.state = 'FAILED';
    }
  })();
})();
