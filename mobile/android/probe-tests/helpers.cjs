'use strict';
// Synthetic VM realms only. No browser, device, network, userdata or filesystem writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ASSETS = path.resolve(__dirname, '../app/src/main/assets/identity-probe');

function assertRegularPath(filename, directory = false) {
  let current = path.parse(filename).root;
  const parts = filename.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
    if (index < parts.length - 1 || directory) {
      if (!stat.isDirectory()) throw new Error('DIRECTORY_REQUIRED');
    } else if (!stat.isFile()) throw new Error('REGULAR_FILE_REQUIRED');
  }
}
function source(name) {
  if (!/^[a-z][a-z0-9-]*\.(?:js|css|html)$/.test(name)) throw new Error('ASSET_NAME_REFUSED');
  const filename = path.join(ASSETS, name);
  assertRegularPath(filename);
  return fs.readFileSync(filename, 'utf8');
}
function assetNames() {
  assertRegularPath(ASSETS, true);
  const names = fs.readdirSync(ASSETS);
  for (const name of names) assertRegularPath(path.join(ASSETS, name));
  return names;
}
class Hub {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, fields = {}) {
    const event = { type: name, source: null, origin: '', target: this, currentTarget: this, ...fields };
    return Array.from(this.listeners.get(name) || [], (listener) => listener.call(this, event));
  }
  count() { return Array.from(this.listeners.values()).reduce((sum, set) => sum + set.size, 0); }
}
function fakeClock() {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  return {
    performance: { now: () => now },
    setTimeout(callback, milliseconds) {
      const id = ++serial;
      timers.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds, fire = true) {
      now += milliseconds;
      if (fire) {
        let count = 0;
        while (Array.from(timers.values()).some((timer) => timer.at <= now)) {
          if (++count > 1000) throw new Error('TIMER_LOOP');
          for (const [id, timer] of Array.from(timers)) {
            if (timer.at <= now && timers.delete(id)) timer.callback();
          }
        }
      }
    },
    get pending() { return timers.size; }
  };
}
async function flush(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
function createRealm(extra = {}, files = ['timing.js', 'readings.js', 'protocol.js']) {
  const clock = fakeClock();
  const sandbox = Object.assign(new Hub(), {
    URL, URLSearchParams, Uint8Array, Date, Intl, setTimeout, clearTimeout,
    performance: { now: () => performance.now() }, ...extra
  });
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const realm = vm.runInContext('globalThis', context);
  realm.self = realm;
  realm.importScripts = (...names) => names.forEach((name) => run(name));
  function run(name) { return vm.runInContext(source(name), context, { filename: name, timeout: 1000 }); }
  for (const file of files) run(file);
  return { realm, context, run, clock };
}
function timedRealm(extra = {}, files) {
  const clock = fakeClock();
  return { ...createRealm({ ...clock, ...extra }, files), clock };
}
function locationFor(url) {
  const parsed = new URL(url);
  return { origin: parsed.origin, pathname: parsed.pathname, hash: parsed.hash, search: parsed.search, href: parsed.href };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function binding(kind = 'dedicated-worker') {
  return { kind, challenge: '01234567-89ab-cdef-0123-456789abcdef', requestId: '0123456789abcdef0123456789abcdef' };
}
function identity(label) {
  return Object.freeze({
    language: label + '-language', languages: Object.freeze([label + '-language', 'zh-CN']),
    userAgent: label + '-UA', platform: label + '-platform', hardwareConcurrency: 7, deviceMemory: 6, maxTouchPoints: 3
  });
}
function pairedChannel() {
  class Port extends Hub {
    constructor() { super(); this.closed = false; this.started = false; this.sent = []; }
    start() { this.started = true; }
    close() { this.closed = true; }
    postMessage(data) {
      this.sent.push(plain(data));
      const peer = this.peer;
      const copy = plain(data);
      queueMicrotask(() => { if (!peer.closed) peer.emit('message', { data: copy }); });
    }
  }
  const port1 = new Port();
  const port2 = new Port();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}
module.exports = {
  ASSETS, assertRegularPath, source, assetNames, Hub, fakeClock, flush, createRealm, timedRealm,
  locationFor, plain, binding, identity, pairedChannel
};
