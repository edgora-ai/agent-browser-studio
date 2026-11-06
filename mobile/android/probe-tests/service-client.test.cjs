'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { timedRealm, Hub, binding, identity, pairedChannel, plain, flush } = require('./helpers.cjs');
const FILES = ['timing.js', 'readings.js', 'protocol.js', 'channels.js', 'service-client.js'];

async function fixture(options = {}) {
  const control = binding('service-worker');
  const channels = [];
  const h = timedRealm({ navigator: { ...identity('parent') }, MessageChannel: class {
    constructor() { const pair = pairedChannel(); channels.push(pair); return pair; }
  } }, FILES);
  const protocol = h.realm.AbsIdentityProtocol;
  const independent = timedRealm({ navigator: identity('service-independent') });
  const reading = await independent.realm.AbsIdentityReadings.collect(independent.realm, false);
  const result = protocol.context(control.kind, reading);
  const requests = [];
  const worker = Object.assign(new Hub(), { state: 'activated', scriptURL: protocol.resource(control),
    postMessage(request, ports) {
      requests.push(plain(request));
      ports[0].postMessage(protocol.reply(control, result, options.released !== false));
    }
  });
  let unregisters = 0;
  const registration = Object.assign(new Hub(), { scope: protocol.scope(control), active: worker,
    unregister() { unregisters += 1; return options.unregister ? options.unregister() : Promise.resolve(false); }
  });
  const registers = [];
  h.realm.navigator.serviceWorker = {
    register(url, config) { registers.push({ url, config: plain(config) }); return Promise.resolve(registration); },
    get ready() { throw new Error('UNRELATED_READY_FORBIDDEN'); },
    getRegistrations() { throw new Error('ENUMERATING_OTHER_REGISTRATIONS_FORBIDDEN'); },
    getRegistration() { throw new Error('LOOKING_UP_OTHER_SCOPES_FORBIDDEN'); }
  };
  return { ...h, control, protocol, worker, registration, registers, requests, channels, result,
    unregisters: () => unregisters, run: () => h.realm.AbsIdentityServiceClient.run(h.realm, control) };
}

test('service client registers only a probe sub-scope and exchanges only bound control data over its own port', async () => {
  const f = await fixture();
  const result = plain(await f.run());
  assert.equal(result.status, 'ok');
  assert.equal(result.values.navigator.platform, 'service-independent-platform');
  assert.equal(f.registers.length, 1);
  assert.deepEqual(f.registers[0], { url: f.protocol.resource(f.control),
    config: { scope: f.protocol.scope(f.control), updateViaCache: 'none' } });
  assert.equal(new URL(f.registers[0].config.scope).pathname.startsWith('/assets/identity-probe/sw-scope/'), true);
  assert.deepEqual(f.requests, [{ type: 'abs-identity:collect', schemaVersion: 1, ...f.control }]);
  assert.equal(f.unregisters(), 1);
  assert.equal(f.channels.length, 1);
  assert.equal(f.channels[0].port1.closed, true);
  assert.equal(f.channels[0].port2.closed, true);
  assert.equal(f.channels[0].port1.count(), 0);
  assert.equal(f.registration.count(), 0);
  assert.equal(f.worker.count(), 0);
  assert.equal(f.clock.pending, 0);
});

