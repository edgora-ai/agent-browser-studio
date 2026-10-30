import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_ROOT, INSTANTS, PROTOCOL, ZONES, aggregateSteps, assessEnvelope,
  assessSnapshot, lifecycleLimitations, loopbackOrigin, validateConfiguration,
} from './model.mjs';
import { realmPlan } from './runner.mjs';
import { MODULE_TRAILER, parseArguments, planRequest, responseHeaders, serverOrigins } from './server.mjs';

// Pure synthetic data. Test bodies never bind sockets, launch a browser/worker/
// APK, call child_process, create databases/directories, or access account data.
// Node's own test-runner isolation is not an external runtime acceptance probe.
// Passing these oracle tests would NOT be a native/browser acceptance result.
const OPTIONS = parseArguments(['--primary-port', '41001', '--cross-port', '41002']);
const [PRIMARY, CROSS] = serverOrigins(OPTIONS);
const RUN = 'a'.repeat(32);
const REQUEST = 'b'.repeat(32);
const INSTANCE = 'c'.repeat(32);
const PARTS = {
  'America/New_York': {
    winter: { year: 2026, month: 1, day: 15, hour: 7, minute: 0, second: 0 },
    summer: { year: 2026, month: 7, day: 15, hour: 8, minute: 0, second: 0 },
  },
  'Asia/Shanghai': {
    winter: { year: 2026, month: 1, day: 15, hour: 20, minute: 0, second: 0 },
    summer: { year: 2026, month: 7, day: 15, hour: 20, minute: 0, second: 0 },
  },
};
const GMT = { 'America/New_York': { winter: 'GMT-0500', summer: 'GMT-0400' }, 'Asia/Shanghai': { winter: 'GMT+0800', summer: 'GMT+0800' } };

function snapshot(zone = 'America/New_York', phase = 'message') {
  return {
    schemaVersion: 1, phase, defaultZone: zone, unqualifiedDefaultZone: zone, errors: [],
    samples: INSTANTS.map((instant) => ({
      season: instant.season, iso: instant.iso, epoch: instant.epoch, isoRoundTrip: instant.iso,
      dateOffsetMinutes: ZONES[zone][instant.season], intlOffsetMinutes: ZONES[zone][instant.season],
      localParts: { ...PARTS[zone][instant.season] }, intlParts: { ...PARTS[zone][instant.season] },
      localString: `synthetic ${GMT[zone][instant.season]}`, timeString: `synthetic ${GMT[zone][instant.season]}`,
      localeString: `synthetic ${instant.season}`, intlString: `synthetic ${instant.season}`,
    })),
    namedControls: Object.entries(ZONES).map(([controlZone, offsets]) => ({
      requestedZone: controlZone, resolvedZone: controlZone,
      samples: INSTANTS.map((instant) => ({
        season: instant.season, iso: instant.iso, epoch: instant.epoch,
        offsetMinutes: offsets[instant.season], parts: { ...PARTS[controlZone][instant.season] }, text: 'synthetic control',
      })),
    })),
  };
}

function envelope(overrides = {}) {
  return {
    protocol: PROTOCOL, action: 'sample-result', requestId: REQUEST, runId: RUN,
    realmKind: 'dedicated-worker', instanceId: INSTANCE, executionMode: 'classic',
    scriptPath: `${FIXTURE_ROOT}realm-probe.js`,
    firstRead: snapshot('America/New_York', 'script-entry'), snapshot: snapshot(),
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    expectedZone: 'America/New_York', requestId: REQUEST, runId: RUN,
    realmKind: 'dedicated-worker', executionMode: 'classic', scriptPath: `${FIXTURE_ROOT}realm-probe.js`,
    ...overrides,
  };
}

function request(target = `${FIXTURE_ROOT}index.html`, changes = {}) {
  return planRequest({ method: 'GET', host: `127.0.0.1:${OPTIONS.primaryPort}`, target, ...changes }, OPTIONS, OPTIONS.primaryPort);
}

