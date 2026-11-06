'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { timedRealm, binding, identity, plain } = require('./helpers.cjs');

test('challenge parser accepts only one bounded UUID/hex value and never echoes invalid input', () => {
  const { realm } = timedRealm();
  const protocol = realm.AbsIdentityProtocol;
  for (const challenge of ['0', 'AbC012', 'a'.repeat(128), 'ABCDEF01-2345-6789-abcd-0123456789AB']) {
    assert.equal(protocol.challengeFromHash('#' + new URLSearchParams({ challenge })), challenge);
  }
  for (const hash of ['', '#challenge=', '#challenge=a&challenge=b', '#challenge=' + 'a'.repeat(129),
    '#challenge=../x', '#challenge=%00', '#challenge=not-hex', '#challenge=--', '#challenge=abc-def',
    '#challenge=abc%20', '#challenge=abc%0A', '#challenge=abc%0D', '#challenge=%EF%BF%BD', '#challenge=%']) {
    assert.equal(protocol.challengeFromHash(hash), null, hash);
  }
});

test('internal bindings and requests contain control data only', () => {
  const { realm } = timedRealm();
  const protocol = realm.AbsIdentityProtocol;
  const control = binding();
  const params = new URLSearchParams(control).toString();
  assert.deepEqual(plain(protocol.bindingFromParameters('#' + params, control.kind)), control);
  for (const bad of [params + '&values=parent', params + '&challenge=a', params.replace(control.requestId, 'nothex'),
    params.replace('dedicated-worker', 'shared-worker')]) {
    assert.equal(protocol.bindingFromParameters('#' + bad, control.kind), null);
  }
  assert.deepEqual(plain(protocol.request(control)), { type: 'abs-identity:collect', schemaVersion: 1, ...control });
  assert.equal(protocol.isRequest({ ...protocol.request(control), values: identity('parent') }, control), false);
  assert.equal(protocol.isRequest({ ...protocol.request(control), expected: {} }, control), false);
});

test('resource URLs and isolated scope stay inside the two local asset origins', () => {
  const { realm } = timedRealm();
  const protocol = realm.AbsIdentityProtocol;
  for (const kind of Array.from(protocol.KINDS).slice(1)) {
    const control = binding(kind);
    const url = new URL(protocol.resource(control));
    assert.equal(url.origin, kind === 'cross-origin-frame' ? protocol.FRAME_ORIGIN : protocol.APP_ORIGIN);
    assert.ok(url.pathname.startsWith(protocol.BASE));
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.deepEqual(plain(protocol.bindingFromParameters(kind === 'service-worker' ? url.search : url.hash, kind)), control);
  }
  const scope = new URL(protocol.scope(binding('service-worker')));
  assert.equal(scope.pathname, '/assets/identity-probe/sw-scope/' + binding().requestId + '/');
  assert.equal(scope.origin, protocol.APP_ORIGIN);
});

test('frame endpoints require both exact source and exact origin; worker endpoints require their actual target', () => {
  const protocol = timedRealm().realm.AbsIdentityProtocol;
  const source = {};
  const endpoint = { source, origin: protocol.APP_ORIGIN };
  assert.equal(protocol.endpointMatches({ source, origin: protocol.APP_ORIGIN }, endpoint), true);
  assert.equal(protocol.endpointMatches({ source: {}, origin: protocol.APP_ORIGIN }, endpoint), false);
  assert.equal(protocol.endpointMatches({ source, origin: protocol.FRAME_ORIGIN }, endpoint), false);
  assert.equal(protocol.endpointMatches({ source, origin: protocol.APP_ORIGIN + '.evil.invalid' }, endpoint), false);
  const target = {};
  assert.equal(protocol.endpointMatches({ target, currentTarget: target }, { target }), true);
  assert.equal(protocol.endpointMatches({ target: {}, currentTarget: target }, { target }), false);
  assert.equal(protocol.endpointMatches({ target, currentTarget: {} }, { target }), false);
});

test('reply correlation binds every field and rejects arbitrary error codes and malformed values', async () => {
  const { realm } = timedRealm({ navigator: identity('own') });
  const protocol = realm.AbsIdentityProtocol;
  const control = binding();
  const result = protocol.context(control.kind, await realm.AbsIdentityReadings.collect(realm, false));
  const reply = protocol.reply(control, result);
  assert.equal(protocol.envelopeMatches(reply, control, 'abs-identity:result'), true);
  for (const [key, value] of [['schemaVersion', 2], ['type', 'different'], ['challenge', 'ff'],
    ['requestId', 'f'.repeat(32)], ['kind', 'shared-worker']]) {
    assert.equal(protocol.envelopeMatches({ ...reply, [key]: value }, control, 'abs-identity:result'), false);
  }
  for (const invalid of [{ kind: control.kind, status: 'ok' },
    { kind: control.kind, status: 'failed', code: 'https://private.invalid/secret' },
    { ...result, values: { ...result.values, parentValues: {} } }, { ...result, error: 'secret' }]) {
    const rejected = plain(protocol.resultFromReply(protocol.reply(control, invalid), control));
    assert.deepEqual(rejected, { kind: control.kind, status: 'failed', code: 'MALFORMED_REPLY' });
  }
  assert.equal(protocol.resultFromReply({ ...reply, extra: 'x' }, control).code, 'MALFORMED_REPLY');
  assert.equal(protocol.resultFromReply(reply, control).status, 'ok');
});

