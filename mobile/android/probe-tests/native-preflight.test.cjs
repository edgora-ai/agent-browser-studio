'use strict';

// VM/Worker API fixtures only, not Chromium, Android, real worker-thread exit or native timezone proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../native-kernel/src/main/assets/native_preflight.js'), 'utf8');

function fixture(options = {}) {
  const events = [];
  const workers = [];
  const blobs = new Map();
  const timers = new Map();
  let nextBlob = 0;
  let nextTimer = 0;
  function nativeValues(timeZone, offsetMinutes) {
    return {
      Intl: {DateTimeFormat: () => ({resolvedOptions: () => ({timeZone})})},
      Date: class FixtureDate { getTimezoneOffset() { return offsetMinutes; } },
    };
  }
  class FixtureBlob {
    constructor(parts) { this.source = parts.join(''); }
  }
  const urls = {
    createObjectURL(blob) {
      const name = 'blob:owned-fixture/' + (++nextBlob);
      blobs.set(name, blob.source);
      events.push('blob:' + nextBlob);
      return name;
    },
    revokeObjectURL(name) { events.push('revoke:' + name.split('/').at(-1)); blobs.delete(name); },
  };
  class FixtureWorker {
    constructor(url) {
      if (options.constructorFailure) throw new Error('SYNTHETIC_CONSTRUCTOR_FAILURE');
      this.number = workers.length + 1;
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      this.source = blobs.get(url);
      assert.equal(typeof this.source, 'string');
      workers.push(this);
      events.push('create:' + this.number);
    }
    terminate() { this.terminated = true; events.push('terminate:' + this.number); }
    postMessage() {
      this.savedMessage = this.onmessage;
      if (options.silent) return;
      queueMicrotask(() => {
        if (this.terminated) return;
        if (options.workerFailure) {
          this.onerror({preventDefault() { events.push('error-prevented:' + workers.length); }});
          return;
        }
        const self = {
          postMessage: data => { if (this.onmessage) this.onmessage({data}); },
          close: () => events.push('self-close:' + this.number),
        };
        const realm = vm.createContext({self, ...nativeValues('Asia/Shanghai', -480)});
        vm.runInContext(this.source, realm);
        self.onmessage({data: 'sample'});
      });
    }
  }
  const values = nativeValues('America/New_York', 240);
  const window = {};
  const context = vm.createContext({window, ...values, Blob: FixtureBlob, URL: urls, Worker: FixtureWorker,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }});
  function run(script = source) { vm.runInContext(script, context); }
  function report() { return JSON.parse(JSON.stringify(window.__absNativePreflightV1)); }
  function fireTimers() { for (const callback of [...timers.values()]) callback(); }
  return {events, workers, blobs, timers, window, context, values, run, report, fireTimers};
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

test('native preflight preserves distinct fixture Window/Worker values without rewriting APIs', async () => {
  const f = fixture();
  const DateBefore = f.context.Date;
  const IntlBefore = f.context.Intl;
  f.run();
  await settle();
  assert.deepEqual(f.report(), {schemaVersion: 1, state: 'COMPLETE',
    window: {timeZone: 'America/New_York', offsetMinutes: 240},
    workers: [{timeZone: 'Asia/Shanghai', offsetMinutes: -480}, {timeZone: 'Asia/Shanghai', offsetMinutes: -480}]});
  assert.equal(f.context.Date, DateBefore);
  assert.equal(f.context.Intl, IntlBefore);
  assert.equal(f.report().workers[0].timeZone === f.report().window.timeZone, false);
});

test('native preflight requests termination and revocation before creating the next Worker', async () => {
  const f = fixture();
  f.run();
  await settle();
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers.filter(worker => worker.terminated).length, 2);
  assert.equal(f.blobs.size, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(f.events.indexOf('terminate:1') < f.events.indexOf('create:2'));
  assert.ok(f.events.indexOf('revoke:1') < f.events.indexOf('create:2'));
});

test('native preflight reports a Worker error as failed and does not manufacture a second realm', async () => {
  const f = fixture({workerFailure: true});
  f.run();
  await settle();
  assert.equal(f.report().state, 'FAILED');
  assert.equal(f.report().workers.length, 0);
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.blobs.size, 0);
  assert.equal(f.timers.size, 0);
});

test('native preflight constructor failure revokes the already-created Blob URL', async () => {
  const f = fixture({constructorFailure: true});
  f.run();
  await settle();
  assert.equal(f.report().state, 'FAILED');
  assert.equal(f.workers.length, 0);
  assert.equal(f.blobs.size, 0);
  assert.equal(f.timers.size, 0);
});

test('native preflight deadline is failed, not a default zero-offset observation', async () => {
  const f = fixture({silent: true});
  f.run();
  assert.equal(f.report().state, 'RUNNING');
  f.fireTimers();
  await settle();
  assert.equal(f.report().state, 'FAILED');
  assert.deepEqual(f.report().workers, []);
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.blobs.size, 0);
  assert.equal(f.timers.size, 0);
});

test('native preflight supersession cancels the old Worker and rejects its late callback', async () => {
  const f = fixture({silent: true});
  f.run();
  const previous = f.window.__absNativePreflightV1;
  const oldWorker = f.workers[0];
  const lateMessage = oldWorker.savedMessage;
  f.run();
  assert.equal(oldWorker.terminated, true);
  lateMessage({data: {timeZone: 'FAKE_LATE_SUCCESS', offsetMinutes: 0}});
  await settle();
  assert.notEqual(f.window.__absNativePreflightV1, previous);
  assert.equal(f.report().state, 'RUNNING');
  assert.deepEqual(f.report().workers, []);
  assert.equal(f.workers.length, 2);
  assert.ok(f.events.indexOf('terminate:1') < f.events.indexOf('create:2'));
  f.window.__absNativePreflightCancelV1();
  await settle();
  assert.equal(f.report().state, 'FAILED');
  assert.equal(f.workers[1].terminated, true);
  assert.equal(f.blobs.size, 0);
  assert.equal(f.timers.size, 0);
});

test('native preflight rejects a missing Window timezone instead of substituting the requested profile', async () => {
  const f = fixture();
  f.context.Intl.DateTimeFormat = () => ({resolvedOptions: () => ({})});
  f.run();
  await settle();
  assert.equal(f.report().state, 'FAILED');
  assert.equal(f.report().window, null);
  assert.equal(f.workers.length, 0);
});

test('native preflight contains no network requests, storage access, or timezone/navigator overrides', () => {
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|WebTransport|localStorage|indexedDB|navigator)\b/);
  assert.doesNotMatch(source, /(?:Date|Intl)\s*=|Object\.defineProperty|\.prototype\s*=/);
  assert.ok(Buffer.byteLength(source) < 16384);
});