test('requires two explicit canonical loopback origins, exact page origin and an expected native profile', () => {
  assert.equal(loopbackOrigin(`${PRIMARY}/`), PRIMARY);
  assert.equal(loopbackOrigin('http://localhost:41001'), 'http://localhost:41001');
  assert.equal(loopbackOrigin('http://[::1]:41001'), 'http://[::1]:41001');
  const input = { primaryOrigin: PRIMARY, crossOrigin: CROSS, expectedZone: 'America/New_York', runId: RUN };
  assert.equal(validateConfiguration(input, PRIMARY).primaryOrigin, PRIMARY);
  assert.equal(validateConfiguration(input, CROSS, 'cross').crossOrigin, CROSS);
  for (const value of ['', 'http://127.0.0.1', 'https://127.0.0.1:41001', 'http://example.invalid:41001',
    'http://0.0.0.0:41001', 'http://127.1:41001', 'http://2130706433:41001', 'http://127.0.0.2:41001',
    'http://user:pass@127.0.0.1:41001', `${PRIMARY}/account`, `${PRIMARY}?key=synthetic`, `${PRIMARY}#x`,
    'http://127.0.0.1:80', 'http://127.0.0.1:65536', 'http://127.0.0.1:041001']) assert.throws(() => loopbackOrigin(value));
  assert.throws(() => validateConfiguration({ ...input, crossOrigin: PRIMARY }, PRIMARY));
  assert.throws(() => validateConfiguration({ ...input, expectedZone: 'UTC' }, PRIMARY));
  assert.throws(() => validateConfiguration({ ...input, runId: '' }, PRIMARY));
  assert.throws(() => validateConfiguration(input, CROSS));
});

test('literal winter/summer expectations are UTC-minus-local Date offsets', () => {
  assert.deepEqual(ZONES['America/New_York'], { winter: 300, summer: 240 });
  assert.deepEqual(ZONES['Asia/Shanghai'], { winter: -480, summer: -480 });
  assert.deepEqual(INSTANTS.map((instant) => instant.iso), ['2026-01-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z']);
  assert.equal(assessSnapshot(snapshot(), 'America/New_York', 'message').status, 'PASS');
  assert.equal(assessSnapshot(snapshot('Asia/Shanghai'), 'Asia/Shanghai', 'message').status, 'PASS');
});

test('correct named controls never compensate for wrong default Date or Intl timezone', () => {
  const observed = snapshot();
  observed.samples[1].dateOffsetMinutes = 300;
  assert.equal(assessSnapshot(observed, 'America/New_York', 'message').status, 'FAIL');
  observed.samples[1].dateOffsetMinutes = 240;
  observed.defaultZone = 'UTC';
  assert.equal(assessSnapshot(observed, 'America/New_York', 'message').status, 'FAIL');
  observed.defaultZone = 'America/New_York';
  observed.samples[0].intlOffsetMinutes = -480;
  assert.equal(assessSnapshot(observed, 'America/New_York', 'message').status, 'FAIL');
});

test('missing/duplicate seasons, stale local fields, stale GMT text and failed reads are not PASS', () => {
  for (const damage of [
    (item) => { item.samples.pop(); },
    (item) => { item.samples[1] = item.samples[0]; },
    (item) => { item.samples[0].localParts.hour = 12; },
    (item) => { item.samples[0].intlParts.hour = 12; },
    (item) => { item.samples[1].localString = 'synthetic GMT-0500'; },
    (item) => { item.samples[0].isoRoundTrip = 'not an ISO timestamp'; },
    (item) => { item.samples[0].localeString = 'a different value'; },
    (item) => { item.samples[0].intlString = ''; item.samples[0].localeString = ''; },
    (item) => { item.errors.push({ surface: 'Date', message: 'synthetic failure' }); },
    (item) => { item.namedControls.pop(); },
    (item) => { item.namedControls[0].samples[1].offsetMinutes = 300; },
    (item) => { item.unqualifiedDefaultZone = 'UTC'; },
  ]) {
    const observed = snapshot(); damage(observed);
    assert.equal(assessSnapshot(observed, 'America/New_York', 'message').status, 'FAIL');
  }
  assert.equal(assessSnapshot(null, 'America/New_York', 'message').status, 'FAIL');
});

