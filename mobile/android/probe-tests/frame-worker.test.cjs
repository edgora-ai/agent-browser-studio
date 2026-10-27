'use strict';
// Each endpoint below is a separate VM global, not a real browser realm.
const test = require('node:test');
const assert = require('node:assert/strict');
const { timedRealm, Hub, binding, identity, plain, locationFor, flush, pairedChannel } = require('./helpers.cjs');

for (const kind of ['same-origin-frame', 'cross-origin-frame']) {
  test(kind + ' collects its own values and checks exact parent/source/origin/tuple', async () => {
    const control = binding(kind);
    const bootstrap = timedRealm().realm.AbsIdentityProtocol;
    const sent = [];
    const parent = { navigator: identity('parent-never-used'), postMessage: (data, origin) => sent.push({ data: plain(data), origin }) };
    let bridgeCalls = 0;
    const { realm, run } = timedRealm({ location: locationFor(bootstrap.resource(control)), parent,
      navigator: identity(kind), screen: { width: 320, height: 600 }, devicePixelRatio: 2,
      AbsProbe: { postMessage() { bridgeCalls += 1; } } });
    run('frame.js');
    const message = realm.AbsIdentityProtocol.request(control);
    const send = (data = message, fields = {}) => realm.emit('message', {
      source: parent, origin: bootstrap.APP_ORIGIN, data, ...fields
    });
    send(message, { source: {} });
    send(message, { origin: bootstrap.FRAME_ORIGIN });
    send({ ...message, challenge: 'f' });
    send({ ...message, requestId: 'f'.repeat(32) });
    send({ ...message, values: identity('parent') });
    await flush();
    assert.equal(sent.length, 0);
    await Promise.all(send());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].origin, bootstrap.APP_ORIGIN);
    assert.equal(sent[0].data.result.status, 'ok');
    assert.equal(sent[0].data.result.values.navigator.platform, kind + '-platform');
    assert.equal(sent[0].data.result.values.screen.width, 320);
    assert.equal(sent[0].data.challenge, control.challenge);
    assert.equal(sent[0].data.requestId, control.requestId);
    assert.equal(bridgeCalls, 0);
    await Promise.all(send());
    assert.equal(sent.length, 1);
  });
}

test('frame entry with invalid origin/binding or no parent is inert', () => {
  for (const url of ['https://other.invalid/assets/identity-probe/frame.html#challenge=abc',
    'https://appassets.androidplatform.net/assets/identity-probe/frame.html#challenge=bad']) {
    const h = timedRealm({ location: locationFor(url), parent: {} });
    h.run('frame.js');
    assert.equal(h.realm.count(), 0);
  }
  const h = timedRealm({ location: locationFor('https://appassets.androidplatform.net/assets/identity-probe/frame.html') });
  h.realm.parent = h.realm;
  h.run('frame.js');
  assert.equal(h.realm.count(), 0);
});

test('frame reply delivery failure is handled without leaking exception text', async () => {
  const protocol = timedRealm().realm.AbsIdentityProtocol;
  const control = binding('same-origin-frame');
  const parent = { postMessage() { throw new Error('https://private.invalid/secret'); } };
  const h = timedRealm({ location: locationFor(protocol.resource(control)), parent });
  h.run('frame.js');
  const outcomes = await Promise.all(h.realm.emit('message', { source: parent, origin: protocol.APP_ORIGIN,
    data: protocol.request(control) }));
  assert.deepEqual(outcomes, ['MESSAGE_ERROR']);
});

for (const shared of [false, true]) {
  const kind = shared ? 'shared-worker' : 'dedicated-worker';
  test(kind + ' entry reads independently; parent values are rejected, replies are correlated once', async () => {
    const protocol = timedRealm().realm.AbsIdentityProtocol;
    const control = binding(kind);
    const sent = [];
    let closed = 0;
    const h = timedRealm({ navigator: identity(kind), location: locationFor(protocol.resource(control)),
      close() { closed += 1; } }, []);
    h.run(kind + '.js');
    const target = shared ? new Hub() : h.realm;
    target.start = () => {};
    if (shared) target.close = () => {};
    target.postMessage = (data) => sent.push(plain(data));
    if (shared) h.realm.emit('connect', { ports: [target] });
    const message = protocol.request(control);
    target.emit('message', { data: { ...message, values: identity('parent') } });
    target.emit('message', { data: { ...message, expected: identity('parent') } });
    target.emit('message', { data: { ...message, requestId: 'f'.repeat(32) } });
    target.emit('message', { data: message, target: {} });
    await flush();
    assert.equal(sent.length, 0);
    await Promise.all(target.emit('message', { data: message }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].result.status, 'ok');
    assert.equal(sent[0].result.values.navigator.platform, kind + '-platform');
    assert.equal(sent[0].result.values.screen, undefined);
    assert.equal(sent[0].result.values.devicePixelRatio, undefined);
    assert.equal(sent[0].requestId, control.requestId);
    assert.equal(closed, 1);
    await Promise.all(target.emit('message', { data: message }));
    assert.equal(sent.length, 1);
  });
}

