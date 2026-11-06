'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { timedRealm, Hub, binding, flush, plain } = require('./helpers.cjs');
const FILES = ['timing.js', 'readings.js', 'protocol.js', 'channels.js'];

test('deadline accepts timely results and removes its timer', async () => {
  const { realm, clock } = timedRealm();
  const outcome = plain(await realm.AbsIdentityTiming.within(realm, 100, () => 17));
  assert.deepEqual(outcome, { ok: true, value: 17 });
  assert.equal(clock.pending, 0);
});

test('deadline rechecks elapsed time even when the timeout callback has not run', async () => {
  const { realm, clock } = timedRealm();
  let resolve;
  const pending = realm.AbsIdentityTiming.within(realm, 100, () => new Promise((done) => { resolve = done; }));
  await flush();
  clock.advance(100, false);
  resolve('too late');
  assert.deepEqual(plain(await pending), { ok: false, code: 'DEADLINE_EXCEEDED' });
  assert.equal(clock.pending, 0);
});

test('deadline bounds a hang and safely handles a late rejection', async () => {
  const { realm, clock } = timedRealm();
  let reject;
  const pending = realm.AbsIdentityTiming.within(realm, 20, () => new Promise((done, fail) => { reject = fail; }));
  await flush();
  clock.advance(20);
  assert.equal((await pending).code, 'DEADLINE_EXCEEDED');
  reject(new Error('secret URL'));
  await flush();
  assert.equal(clock.pending, 0);
});

test('deadline maps errors to fixed codes and rejects broken clocks', async () => {
  const { realm } = timedRealm();
  assert.deepEqual(plain(await realm.AbsIdentityTiming.within(realm, 20, () => { throw new Error('secret'); },
    { error: 'START_FAILED' })), { ok: false, code: 'START_FAILED' });
  realm.performance.now = () => NaN;
  assert.equal((await realm.AbsIdentityTiming.within(realm, 20, () => 'not run')).code, 'CLOCK_FAILED');
});

test('clock failure after scheduling prevents work and still clears the timer', async () => {
  const { realm, clock } = timedRealm();
  let now = 0;
  realm.performance.now = () => now;
  let calls = 0;
  const pending = realm.AbsIdentityTiming.within(realm, 100, () => { calls += 1; });
  now = NaN;
  const outcome = await pending;
  assert.equal(outcome.code, 'CLOCK_FAILED');
  assert.equal(calls, 0);
  assert.equal(clock.pending, 0);
});

test('a backwards clock cannot extend a deadline or retain its timer', async () => {
  const { realm, clock } = timedRealm();
  let now = 0;
  realm.performance.now = () => now;
  const pending = realm.AbsIdentityTiming.within(realm, 100, () => {
    now = -1;
    return 'not a pass';
  });
  assert.equal((await pending).code, 'CLOCK_FAILED');
  assert.equal(clock.pending, 0);
});

test('an already-expired deadline never starts its operation', async () => {
  const { realm } = timedRealm();
  let calls = 0;
  const outcome = await realm.AbsIdentityTiming.within(realm, 0, () => { calls += 1; });
  assert.equal(outcome.code, 'DEADLINE_EXCEEDED');
  assert.equal(calls, 0);
});

async function fixture(kind = 'same-origin-frame') {
  const harness = timedRealm({}, FILES);
  const { realm } = harness;
  const control = binding(kind);
  const target = new Hub();
  const source = {};
  const result = realm.AbsIdentityProtocol.context(kind, await realm.AbsIdentityReadings.collect(realm, kind.includes('frame')));
  const reply = realm.AbsIdentityProtocol.reply(control, result);
  return { ...harness, control, target, source, result, reply };
}