test('worker first-script read is mandatory and independent of its later message callback', () => {
  assert.equal(assessEnvelope(envelope(), expected()).status, 'PASS');
  for (const overrides of [
    { firstRead: null }, { firstRead: snapshot() }, { instanceId: null },
    { executionMode: 'module' }, { runId: 'd'.repeat(32) }, { requestId: 'e'.repeat(32) },
    { scriptPath: `${FIXTURE_ROOT}frame.html` }, { protocol: 'other' }, { action: 'frame-result' },
  ]) assert.equal(assessEnvelope(envelope(overrides), expected()).status, 'FAIL');
  assert.equal(assessEnvelope(envelope(), expected({ requestId: undefined })).status, 'FAIL');
  const damaged = envelope(); damaged.firstRead.samples[0].dateOffsetMinutes = 0;
  assert.equal(assessEnvelope(damaged, expected()).status, 'FAIL');
});

test('ServiceWorker requires an actual worker-shaped response, exact scope, install and activate observations', () => {
  const scope = `${PRIMARY}${FIXTURE_ROOT}sw/${RUN}/main/module/`;
  const scriptPath = new URL('entry.js', scope).pathname;
  const want = expected({ realmKind: 'service-worker', executionMode: 'module', scriptPath, serviceScope: scope, requireLifecycle: true });
  const observed = envelope({ realmKind: 'service-worker', executionMode: 'module', scriptPath, serviceScope: scope,
    eventReads: { install: snapshot('America/New_York', 'install'), activate: snapshot('America/New_York', 'activate') } });
  assert.equal(assessEnvelope(observed, want).status, 'PASS');
  for (const overrides of [
    { realmKind: 'window' }, { serviceScope: `${PRIMARY}/` }, { scriptPath: `${FIXTURE_ROOT}frame.html` },
    { eventReads: null }, { eventReads: { install: null, activate: null } }, { executionMode: 'classic' },
  ]) assert.equal(assessEnvelope({ ...observed, ...overrides }, want).status, 'FAIL');
  observed.eventReads.activate = snapshot('America/New_York', 'message');
  assert.equal(assessEnvelope(observed, want).status, 'FAIL');
});

test('unsupported, unrun, empty, running or failed coverage is never aggregate PASS', () => {
  assert.equal(aggregateSteps([]), 'NOT_RUN');
  assert.equal(aggregateSteps([{ status: 'PASS' }]), 'PASS');
  for (const status of ['NOT_RUN', 'UNSUPPORTED', 'RUNNING', 'FAIL', 'SKIPPED', undefined]) {
    assert.notEqual(aggregateSteps([{ status: 'PASS' }, { status }]), 'PASS');
  }
  const limitations = lifecycleLimitations('America/New_York');
  for (const id of ['shared-worker-controlled-stop', 'service-worker-controlled-stop', 'browser-restart', 'android-background', 'host-timezone-notification', 'other-native-profile', 'native-runtime-provenance']) {
    assert.equal(limitations.find((step) => step.id === id)?.status, 'NOT_RUN');
  }
  assert.equal(aggregateSteps([{ status: 'PASS' }, ...limitations]), 'NOT_RUN');
});

test('all three realms plan the full worker matrix and start only as NOT_RUN', () => {
  for (const realm of ['main', 'same', 'cross']) {
    const plan = realmPlan(realm);
    assert.equal(plan.length, 19);
    assert.equal(new Set(plan.map((step) => step.id)).size, 19);
    assert.ok(plan.every((step) => step.status === 'NOT_RUN'));
    for (const type of ['classic', 'module']) {
      for (const suffix of [`dedicated-${type}`, `dedicated-${type}-rebuilt`, `shared-${type}`, `shared-${type}-reconnect`, `service-${type}`, `service-${type}-message-again`, `service-${type}-cleanup`]) {
        assert.ok(plan.some((step) => step.id === `${realm}/${suffix}`));
      }
      for (const child of ['classic', 'module']) assert.ok(plan.some((step) => step.id === `${realm}/nested-${type}-${child}`));
    }
  }
});

test('server argument parser has no implicit ports, public host, arbitrary root or unbounded option', () => {
  assert.throws(() => parseArguments([]));
  assert.throws(() => parseArguments(['--primary-port', '41001']));
  for (const extra of [['--host', '0.0.0.0'], ['--root', '/'], ['--max-seconds', '901'], ['--max-requests', '2049']]) {
    assert.throws(() => parseArguments(['--primary-port', '41001', '--cross-port', '41002', ...extra]));
  }
  assert.throws(() => parseArguments(['--primary-port', '41001', '--cross-port', '41001']));
  assert.throws(() => parseArguments(['--primary-port', '41001', '--cross-port', '41002', '--primary-port', '41003']));
  assert.throws(() => parseArguments(['--primary-port', 'NaN', '--cross-port', '41002']));
  assert.equal(OPTIONS.maxSeconds, 900);
  assert.equal(OPTIONS.maxRequests, 512);
});

