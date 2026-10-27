'use strict';
// Real source execution in synthetic ServiceWorkerGlobalScope-like VMs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { timedRealm, binding, identity, locationFor, plain, flush } = require('./helpers.cjs');

function fixture(unregister = () => Promise.resolve(true)) {
  const protocol = timedRealm().realm.AbsIdentityProtocol;
  const control = binding('service-worker');
  const order = [];
  const h = timedRealm({ location: locationFor(protocol.resource(control)), navigator: {
    ...identity('service-own'), get language() { order.push('read'); return 'service-own-language'; }
  }, registration: { scope: protocol.scope(control), unregister() { order.push('unregister'); return unregister(); } } }, []);
  const forbidden = () => { throw new Error('STORE_ACCESS_FORBIDDEN'); };
  Object.defineProperties(h.realm, { caches: { get: forbidden }, indexedDB: { get: forbidden },
    clients: { get: forbidden }, localStorage: { get: forbidden } });
  h.run('service-worker.js');
  const sent = [];
  const port = { postMessage(data) { order.push('reply'); sent.push(plain(data)); }, close() { order.push('close'); } };
  const source = { type: 'window', frameType: 'top-level', id: 'synthetic-client',
    url: protocol.APP_ORIGIN + protocol.BASE + 'index.html#challenge=' + control.challenge };
  let lifetime;
  function send(fields = {}) {
    return h.realm.emit('message', { origin: protocol.APP_ORIGIN, source,
      data: protocol.request(control), ports: [port], waitUntil(promise) { lifetime = promise; }, ...fields });
  }
  return { ...h, protocol, control, order, sent, port, source, send, lifetime: () => lifetime };
}

test('service worker validates exact client origin, main-frame URL, challenge and requestId before reading', async () => {
  const f = fixture();
  f.send({ origin: f.protocol.FRAME_ORIGIN });
  f.send({ source: { ...f.source, type: 'worker' } });
  f.send({ source: { ...f.source, frameType: 'nested' } });
  f.send({ source: { ...f.source, id: '' } });
  f.send({ source: { ...f.source, url: 'https://other.invalid/assets/identity-probe/index.html#challenge=' + f.control.challenge } });
  f.send({ source: { ...f.source, url: f.source.url.replace('index.html', 'frame.html') } });
  f.send({ source: { ...f.source, url: f.source.url.replace(f.control.challenge, 'ff') } });
  f.send({ data: { ...f.protocol.request(f.control), requestId: 'f'.repeat(32) } });
  f.send({ data: { ...f.protocol.request(f.control), values: identity('parent') } });
  f.send({ ports: [] });
  await flush();
  assert.equal(f.order.length, 0);
  f.send();
  await f.lifetime();
  assert.equal(f.sent.length, 1);
  const reply = f.sent[0];
  assert.equal(reply.result.status, 'ok');
  assert.equal(reply.result.values.navigator.platform, 'service-own-platform');
  assert.equal(reply.result.values.navigator.language, 'service-own-language');
  assert.equal(reply.result.values.screen, undefined);
  assert.equal(reply.released, true);
  assert.equal(reply.challenge, f.control.challenge);
  assert.equal(reply.requestId, f.control.requestId);
  assert.deepEqual(f.order, ['read', 'unregister', 'reply', 'close']);
  f.send();
  await flush();
  assert.equal(f.sent.length, 1);
});

test('service worker self-unregistration false/rejection is failed before sending a result', async () => {
  for (const unregister of [() => false, () => Promise.reject(new Error('secret registration URL'))]) {
    const f = fixture(unregister);
    f.send();
    await f.lifetime();
    assert.equal(f.sent[0].result.status, 'failed');
    assert.equal(f.sent[0].result.code, 'SW_UNREGISTER_FAILED');
    assert.equal(f.sent[0].released, false);
    assert.doesNotMatch(JSON.stringify(f.sent), /secret|registration URL/);
    assert.deepEqual(f.order, ['read', 'unregister', 'reply', 'close']);
  }
});

test('service worker self-unregistration cannot wait indefinitely', async () => {
  const f = fixture(() => new Promise(() => {}));
  f.send();
  await flush();
  assert.deepEqual(f.order, ['read', 'unregister']);
  f.clock.advance(1000);
  await f.lifetime();
  assert.equal(f.sent[0].result.code, 'SW_UNREGISTER_FAILED');
  assert.equal(f.sent[0].released, false);
  assert.equal(f.clock.pending, 0);
});

test('service worker errors while reading never become ok even when cleanup succeeds', async () => {
  const f = fixture();
  Object.defineProperty(f.realm.navigator, 'userAgentData', { get() { throw new Error('secret'); } });
  f.send();
  await f.lifetime();
  assert.equal(f.sent[0].released, true);
  assert.equal(f.sent[0].result.status, 'failed');
  assert.equal(f.sent[0].result.code, 'READ_FAILED');
});

test('service worker refuses mismatched scope and never unregisters it', () => {
  const protocol = timedRealm().realm.AbsIdentityProtocol;
  let unregisters = 0;
  const h = timedRealm({ location: locationFor(protocol.resource(binding('service-worker'))),
    registration: { scope: protocol.APP_ORIGIN + '/unrelated/', unregister() { unregisters += 1; } } }, []);
  h.run('service-worker.js');
  assert.equal(h.realm.count(), 0);
  assert.equal(unregisters, 0);
});

test('service worker cannot import resources on an unrecognized origin', () => {
  const h = timedRealm({ location: locationFor('https://other.invalid/assets/identity-probe/service-worker.js') }, []);
  let imports = 0;
  h.realm.importScripts = () => { imports += 1; };
  h.run('service-worker.js');
  assert.equal(imports, 0);
});

test('service worker reply-port errors are handled with fixed local codes', async () => {
  const f = fixture();
  f.port.postMessage = () => { throw new Error('secret'); };
  f.send();
  assert.equal(await f.lifetime(), 'MESSAGE_ERROR');
  assert.ok(f.order.includes('unregister'));
});