test('frame exchange ignores wrong source/origin/challenge/requestId/kind before accepting exact reply', async () => {
  const f = await fixture();
  const { realm, target, control, source, reply, result } = f;
  let settled = false;
  const pending = realm.AbsIdentityChannels.exchange(realm, { binding: control, target,
    endpoint: { source, origin: realm.AbsIdentityProtocol.APP_ORIGIN }, milliseconds: 50, start() {} });
  pending.then(() => { settled = true; });
  await flush();
  const send = (data = reply, extra = {}) => target.emit('message', {
    source, origin: realm.AbsIdentityProtocol.APP_ORIGIN, data, ...extra
  });
  send(reply, { source: {} });
  send(reply, { origin: realm.AbsIdentityProtocol.FRAME_ORIGIN });
  send({ ...reply, challenge: 'ff' });
  send({ ...reply, requestId: 'f'.repeat(32) });
  send({ ...reply, kind: 'cross-origin-frame' });
  send({ ...reply, type: 'abs-identity:collect' });
  await flush();
  assert.equal(settled, false);
  send();
  assert.deepEqual(plain(await pending), plain(result));
  assert.equal(target.count(), 0);
  assert.equal(f.clock.pending, 0);
});

test('worker and MessagePort replies bind their exact endpoint as well as control tuple', async () => {
  const f = await fixture('dedicated-worker');
  const { realm, target, control, reply } = f;
  let settled = false;
  const pending = realm.AbsIdentityChannels.exchange(realm, { binding: control, target,
    endpoint: { target }, milliseconds: 50, start() {} });
  pending.then(() => { settled = true; });
  await flush();
  target.emit('message', { data: reply, target: {} });
  target.emit('message', { data: reply, currentTarget: {} });
  target.emit('message', { data: { ...reply, requestId: 'f'.repeat(32) } });
  await flush();
  assert.equal(settled, false);
  target.emit('message', { data: reply });
  assert.equal((await pending).status, 'ok');
  assert.equal(target.count(), 0);
});

test('a correlated malformed result is failed, not an ignored or successful reply', async () => {
  const f = await fixture('shared-worker');
  const pending = f.realm.AbsIdentityChannels.exchange(f.realm, { binding: f.control, target: f.target,
    endpoint: { target: f.target }, milliseconds: 50, start() {} });
  await flush();
  f.target.emit('message', { data: { ...f.reply, result: { kind: f.control.kind, status: 'ok' } } });
  assert.equal((await pending).code, 'MALFORMED_REPLY');
});

test('exchange errors, cloning errors and start failures are fixed failures', async () => {
  for (const event of ['error', 'messageerror']) {
    const f = await fixture('dedicated-worker');
    const pending = f.realm.AbsIdentityChannels.exchange(f.realm, { binding: f.control, target: f.target,
      endpoint: { target: f.target }, milliseconds: 50, start() {} });
    await flush();
    f.target.emit(event, { message: 'https://private.invalid/secret' });
    const result = plain(await pending);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, event === 'error' ? 'CONTEXT_ERROR' : 'MESSAGE_ERROR');
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
    assert.equal(f.target.count(), 0);
  }
  for (const start of [() => { throw new Error('secret'); }, () => Promise.reject(new Error('secret'))]) {
    const f = await fixture('dedicated-worker');
    const result = await f.realm.AbsIdentityChannels.exchange(f.realm, { binding: f.control, target: f.target,
      endpoint: { target: f.target }, milliseconds: 50, start });
    assert.equal(result.code, 'START_FAILED');
    assert.equal(f.target.count(), 0);
  }
});

test('exchange timeout and late messages cannot be reported ok; listeners are removed', async () => {
  const f = await fixture('dedicated-worker');
  const pending = f.realm.AbsIdentityChannels.exchange(f.realm, { binding: f.control, target: f.target,
    endpoint: { target: f.target }, milliseconds: 50, start() {} });
  await flush();
  f.clock.advance(51, false);
  f.target.emit('message', { data: f.reply });
  assert.equal((await pending).code, 'DEADLINE_EXCEEDED');
  assert.equal(f.target.count(), 0);
});

test('cleanup failures do not silently preserve an ok result', async () => {
  const f = await fixture('dedicated-worker');
  f.target.removeEventListener = () => { throw new Error('secret'); };
  const pending = f.realm.AbsIdentityChannels.exchange(f.realm, { binding: f.control, target: f.target,
    endpoint: { target: f.target }, milliseconds: 50, start() {} });
  await flush();
  f.target.emit('message', { data: f.reply });
  assert.equal((await pending).code, 'CLEANUP_FAILED');
});