test('nested entropy failures cannot hide inside an ok context or a misleading unsupported code', async () => {
  const { realm } = timedRealm({ navigator: { userAgentData: {
    getHighEntropyValues() { return Promise.reject(new Error('secret')); }
  } } });
  const protocol = realm.AbsIdentityProtocol;
  const control = binding();
  const result = protocol.context(control.kind, await realm.AbsIdentityReadings.collect(realm, false));
  assert.equal(result.status, 'failed');
  result.status = 'ok';
  delete result.code;
  assert.equal(protocol.resultFromReply(protocol.reply(control, result), control).code, 'MALFORMED_REPLY');
  result.values.navigator.userAgentData.highEntropy.status = 'unsupported';
  assert.equal(protocol.validContext(result, control.kind), false);
});

test('service-worker ok reply requires explicit successful self-unregistration', async () => {
  const { realm } = timedRealm();
  const protocol = realm.AbsIdentityProtocol;
  const control = binding('service-worker');
  const result = protocol.context(control.kind, await realm.AbsIdentityReadings.collect(realm, false));
  assert.equal(protocol.resultFromReply(protocol.reply(control, result, false), control).code, 'SW_UNREGISTER_FAILED');
  assert.equal(protocol.resultFromReply(protocol.reply(control, result, true), control).status, 'ok');
});

test('final serialization fixes all six contexts, coverage and conservative complete semantics', async () => {
  const { realm } = timedRealm();
  const protocol = realm.AbsIdentityProtocol;
  const contexts = [];
  for (const kind of Array.from(protocol.KINDS)) {
    const reading = await realm.AbsIdentityReadings.collect(realm, kind.includes('frame') || kind === 'main');
    contexts.push(protocol.context(kind, reading));
  }
  const parsed = JSON.parse(protocol.serialize(binding().challenge, contexts.reverse()));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.challenge, binding().challenge);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.contexts.map((entry) => entry.kind), Array.from(protocol.KINDS));
  assert.deepEqual(parsed.coverage, { networkHeaders: false, proxyRouting: false, hardwareEmulation: false });
  const unsupported = Array.from(protocol.KINDS, (kind) => protocol.unsupported(kind));
  assert.equal(JSON.parse(protocol.serialize(binding().challenge, unsupported)).complete, true);
  unsupported[0] = protocol.failed('main', 'READ_FAILED');
  assert.equal(JSON.parse(protocol.serialize(binding().challenge, unsupported)).complete, false);
  const invalidChallenge = JSON.parse(protocol.serialize('not-safe/secret', unsupported));
  assert.equal(invalidChallenge.challenge, null);
  assert.equal(invalidChallenge.complete, false);
  const missing = JSON.parse(protocol.serialize(binding().challenge, []));
  assert.ok(missing.contexts.every((entry) => entry.code === 'MALFORMED_REPLY'));
  const duplicate = JSON.parse(protocol.serialize(binding().challenge, [...contexts, contexts[0]]));
  assert.equal(duplicate.complete, false);
});

test('UTF-8 output is at most 64 KiB, including multi-byte observations', async () => {
  const { realm } = timedRealm({ navigator: { userAgentData: {
    brands: Array.from({ length: 32 }, () => ({ brand: '汉'.repeat(4096), version: '😀'.repeat(2048) }))
  } } });
  const protocol = realm.AbsIdentityProtocol;
  const contexts = [];
  for (const kind of Array.from(protocol.KINDS)) {
    contexts.push(protocol.context(kind, await realm.AbsIdentityReadings.collect(realm, kind.includes('frame') || kind === 'main')));
  }
  const wire = protocol.serialize(binding().challenge, contexts);
  assert.ok(Buffer.byteLength(wire, 'utf8') <= 65536);
  const report = JSON.parse(wire);
  assert.equal(report.complete, false);
  assert.ok(report.contexts.every((entry) => entry.code === 'OUTPUT_TOO_LARGE' && entry.values === undefined));
  for (const text of ['ascii', '中文', '😀', '\ud800', 'a😀汉']) {
    assert.equal(protocol.byteLength(text), Buffer.byteLength(text, 'utf8'));
  }
});