test('missing serviceWorker is unsupported but API construction/register failures are failed', async () => {
  const h = timedRealm({ navigator: {} }, FILES);
  assert.equal((await h.realm.AbsIdentityServiceClient.run(h.realm, binding('service-worker'))).status, 'unsupported');
  for (const container of [{}, { register() { throw new Error('https://private.invalid/secret'); } }]) {
    h.realm.navigator.serviceWorker = container;
    const result = plain(await h.realm.AbsIdentityServiceClient.run(h.realm, binding('service-worker')));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'SW_REGISTER_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  }
  Object.defineProperty(h.realm.navigator, 'serviceWorker', { get() { throw new Error('secret'); } });
  assert.equal((await h.realm.AbsIdentityServiceClient.run(h.realm, binding('service-worker'))).code, 'START_FAILED');
});

test('late registration after timeout is failed/unconfirmed, and only that exact registration gets cleanup', async () => {
  const f = await fixture();
  let resolveRegistration;
  f.realm.navigator.serviceWorker.register = () => new Promise((resolve) => { resolveRegistration = resolve; });
  const pending = f.run();
  await flush();
  f.clock.advance(6000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'SW_CLEANUP_UNCONFIRMED');
  assert.equal(f.unregisters(), 0);
  resolveRegistration(f.registration);
  await flush();
  assert.equal(f.unregisters(), 1);
  assert.equal(result.status, 'failed');
  assert.equal(f.clock.pending, 0);
});

test('late registration rejection has a handler and cannot turn the timeout into ok', async () => {
  const f = await fixture();
  let rejectRegistration;
  f.realm.navigator.serviceWorker.register = () => new Promise((resolve, reject) => { rejectRegistration = reject; });
  const pending = f.run();
  await flush();
  f.clock.advance(6000);
  assert.equal((await pending).code, 'SW_CLEANUP_UNCONFIRMED');
  rejectRegistration(new Error('secret'));
  await flush();
  assert.equal(f.unregisters(), 0);
});

test('activation never uses global ready and is bounded, cleaning up its own scope', async () => {
  const f = await fixture();
  f.worker.state = 'activating';
  const pending = f.run();
  await flush();
  assert.ok(f.worker.count() > 0);
  f.clock.advance(6000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'DEADLINE_EXCEEDED');
  assert.equal(f.unregisters(), 1);
  assert.equal(f.worker.count(), 0);
  assert.equal(f.registration.count(), 0);
});

test('redundant workers and unexpected scriptURL are failures with owned-scope cleanup', async () => {
  for (const change of [(f) => { f.worker.state = 'redundant'; }, (f) => { f.worker.scriptURL += '&unexpected=1'; }]) {
    const f = await fixture();
    change(f);
    const result = await f.run();
    assert.equal(result.code, 'SW_ACTIVATION_FAILED');
    assert.equal(f.unregisters(), 1);
    assert.equal(f.requests.length, 0);
  }
});

test('client follows only its registration activation state and private channel', async () => {
  const f = await fixture();
  f.worker.state = 'activating';
  const pending = f.run();
  await flush();
  f.worker.state = 'activated';
  f.worker.emit('statechange');
  assert.equal((await pending).status, 'ok');
  assert.equal(f.unregisters(), 1);
});

test('a returned registration with a different scope is never unregistered', async () => {
  const f = await fixture();
  f.registration.scope = f.protocol.APP_ORIGIN + '/unrelated-scope/';
  const result = await f.run();
  assert.equal(result.code, 'SW_REGISTER_FAILED');
  assert.equal(f.unregisters(), 0);
  assert.equal(f.requests.length, 0);
});

test('a worker reply without cleanup acknowledgement is failed', async () => {
  const f = await fixture({ released: false });
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'SW_UNREGISTER_FAILED');
  assert.equal(f.unregisters(), 1);
});

test('client unregister errors and hangs cannot preserve an ok context', async () => {
  const rejecting = await fixture({ unregister: () => Promise.reject(new Error('secret')) });
  assert.equal((await rejecting.run()).code, 'SW_UNREGISTER_FAILED');
  const hanging = await fixture({ unregister: () => new Promise(() => {}) });
  const pending = hanging.run();
  await flush(100);
  hanging.clock.advance(1000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'SW_UNREGISTER_FAILED');
  assert.equal(hanging.clock.pending, 0);
});

test('broken MessageChannel still cleans up only its own registered worker', async () => {
  const f = await fixture();
  f.realm.MessageChannel = class { constructor() { throw new Error('secret'); } };
  const result = await f.run();
  assert.equal(result.code, 'START_FAILED');
  assert.equal(f.unregisters(), 1);
});

test('service message timeout is bounded and tears down both private ports', async () => {
  const f = await fixture();
  f.worker.postMessage = (request) => f.requests.push(plain(request));
  const pending = f.run();
  await flush();
  f.clock.advance(6000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'DEADLINE_EXCEEDED');
  assert.equal(f.unregisters(), 1);
  assert.ok(f.channels[0].port1.closed && f.channels[0].port2.closed);
});
