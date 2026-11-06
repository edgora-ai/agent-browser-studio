'use strict';
// A message/DOM simulator for source tests, NOT a browser, Android, CSP or network test.
const { createRealm, fakeClock, Hub, binding, identity, plain, locationFor, pairedChannel } = require('./helpers.cjs');
const FILES = ['timing.js', 'readings.js', 'protocol.js', 'channels.js', 'contexts.js', 'service-client.js'];
const KINDS = ['main', 'same-origin-frame', 'cross-origin-frame', 'dedicated-worker', 'shared-worker', 'service-worker'];

function browser(options = {}) {
  const clock = fakeClock();
  const outputs = [];
  const children = [];
  const frames = [];
  const workers = [];
  const registrations = [];
  const channels = [];
  const lifetimes = [];
  const mainUrl = 'https://appassets.androidplatform.net/assets/identity-probe/index.html#challenge=' +
    (options.challenge === undefined ? binding().challenge : options.challenge);
  function ownGlobals(kind, url) {
    const index = KINDS.indexOf(kind);
    class OwnDate {
      constructor(input) { this.input = input; }
      getTime() { return 1800000000000 + index; }
      getTimezoneOffset() { return -(index + 1) * 30 - (this.input?.includes('07-15') ? 15 : 0); }
      toString() { return 'synthetic Date of ' + kind; }
    }
    return { ...clock, Date: OwnDate, location: locationFor(url), navigator: {
      ...identity(kind), userAgentData: { brands: [{ brand: kind, version: '137' }], mobile: true, platform: kind,
        getHighEntropyValues() { return Promise.resolve({ model: kind + '-model', architecture: 'arm', bitness: '64',
          platformVersion: '16', fullVersionList: [{ brand: kind, version: '137.0.1.2' }] }); } }
    }, Intl: { DateTimeFormat: class { resolvedOptions() { return { timeZone: 'Synthetic/' + kind, locale: kind + '-locale' }; } } } };
  }
  function child(kind, url, extra = {}, files = []) {
    const h = createRealm({ ...ownGlobals(kind, url), ...extra }, files);
    Object.defineProperty(h.realm, 'AbsProbe', { get() { throw new Error('CHILD_BRIDGE_ACCESS_FORBIDDEN'); } });
    children.push({ kind, ...h });
    return h;
  }
  function node() {
    return {
      value: '', writes: [],
      get textContent() { return this.value; },
      set textContent(value) { this.value = value; this.writes.push(value); },
      set innerHTML(value) { throw new Error('INNER_HTML_FORBIDDEN'); }
    };
  }
  const status = node();
  const result = node();
  let serial = 0;
  const main = createRealm({ ...ownGlobals('main', mainUrl),
    screen: { width: 410, height: 890 }, devicePixelRatio: 2.5,
    crypto: { getRandomValues(bytes) { bytes.fill(++serial); return bytes; } },
    AbsProbe: { postMessage: (wire) => outputs.push(wire) }
  }, FILES);
  const realm = main.realm;
  realm.top = realm;
  realm.document = {
    getElementById(id) { return id === 'status' ? status : result; },
    createElement(tag) {
      if (tag !== 'iframe') throw new Error('UNEXPECTED_ELEMENT');
      const element = Object.assign(new Hub(), {
        attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
        remove() { this.removed = true; }
      });
      frames.push(element);
      return element;
    },
    body: {
      appendChild(element) {
        const kind = new URL(element.src).origin === realm.AbsIdentityProtocol.FRAME_ORIGIN
          ? 'cross-origin-frame' : 'same-origin-frame';
        let h;
        const parentProxy = { postMessage(data, targetOrigin) {
          if (targetOrigin !== realm.location.origin) throw new Error('WRONG_PARENT_TARGET');
          queueMicrotask(() => realm.emit('message', { data: plain(data), source: element.contentWindow,
            origin: h.realm.location.origin }));
        } };
        h = child(kind, element.src, { parent: parentProxy, screen: { width: 300 + KINDS.indexOf(kind), height: 600 },
          devicePixelRatio: 2 }, ['timing.js', 'readings.js', 'protocol.js']);
        element.contentWindow = { postMessage(data, targetOrigin) {
          if (targetOrigin !== h.realm.location.origin) throw new Error('WRONG_FRAME_TARGET');
          h.realm.emit('message', { data: plain(data), source: parentProxy, origin: realm.location.origin });
        } };
        if (options.silentFrame !== kind) h.run('frame.js');
        queueMicrotask(() => element.emit('load'));
      }
    }
  };
  if (options.workers !== false) realm.Worker = class extends Hub {
    constructor(url) {
      super();
      workers.push(this);
      this.h = child('dedicated-worker', url, { close() {} });
      this.h.realm.postMessage = (data) => queueMicrotask(() => this.emit('message', { data: plain(data) }));
      this.h.run('dedicated-worker.js');
    }
    postMessage(data) { this.request = plain(data); this.h.realm.emit('message', { data: plain(data) }); }
    terminate() { this.terminated = true; }
  };
  if (options.shared !== false) realm.SharedWorker = class extends Hub {
    constructor(url) {
      super();
      workers.push(this);
      const channel = pairedChannel();
      channels.push(channel);
      this.port = channel.port1;
      this.h = child('shared-worker', url, { close() {} });
      this.h.run('shared-worker.js');
      this.h.realm.emit('connect', { ports: [channel.port2] });
    }
  };
  realm.MessageChannel = class { constructor() { const pair = pairedChannel(); channels.push(pair); return pair; } };
  if (options.service !== false) realm.navigator.serviceWorker = {
    register(url, config) {
      const registration = Object.assign(new Hub(), { scope: config.scope, calls: 0,
        unregister() { this.calls += 1; return Promise.resolve(this.calls === 1); } });
      registrations.push(registration);
      const h = child('service-worker', url, { registration });
      h.run('service-worker.js');
      registration.active = Object.assign(new Hub(), { state: 'activated', scriptURL: url,
        postMessage(data, ports) {
          h.realm.emit('message', { data: plain(data), ports, origin: realm.location.origin,
            source: { type: 'window', frameType: 'top-level', id: 'synthetic-client', url: mainUrl },
            waitUntil(promise) { lifetimes.push(promise); } });
        } });
      return Promise.resolve(registration);
    },
    get ready() { throw new Error('GLOBAL_READY_FORBIDDEN'); },
    getRegistrations() { throw new Error('OTHER_REGISTRATIONS_FORBIDDEN'); }
  };
  return { realm, clock, outputs, children, frames, workers, registrations, channels, lifetimes, status, result,
    start: () => main.run('main.js') };
}
module.exports = { browser };