test('server serves only constant fixture files and exact isolated synthetic SW routes', () => {
  assert.equal(request().file, 'index.html');
  assert.equal(request(FIXTURE_ROOT).file, 'index.html');
  const query = `?runId=${RUN}&realmId=cross`;
  assert.equal(request(`${FIXTURE_ROOT}realm-probe.js${query}`).module, false);
  assert.equal(request(`${FIXTURE_ROOT}realm-module.mjs${query}`).module, true);
  for (const realm of ['main', 'same', 'cross']) {
    for (const type of ['classic', 'module']) {
      const plan = request(`${FIXTURE_ROOT}sw/${RUN}/${realm}/${type}/entry.js`);
      assert.equal(plan.status, 200);
      assert.equal(plan.file, 'realm-probe.js');
      assert.equal(plan.module, type === 'module');
    }
  }
  for (const target of ['/', '/etc/passwd', `${FIXTURE_ROOT}README.md`, `${FIXTURE_ROOT}server.mjs`, `${FIXTURE_ROOT}fixture.test.mjs`,
    `${FIXTURE_ROOT}../model.mjs`, `${FIXTURE_ROOT}sw/${RUN}/unknown/classic/entry.js`, `${FIXTURE_ROOT}sw/${RUN}/main/classic/other.js`,
    `${FIXTURE_ROOT}sw/not-a-token/main/classic/entry.js`]) assert.notEqual(request(target).status, 200);
});

test('server rejects traversal, encoded/absolute targets, undeclared queries, bodies via method, and rebinding authorities', () => {
  for (const target of [`${FIXTURE_ROOT}%2e%2e/model.mjs`, '//127.0.0.1/account', `${PRIMARY}${FIXTURE_ROOT}index.html`,
    `${FIXTURE_ROOT}index.html?anything=1`, `${FIXTURE_ROOT}realm-probe.js?runId=${RUN}&realmId=main&extra=x`,
    `${FIXTURE_ROOT}realm-probe.js?runId=${RUN}&runId=${RUN}&realmId=main`, `${FIXTURE_ROOT}realm-probe.js?runId=${RUN}`, `${FIXTURE_ROOT}index.html#fragment`,
    `${FIXTURE_ROOT}realm-probe.js?runId=${RUN}&realmId=main%00`, `${FIXTURE_ROOT}file\\name`, `${FIXTURE_ROOT}index.html${String.fromCharCode(0)}`]) assert.notEqual(request(target).status, 200);
  assert.equal(request(undefined, { method: 'POST' }).status, 405);
  assert.equal(request(undefined, { method: 'HEAD' }).status, 200);
  assert.equal(request(undefined, { host: 'example.invalid:41001' }).status, 421);
  assert.equal(request(undefined, { host: '127.0.0.1:41002' }).status, 421);
  assert.equal(request(undefined, { origin: 'http://example.invalid:41001' }).status, 403);
  assert.equal(request(undefined, { origin: CROSS }).status, 200);
});

test('generated module tail forces module parsing without an import ahead of first-read source', () => {
  assert.match(MODULE_TRAILER, /export\s*\{\s*\}/);
  assert.match(MODULE_TRAILER, /NativeTimezoneFixtureModuleExecuted = true/);
  assert.doesNotMatch(MODULE_TRAILER, /\bimport\b|Date\.|Intl\.|Navigator\.|fetch\(/);
});

test('response policy confines framing and script loads without broad SW scope or credential output', () => {
  const headers = responseHeaders(OPTIONS, 'text/html; charset=utf-8', 123);
  assert.equal(headers['Content-Length'], 123);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.match(headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.ok(headers['Content-Security-Policy'].includes(`frame-src ${PRIMARY} ${CROSS}`));
  assert.equal(headers['Service-Worker-Allowed'], undefined);
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(headers['Set-Cookie'], undefined);
});