test('worker entry refuses other origins and invalid bindings', () => {
  for (const kind of ['dedicated-worker', 'shared-worker']) {
    const h = timedRealm({ location: locationFor('https://other.invalid/assets/identity-probe/' + kind + '.js') }, []);
    let imports = 0;
    h.realm.importScripts = () => { imports += 1; };
    h.run(kind + '.js');
    assert.equal(imports, 0);
    assert.equal(h.realm.count(), 0);
  }
});

test('dedicated transport sends only control fields and terminates its own worker', async () => {
  const h = timedRealm({ navigator: identity('parent') }, ['timing.js', 'readings.js', 'protocol.js', 'channels.js', 'contexts.js']);
  const control = binding('dedicated-worker');
  let instance;
  let request;
  let child;
  h.realm.Worker = class extends Hub {
    constructor(url) {
      super();
      instance = this;
      child = timedRealm({ location: locationFor(url), navigator: identity('independent-dedicated'), close() {} }, []);
      child.realm.postMessage = (data) => queueMicrotask(() => this.emit('message', { data: plain(data) }));
      child.run('dedicated-worker.js');
    }
    postMessage(data) { request = plain(data); child.realm.emit('message', { data: plain(data) }); }
    terminate() { this.terminated = true; }
  };
  const result = plain(await h.realm.AbsIdentityContexts.worker(h.realm, control));
  assert.equal(result.status, 'ok');
  assert.equal(result.values.navigator.platform, 'independent-dedicated-platform');
  assert.deepEqual(request, { type: 'abs-identity:collect', schemaVersion: 1, ...control });
  assert.equal(instance.terminated, true);
  assert.equal(instance.count(), 0);
});

test('shared transport uses its private port and its own realm, without parent readings', async () => {
  const h = timedRealm({ navigator: identity('parent') }, ['timing.js', 'readings.js', 'protocol.js', 'channels.js', 'contexts.js']);
  let channel;
  h.realm.SharedWorker = class extends Hub {
    constructor(url) {
      super();
      channel = pairedChannel();
      this.port = channel.port1;
      const child = timedRealm({ location: locationFor(url), navigator: identity('independent-shared'), close() {} }, []);
      child.run('shared-worker.js');
      child.realm.emit('connect', { ports: [channel.port2] });
    }
  };
  const result = plain(await h.realm.AbsIdentityContexts.worker(h.realm, binding('shared-worker')));
  assert.equal(result.status, 'ok');
  assert.equal(result.values.navigator.platform, 'independent-shared-platform');
  assert.equal(channel.port1.sent.length, 1);
  assert.deepEqual(Object.keys(channel.port1.sent[0]).sort(), ['challenge', 'kind', 'requestId', 'schemaVersion', 'type']);
  assert.equal(channel.port1.closed, true);
  assert.equal(channel.port1.count(), 0);
});

test('missing SharedWorker is unsupported; an existing but broken API is failed', async () => {
  const h = timedRealm({}, ['timing.js', 'readings.js', 'protocol.js', 'channels.js', 'contexts.js']);
  const run = () => h.realm.AbsIdentityContexts.worker(h.realm, binding('shared-worker'));
  assert.equal((await run()).status, 'unsupported');
  for (const Constructor of [42, class { constructor() { throw new Error('private URL'); } }]) {
    h.realm.SharedWorker = Constructor;
    const result = plain(await run());
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'START_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('worker execution deadline is bounded and still terminates the created worker', async () => {
  const h = timedRealm({}, ['timing.js', 'readings.js', 'protocol.js', 'channels.js', 'contexts.js']);
  let instance;
  h.realm.Worker = class extends Hub {
    constructor() { super(); instance = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  };
  const pending = h.realm.AbsIdentityContexts.worker(h.realm, binding());
  await flush();
  h.clock.advance(4000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'DEADLINE_EXCEEDED');
  assert.equal(instance.terminated, true);
  assert.equal(instance.count(), 0);
});
