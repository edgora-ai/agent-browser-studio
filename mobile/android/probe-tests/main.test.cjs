'use strict';
// Full source flow using independent synthetic VM realms; not a browser acceptance result.
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser } = require('./synthetic-browser.cjs');
const { binding, flush } = require('./helpers.cjs');

test('main alone sends one bounded report containing six independently collected contexts', async () => {
  const h = browser();
  h.start();
  await flush(200);
  assert.equal(h.outputs.length, 1);
  assert.equal(typeof h.outputs[0], 'string');
  assert.ok(Buffer.byteLength(h.outputs[0], 'utf8') <= 65536);
  const report = JSON.parse(h.outputs[0]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.challenge, binding().challenge);
  assert.equal(report.complete, true);
  assert.deepEqual(report.coverage, { networkHeaders: false, proxyRouting: false, hardwareEmulation: false });
  assert.deepEqual(report.contexts.map((entry) => entry.kind), Array.from(h.realm.AbsIdentityProtocol.KINDS));
  assert.equal(h.children.length, 5);
  for (const [index, context] of report.contexts.entries()) {
    assert.equal(context.status, 'ok', JSON.stringify(context));
    assert.equal(context.values.navigator.platform, context.kind + '-platform');
    assert.equal(context.values.navigator.userAgentData.highEntropy.values.model, context.kind + '-model');
    assert.equal(context.values.intl.timeZone, 'Synthetic/' + context.kind);
    assert.equal(context.values.intl.locale, context.kind + '-locale');
    assert.equal(context.values.date.januaryTimezoneOffset, -(index + 1) * 30);
    assert.equal(context.values.date.julyTimezoneOffset, -(index + 1) * 30 - 15);
    assert.equal(context.values.screen !== undefined, index < 3);
    assert.equal(context.values.devicePixelRatio !== undefined, index < 3);
  }
  assert.equal(h.result.textContent, h.outputs[0]);
  assert.ok(h.frames.every((frame) => frame.removed && frame.count() === 0));
  assert.equal(h.workers[0].terminated, true);
  assert.ok(h.channels.every((pair) => pair.port1.closed && pair.port2.closed));
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0].calls, 2); // self-unregister then parent-owned fallback confirmation
  assert.equal(h.clock.pending, 0);
  await Promise.all(h.lifetimes);
  await flush();
  assert.equal(h.outputs.length, 1);
});

test('invalid challenge stops before any reads, frames, workers or service registrations', () => {
  for (const challenge of ['', 'not-hex', '../secret', 'a'.repeat(129), 'abc%0A', 'a&challenge=b']) {
    const h = browser({ challenge });
    Object.defineProperty(h.realm.navigator, 'language', { get() { throw new Error('MUST_NOT_READ'); } });
    h.start();
    assert.equal(h.outputs.length, 1);
    const report = JSON.parse(h.outputs[0]);
    assert.equal(report.challenge, null);
    assert.equal(report.complete, false);
    assert.equal(report.contexts.length, 6);
    assert.ok(report.contexts.every((entry) => entry.status === 'failed' && entry.code === 'INVALID_CHALLENGE'));
    assert.equal(h.children.length, 0);
    assert.equal(h.frames.length, 0);
    assert.equal(h.workers.length, 0);
    assert.equal(h.registrations.length, 0);
  }
});

test('UUID/hex challenge preserves case and is not replaced by an expected value', async () => {
  const h = browser({ challenge: 'ABCDEF1234' });
  h.start();
  await flush(200);
  assert.equal(JSON.parse(h.outputs[0]).challenge, 'ABCDEF1234');
});

test('missing secure request IDs are failed, without unsafe fallback identifiers or probing', () => {
  for (const crypto of [undefined, { getRandomValues(bytes) { bytes.fill(0); } }]) {
    const h = browser();
    h.realm.crypto = crypto;
    h.start();
    const report = JSON.parse(h.outputs[0]);
    assert.equal(report.complete, false);
    assert.ok(report.contexts.every((entry) => entry.code === 'REQUEST_ID_UNAVAILABLE'));
    assert.equal(h.children.length, 0);
  }
});

test('unsupported APIs are explicit and are not represented by parent identities', async () => {
  const h = browser({ shared: false, service: false, workers: false });
  h.start();
  await flush(200);
  const report = JSON.parse(h.outputs[0]);
  assert.equal(report.complete, true); // terminal unsupported is not an identity/network pass
  for (const entry of report.contexts.slice(3)) {
    assert.equal(entry.status, 'unsupported');
    assert.equal(entry.code, 'API_UNSUPPORTED');
    assert.equal(entry.values, undefined);
  }
  assert.match(h.status.textContent, /不支持/);
});

test('present but throwing SharedWorker is failed, rather than unsupported', async () => {
  const h = browser();
  h.realm.SharedWorker = class { constructor() { throw new Error('https://private.invalid/secret'); } };
  h.start();
  await flush(200);
  const report = JSON.parse(h.outputs[0]);
  const shared = report.contexts.find((entry) => entry.kind === 'shared-worker');
  assert.equal(report.complete, false);
  assert.equal(shared.status, 'failed');
  assert.equal(shared.code, 'START_FAILED');
  assert.doesNotMatch(h.outputs[0], /private|secret/);
});

test('an unresponsive cross-origin frame yields a bounded failure, not fabricated data', async () => {
  const h = browser({ silentFrame: 'cross-origin-frame' });
  h.start();
  await flush(200);
  assert.equal(h.outputs.length, 0);
  h.clock.advance(4000);
  await flush(200);
  assert.equal(h.outputs.length, 1);
  const report = JSON.parse(h.outputs[0]);
  const cross = report.contexts.find((entry) => entry.kind === 'cross-origin-frame');
  assert.equal(report.complete, false);
  assert.equal(cross.status, 'failed');
  assert.equal(cross.code, 'DEADLINE_EXCEEDED');
  assert.equal(cross.values, undefined);
  assert.equal(h.clock.pending, 0);
});

test('nested main entry never touches the native bridge or starts jobs', () => {
  const h = browser();
  h.realm.top = {};
  h.start();
  assert.equal(h.outputs.length, 0);
  assert.equal(h.children.length, 0);
});

test('unrecognized main location never starts or sends', () => {
  const h = browser();
  h.realm.location.origin = 'https://other.invalid';
  h.start();
  assert.equal(h.outputs.length, 0);
  assert.equal(h.children.length, 0);
  assert.match(h.status.textContent, /已停止/);
});

test('bridge missing or throwing displays fixed errors and never retries native delivery', async () => {
  for (const absent of [false, true]) {
    const h = browser();
    let attempts = 0;
    h.realm.AbsProbe = absent ? undefined : { postMessage() { attempts += 1; throw new Error('secret native URL'); } };
    h.start();
    await flush(200);
    assert.equal(attempts, absent ? 0 : 1);
    assert.equal(h.outputs.length, 0);
    assert.ok(JSON.parse(h.result.textContent).contexts.length === 6);
    assert.match(h.status.textContent, absent ? /未连接原生接收器/ : /原生接收失败/);
    assert.doesNotMatch(h.status.textContent, /secret/);
  }
});

test('untrusted-looking observed text is displayed only using textContent', async () => {
  const h = browser();
  h.realm.navigator.userAgent = '<img src=x onerror=alert(1)>';
  h.start();
  await flush(200);
  const report = JSON.parse(h.outputs[0]);
  assert.equal(report.contexts[0].values.navigator.userAgent, '<img src=x onerror=alert(1)>');
  assert.ok(h.result.writes.includes(h.outputs[0]));
});
