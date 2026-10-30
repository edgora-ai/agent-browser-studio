export const FIXTURE_ROOT = '/native-timezone-fixture/';
export const PROTOCOL = 'android-native-timezone-readonly-v1';
export const REALMS = Object.freeze(['main', 'same', 'cross']);
export const ZONES = Object.freeze({
  'America/New_York': Object.freeze({ winter: 300, summer: 240 }),
  'Asia/Shanghai': Object.freeze({ winter: -480, summer: -480 }),
});
export const INSTANTS = Object.freeze([
  Object.freeze({ season: 'winter', iso: '2026-01-15T12:00:00.000Z', epoch: 1768478400000 }),
  Object.freeze({ season: 'summer', iso: '2026-07-15T12:00:00.000Z', epoch: 1784116800000 }),
]);
export const STATUSES = Object.freeze(['NOT_RUN', 'RUNNING', 'PASS', 'FAIL', 'UNSUPPORTED']);
export const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function loopbackOrigin(input) {
  if (typeof input !== 'string') throw new Error('Provide an explicit loopback HTTP origin.');
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(input.trim());
  if (!match || Number(match[2]) < 1024 || Number(match[2]) > 65535) {
    throw new Error('Use http://127.0.0.1:PORT, http://localhost:PORT or http://[::1]:PORT; PORT must be 1024–65535.');
  }
  return new URL(input.trim()).origin;
}

export function validateConfiguration(input, locationOrigin, realmId = 'main') {
  const primaryOrigin = loopbackOrigin(input.primaryOrigin);
  const crossOrigin = loopbackOrigin(input.crossOrigin);
  if (primaryOrigin === crossOrigin) throw new Error('The two supplied origins must be different.');
  if (!REALMS.includes(realmId)) throw new Error('Unknown fixture realm.');
  const expectedOrigin = realmId === 'cross' ? crossOrigin : primaryOrigin;
  if (locationOrigin !== expectedOrigin) throw new Error('This fixture is not on the explicitly supplied origin.');
  if (!Object.hasOwn(ZONES, input.expectedZone)) throw new Error('Select an expected native timezone.');
  if (!TOKEN_PATTERN.test(input.runId)) throw new Error('Invalid synthetic run identifier.');
  return Object.freeze({ primaryOrigin, crossOrigin, expectedZone: input.expectedZone, runId: input.runId });
}

export function syntheticToken(cryptoObject = globalThis.crypto) {
  if (typeof cryptoObject?.getRandomValues !== 'function') throw new Error('Secure random identifiers are unavailable.');
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function aggregateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'NOT_RUN';
  const statuses = steps.map((step) => step.status);
  if (statuses.some((status) => !STATUSES.includes(status))) return 'FAIL';
  for (const status of ['FAIL', 'RUNNING', 'UNSUPPORTED', 'NOT_RUN']) {
    if (statuses.includes(status)) return status;
  }
  return statuses.every((status) => status === 'PASS') ? 'PASS' : 'NOT_RUN';
}

function localParts(epoch, offsetMinutes) {
  const localTimeline = new Date(epoch - offsetMinutes * 60000);
  return {
    year: localTimeline.getUTCFullYear(), month: localTimeline.getUTCMonth() + 1,
    day: localTimeline.getUTCDate(), hour: localTimeline.getUTCHours(),
    minute: localTimeline.getUTCMinutes(), second: localTimeline.getUTCSeconds(),
  };
}

function compareParts(actual, expected, prefix, failures) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) failures.push(`${prefix}.${key}: expected ${value}, observed ${String(actual?.[key])}`);
  }
}

function gmtToken(offset) {
  const absolute = Math.abs(offset);
  return `GMT${offset <= 0 ? '+' : '-'}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`;
}

function normalizeSpaces(value) {
  return typeof value === 'string' ? value.replace(/[  ]/g, ' ') : null;
}

