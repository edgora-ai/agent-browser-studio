'use strict';
// VM/synthetic realm coverage, not browser or Android measurements.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealm, timedRealm, identity, plain, flush } = require('./helpers.cjs');

test('reads the supplied realm Date/Intl and navigator, without rewriting prototypes', async () => {
  // Materialize lazy Intl intrinsics before taking the mutation baseline.
  new Intl.DateTimeFormat().resolvedOptions();
  const dateBefore = Object.getOwnPropertyDescriptors(Date.prototype);
  const intlBefore = Object.getOwnPropertyDescriptors(Intl.DateTimeFormat.prototype);
  const hints = [];
  const data = Object.freeze({
    brands: Object.freeze([{ brand: 'Actual VM Engine', version: '137' }]), mobile: true, platform: 'Actual VM OS',
    getHighEntropyValues(keys) {
      assert.equal(this, data);
      hints.push(Array.from(keys));
      return Promise.resolve({ model: 'synthetic-own-model', architecture: 'arm', bitness: '64',
        platformVersion: '16.0', fullVersionList: [{ brand: 'Actual VM Engine', version: '137.1.2.3' }] });
    }
  });
  const navigator = Object.freeze({ ...identity('main-own'), userAgentData: data });
  const screen = Object.freeze({ width: 411, height: 891, availWidth: 411, availHeight: 850,
    colorDepth: 24, pixelDepth: 24, orientation: Object.freeze({ type: 'portrait-primary', angle: 0 }) });
  const { realm } = createRealm({ navigator, screen, devicePixelRatio: 2.625 });
  const earliest = Date.now();
  const reading = plain(await realm.AbsIdentityReadings.collect(realm, true));
  assert.equal(reading.status, 'ok');
  assert.ok(reading.values.date.epochMilliseconds >= earliest);
  assert.ok(reading.values.date.epochMilliseconds <= Date.now());
  assert.equal(reading.values.date.timezoneOffset, new Date().getTimezoneOffset());
  assert.equal(reading.values.date.januaryTimezoneOffset, new Date('2026-01-15T00:00:00.000Z').getTimezoneOffset());
  assert.equal(reading.values.date.julyTimezoneOffset, new Date('2026-07-15T00:00:00.000Z').getTimezoneOffset());
  assert.equal(reading.values.intl.timeZone, new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(reading.values.intl.locale, new Intl.DateTimeFormat().resolvedOptions().locale);
  assert.equal(reading.values.navigator.language, navigator.language);
  assert.deepEqual(reading.values.navigator.languages, Array.from(navigator.languages));
  for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints']) {
    assert.equal(reading.values.navigator[key], navigator[key]);
  }
  assert.deepEqual(reading.values.screen, screen);
  assert.equal(reading.values.devicePixelRatio, 2.625);
  assert.deepEqual(hints, [['model', 'architecture', 'bitness', 'platformVersion', 'fullVersionList']]);
  assert.equal(reading.values.navigator.userAgentData.highEntropy.values.model, 'synthetic-own-model');
  assert.equal(realm.AbsIdentityReadings.validValues(reading.values, true), true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Date.prototype), dateBefore);
  const intlAfter = Object.getOwnPropertyDescriptors(Intl.DateTimeFormat.prototype);
  assert.deepEqual(Reflect.ownKeys(intlAfter), Reflect.ownKeys(intlBefore));
  for (const key of Reflect.ownKeys(intlBefore)) {
    for (const attribute of Reflect.ownKeys(intlBefore[key])) {
      assert.equal(intlAfter[key][attribute], intlBefore[key][attribute], String(key) + '.' + attribute);
    }
  }
  assert.equal(navigator.userAgent, 'main-own-UA');
});

test('UTC January/July samples use this realm independently, with distinct offsets', async () => {
  const seen = [];
  class OwnDate {
    constructor(value) { this.input = value; seen.push(value); }
    getTime() { return 123456789; }
    toString() { return 'own Date local timezone string'; }
    getTimezoneOffset() { return this.input?.includes('01-15') ? -345 : this.input?.includes('07-15') ? -405 : -360; }
  }
  const { realm } = timedRealm({ Date: OwnDate,
    Intl: { DateTimeFormat: class { resolvedOptions() { return { timeZone: 'Own/Zone', locale: 'own-Locale' }; } } },
    navigator: identity('worker-own') });
  Object.defineProperties(realm, {
    parent: { get() { throw new Error('PARENT_MUST_NOT_BE_READ'); } },
    screen: { get() { throw new Error('WORKER_HAS_NO_SCREEN'); } },
    devicePixelRatio: { get() { throw new Error('WORKER_HAS_NO_DPR'); } }
  });
  const result = plain(await realm.AbsIdentityReadings.collect(realm, false));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.values.date, { epochMilliseconds: 123456789, localString: 'own Date local timezone string',
    timezoneOffset: -360, januaryTimezoneOffset: -345, julyTimezoneOffset: -405 });
  assert.deepEqual(seen, [undefined, '2026-01-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z']);
  assert.equal(result.values.intl.timeZone, 'Own/Zone');
  assert.equal(result.values.navigator.platform, 'worker-own-platform');
  assert.equal(Object.hasOwn(result.values, 'screen'), false);
  assert.equal(Object.hasOwn(result.values, 'devicePixelRatio'), false);
});