export function assessSnapshot(snapshot, expectedZone, expectedPhase) {
  const failures = [];
  if (!Object.hasOwn(ZONES, expectedZone)) return { status: 'FAIL', failures: ['Invalid expected timezone.'] };
  if (!snapshot || snapshot.schemaVersion !== 1) return { status: 'FAIL', failures: ['Missing or invalid real Date/Intl snapshot.'] };
  if (snapshot.phase !== expectedPhase) failures.push(`Expected ${expectedPhase} observation, not ${String(snapshot.phase)}.`);
  if (!Array.isArray(snapshot.errors) || snapshot.errors.length !== 0) failures.push('One or more Date/Intl surfaces could not be read.');
  if (snapshot.defaultZone !== expectedZone) failures.push(`Default Intl zone must be ${expectedZone}; observed ${String(snapshot.defaultZone)}.`);
  if (snapshot.unqualifiedDefaultZone !== expectedZone) failures.push('Unqualified Intl default zone does not match the requested native profile.');
  if (!Array.isArray(snapshot.samples) || snapshot.samples.length !== INSTANTS.length) failures.push('Both default winter and summer observations are required.');
  for (const instant of INSTANTS) {
    const matches = Array.isArray(snapshot.samples) ? snapshot.samples.filter((sample) => sample?.season === instant.season) : [];
    if (matches.length !== 1) { failures.push(`Missing or duplicate ${instant.season} observation.`); continue; }
    const sample = matches[0];
    const expectedOffset = ZONES[expectedZone][instant.season];
    if (sample.iso !== instant.iso || sample.epoch !== instant.epoch || sample.isoRoundTrip !== instant.iso) failures.push(`${instant.season}: UTC input/epoch/ISO round-trip mismatch.`);
    if (sample.dateOffsetMinutes !== expectedOffset) failures.push(`${instant.season}: Date.getTimezoneOffset must be ${expectedOffset}; observed ${String(sample.dateOffsetMinutes)}.`);
    if (sample.intlOffsetMinutes !== expectedOffset) failures.push(`${instant.season}: default Intl offset must be ${expectedOffset}; observed ${String(sample.intlOffsetMinutes)}.`);
    const expectedParts = localParts(instant.epoch, expectedOffset);
    compareParts(sample.localParts, expectedParts, `${instant.season}.Date`, failures);
    compareParts(sample.intlParts, expectedParts, `${instant.season}.Intl`, failures);
    for (const field of ['localString', 'timeString']) {
      if (typeof sample[field] !== 'string' || !sample[field].includes(gmtToken(expectedOffset))) failures.push(`${instant.season}.${field}: missing expected numeric GMT offset.`);
    }
    if (typeof sample.intlString !== 'string' || !sample.intlString || normalizeSpaces(sample.localeString) !== normalizeSpaces(sample.intlString)) failures.push(`${instant.season}: Date.toLocaleString and default Intl.format disagree or are absent.`);
  }
  // Named-zone controls check tzdata only. They NEVER replace the default-zone checks above.
  if (!Array.isArray(snapshot.namedControls) || snapshot.namedControls.length !== 2) failures.push('Both named-zone tzdata controls are required.');
  for (const [zone, offsets] of Object.entries(ZONES)) {
    const controls = Array.isArray(snapshot.namedControls) ? snapshot.namedControls.filter((control) => control?.requestedZone === zone) : [];
    if (controls.length !== 1) { failures.push(`Missing or duplicate named-zone control: ${zone}.`); continue; }
    const control = controls[0];
    if (control.resolvedZone !== zone) failures.push(`Named-zone control resolved to a different zone: ${zone}.`);
    if (!Array.isArray(control.samples) || control.samples.length !== 2) failures.push(`Incomplete named-zone control: ${zone}.`);
    for (const instant of INSTANTS) {
      const matches = Array.isArray(control.samples) ? control.samples.filter((sample) => sample?.season === instant.season) : [];
      if (matches.length !== 1) { failures.push(`Missing/duplicate ${zone} ${instant.season} control.`); continue; }
      const sample = matches[0];
      if (sample.iso !== instant.iso || sample.epoch !== instant.epoch || sample.offsetMinutes !== offsets[instant.season]) failures.push(`${zone} ${instant.season}: named-zone offset/input mismatch.`);
      compareParts(sample.parts, localParts(instant.epoch, offsets[instant.season]), `${zone}.${instant.season}`, failures);
    }
  }
  return { status: failures.length ? 'FAIL' : 'PASS', failures };
}

export function assessEnvelope(payload, expected) {
  const failures = [];
  if (!TOKEN_PATTERN.test(expected.requestId) || !TOKEN_PATTERN.test(expected.runId)) failures.push('Expected worker request/run identity is invalid.');
  if (payload?.action !== (expected.action ?? 'sample-result')) failures.push('Unexpected worker reply action.');
  for (const field of ['protocol', 'requestId', 'runId', 'realmKind', 'executionMode', 'scriptPath']) {
    const value = field === 'protocol' ? PROTOCOL : expected[field];
    if (payload?.[field] !== value) failures.push(`Worker provenance mismatch: ${field}.`);
  }
  if (!TOKEN_PATTERN.test(payload?.instanceId)) failures.push('Worker instance identity is missing.');
  failures.push(...assessSnapshot(payload?.firstRead, expected.expectedZone, 'script-entry').failures.map((item) => `first read: ${item}`));
  failures.push(...assessSnapshot(payload?.snapshot, expected.expectedZone, 'message').failures.map((item) => `message read: ${item}`));
  if (expected.serviceScope) {
    if (payload?.serviceScope !== expected.serviceScope) failures.push('Response did not originate from the exact fixture ServiceWorker scope.');
    if (expected.requireLifecycle) {
      for (const phase of ['install', 'activate']) {
        failures.push(...assessSnapshot(payload?.eventReads?.[phase], expected.expectedZone, phase).failures.map((item) => `${phase}: ${item}`));
      }
    }
  }
  return { status: failures.length ? 'FAIL' : 'PASS', failures };
}

export function lifecycleLimitations(expectedZone) {
  const otherZone = Object.keys(ZONES).find((zone) => zone !== expectedZone);
  return [
    ['shared-worker-controlled-stop', 'SharedWorker actual stop / controlled cold start', 'Closing/reopening a MessagePort does not establish worker termination or a controlled cold start.'],
    ['service-worker-controlled-stop', 'ServiceWorker actual stop / controlled cold start', 'Register, activate, message, reconnect and unregister do not establish that the service worker process stopped.'],
    ['browser-restart', 'Browser / content-shell restart', 'No browser restart is performed or proven by this page.'],
    ['android-background', 'Android background / resume', 'No Android background/resume transition is performed or proven.'],
    ['host-timezone-notification', 'Host timezone notification', 'No host timezone is changed and no native timezone notification is generated or observed.'],
    ['other-native-profile', `Separate native profile: ${otherZone ?? 'not selected'}`, 'A named Intl control is not a run with that default native timezone; perform a separate externally configured run.'],
    ['native-runtime-provenance', 'Native patch / APK provenance', 'This web fixture does not attest which APK, native patch or launch configuration is running.'],
  ].map(([id, label, reason]) => ({ id, label, status: 'NOT_RUN', reason }));
}