test('missing APIs and fields are null, without expected or parent fallbacks', async () => {
  const { realm } = timedRealm({ Date: undefined, Intl: undefined, navigator: {}, screen: undefined,
    devicePixelRatio: undefined, expected: identity('expected-never-used'), parent: { navigator: identity('parent') } });
  const result = plain(await realm.AbsIdentityReadings.collect(realm, true));
  assert.equal(result.status, 'ok');
  assert.ok(Object.values(result.values.date).every((value) => value === null));
  assert.deepEqual(result.values.intl, { timeZone: null, locale: null });
  assert.ok(Object.values(result.values.navigator).every((value) => value === null));
  assert.equal(result.values.screen, null);
  assert.equal(result.values.devicePixelRatio, null);
  assert.equal(realm.AbsIdentityReadings.validValues(result.values, true), true);
});

test('UAData with no high-entropy API explicitly reports unsupported', async () => {
  const { realm } = timedRealm({ navigator: { userAgentData: { brands: [], mobile: false, platform: '' } } });
  const result = plain(await realm.AbsIdentityReadings.collect(realm, false));
  assert.equal(result.status, 'ok');
  assert.equal(result.values.navigator.userAgentData.mobile, false);
  assert.equal(result.values.navigator.userAgentData.platform, '');
  assert.deepEqual(result.values.navigator.userAgentData.highEntropy, { status: 'unsupported',
    code: 'API_UNSUPPORTED', values: { model: null, architecture: null, bitness: null,
      platformVersion: null, fullVersionList: null } });
});

test('getters and constructors failing yield fixed codes, never exception text', async () => {
  const navigator = { get language() { throw new Error('https://private.invalid/secret'); }, userAgent: 'own' };
  const { realm } = timedRealm({ navigator, Date: class { constructor() { throw new Error('secret Date'); } },
    Intl: { DateTimeFormat: class { constructor() { throw new Error('secret Intl'); } } } });
  const result = plain(await realm.AbsIdentityReadings.collect(realm, true));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'READ_FAILED');
  assert.equal(result.values.navigator.language, null);
  assert.equal(result.values.navigator.userAgent, 'own');
  assert.equal(result.values.date.localString, null);
  assert.doesNotMatch(JSON.stringify(result), /secret|private\.invalid/);
});

test('rejecting, malformed, non-callable and throwing entropy APIs are failures', async () => {
  for (const getHighEntropyValues of [() => Promise.reject(new Error('secret-url')), () => null, () => [], 42,
    () => ({ get model() { throw new Error('secret-model'); } })]) {
    const { realm } = timedRealm({ navigator: { userAgentData: { getHighEntropyValues } } });
    const result = plain(await realm.AbsIdentityReadings.collect(realm, false));
    assert.equal(result.status, 'failed');
    assert.equal(result.values.navigator.userAgentData.highEntropy.status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), /secret-url|secret-model/);
    assert.equal(realm.AbsIdentityReadings.validValues(result.values, false), true);
  }
});

test('an entropy getter exception is failed, not API unsupported', async () => {
  const { realm } = timedRealm({ navigator: { userAgentData: {
    get getHighEntropyValues() { throw new Error('secret'); }
  } } });
  const result = plain(await realm.AbsIdentityReadings.collect(realm, false));
  assert.equal(result.status, 'failed');
  assert.equal(result.values.navigator.userAgentData.highEntropy.status, 'failed');
});

test('a never-settling entropy request has a bounded deadline and null high values', async () => {
  const { realm, clock } = timedRealm({ navigator: { userAgentData: { getHighEntropyValues: () => new Promise(() => {}) } } });
  const pending = realm.AbsIdentityReadings.collect(realm, false);
  await flush();
  clock.advance(1200);
  const result = plain(await pending);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'UA_DATA_TIMEOUT');
  assert.equal(result.values.navigator.userAgentData.highEntropy.code, 'UA_DATA_TIMEOUT');
  assert.ok(Object.values(result.values.navigator.userAgentData.highEntropy.values).every((value) => value === null));
  assert.equal(clock.pending, 0);
});

test('invalid primitive types, nonfinite numbers and oversized fields do not become ok observations', async () => {
  const { realm } = timedRealm({ navigator: { language: 'a'.repeat(4097), languages: 'en',
    hardwareConcurrency: Infinity, maxTouchPoints: NaN, deviceMemory: '8' } });
  const result = plain(await realm.AbsIdentityReadings.collect(realm, false));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'READ_FAILED');
  for (const key of ['language', 'languages', 'hardwareConcurrency', 'maxTouchPoints', 'deviceMemory']) {
    assert.equal(result.values.navigator[key], null);
  }
});
