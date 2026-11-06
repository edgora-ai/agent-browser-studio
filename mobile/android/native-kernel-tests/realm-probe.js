const nativeTimezoneFirstRead = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope ? nativeTimezoneRead('script-entry') : null;

// The statement above is the first executable statement in EVERY worker entry.
// The loopback server uses this exact body for classic entries and appends only
// a module-only trailer for module entries. No import, message or setter precedes it.
function nativeTimezoneRead(phase) {
  const result = {
    schemaVersion: 1, phase, defaultZone: null, unqualifiedDefaultZone: null,
    samples: [], namedControls: [], errors: [],
  };
  const instants = [
    { season: 'winter', iso: '2026-01-15T12:00:00.000Z' },
    { season: 'summer', iso: '2026-07-15T12:00:00.000Z' },
  ];
  const options = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  };
  let formatter;
  try {
    result.unqualifiedDefaultZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    formatter = new Intl.DateTimeFormat('en-US', options);
    result.defaultZone = formatter.resolvedOptions().timeZone;
  } catch (error) {
    result.errors.push({ surface: 'default Intl', ...nativeTimezoneError(error) });
  }
  for (const instant of instants) {
    const sample = { ...instant };
    try {
      const date = new Date(instant.iso);
      sample.epoch = date.getTime();
      sample.isoRoundTrip = date.toISOString();
      sample.dateOffsetMinutes = date.getTimezoneOffset();
      sample.localParts = {
        year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
        hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
      };
      sample.localString = date.toString();
      sample.timeString = date.toTimeString();
      sample.localeString = date.toLocaleString('en-US', options);
      if (formatter) {
        sample.intlString = formatter.format(date);
        sample.intlParts = nativeTimezoneParts(formatter.formatToParts(date));
        sample.intlOffsetMinutes = nativeTimezoneOffset(sample.epoch, sample.intlParts);
      }
    } catch (error) {
      result.errors.push({ surface: `default ${instant.season}`, ...nativeTimezoneError(error) });
    }
    result.samples.push(sample);
  }
  for (const zone of ['America/New_York', 'Asia/Shanghai']) {
    const control = { requestedZone: zone, resolvedZone: null, samples: [] };
    try {
      // A named-zone formatter is a tzdata control, NOT an override of defaults.
      const named = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
      control.resolvedZone = named.resolvedOptions().timeZone;
      for (const instant of instants) {
        const date = new Date(instant.iso);
        const parts = nativeTimezoneParts(named.formatToParts(date));
        control.samples.push({
          ...instant, epoch: date.getTime(), parts,
          offsetMinutes: nativeTimezoneOffset(date.getTime(), parts), text: named.format(date),
        });
      }
    } catch (error) {
      result.errors.push({ surface: `named ${zone}`, ...nativeTimezoneError(error) });
    }
    result.namedControls.push(control);
  }
  return result;
}

function nativeTimezoneParts(parts) {
  const result = {};
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
    const matches = parts.filter((part) => part.type === key);
    if (matches.length !== 1 || !/^[0-9]+$/.test(matches[0].value)) throw new Error(`Invalid Intl ${key} part.`);
    result[key] = Number(matches[0].value);
  }
  return result;
}

function nativeTimezoneOffset(epoch, parts) {
  const localTimeline = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (epoch - localTimeline) / 60000;
}

function nativeTimezoneError(error) {
  return { name: String(error?.name ?? 'Error').slice(0, 80), message: String(error?.message ?? error).slice(0, 240) };
}

function nativeTimezoneToken() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function nativeTimezoneKind() {
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) return 'service-worker';
  if (typeof SharedWorkerGlobalScope !== 'undefined' && globalThis instanceof SharedWorkerGlobalScope) return 'shared-worker';
  if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) return 'dedicated-worker';
  if (typeof document !== 'undefined') return 'window';
  return 'unrecognized';
}

function nativeTimezoneRunId() {
  const ownURL = new URL(globalThis.location.href);
  const scopeMatch = /^\/native-timezone-fixture\/sw\/([a-f0-9]{32})\/(main|same|cross)\/(classic|module)\/entry\.js$/.exec(ownURL.pathname);
  return scopeMatch ? scopeMatch[1] : ownURL.searchParams.get('runId');
}

function nativeTimezoneValidRequest(data) {
  return data?.protocol === 'android-native-timezone-readonly-v1'
    && /^[a-f0-9]{32}$/.test(data.requestId)
    && /^[a-f0-9]{32}$/.test(data.runId)
    && data.runId === nativeTimezoneRunId();
}

function nativeTimezoneEnvelope(data) {
  return {
    protocol: 'android-native-timezone-readonly-v1', action: 'sample-result',
    requestId: data.requestId, runId: data.runId,
    realmKind: nativeTimezoneRealmKind, instanceId: nativeTimezoneInstanceId,
    executionMode: globalThis.NativeTimezoneFixtureModuleExecuted === true ? 'module' : 'classic',
    scriptPath: globalThis.location.pathname,
    firstRead: nativeTimezoneFirstRead, snapshot: nativeTimezoneRead('message'),
    serviceScope: nativeTimezoneRealmKind === 'service-worker' ? globalThis.registration.scope : null,
    eventReads: nativeTimezoneRealmKind === 'service-worker' ? { ...nativeTimezoneEventReads } : null,
  };
}

async function nativeTimezoneNested(data) {
  if (!['classic', 'module'].includes(data.childType)) throw new Error('Invalid nested worker type.');
  if (typeof Worker !== 'function') throw new Error('Nested DedicatedWorker is unavailable.');
  const parentURL = new URL(globalThis.location.href);
  const path = `/native-timezone-fixture/${data.childType === 'module' ? 'realm-module.mjs' : 'realm-probe.js'}`;
  const childURL = new URL(path, parentURL.origin);
  childURL.searchParams.set('runId', data.runId);
  childURL.searchParams.set('realmId', parentURL.searchParams.get('realmId'));
  const childRequestId = nativeTimezoneToken();
  if (!childRequestId) throw new Error('Cannot identify the nested worker request.');
  const child = new Worker(childURL.href, { type: data.childType, name: `timezone-nested-${childRequestId}` });
  let payload;
  try {
    payload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Nested worker response timed out.')); }, 8000);
      const cleanup = () => {
        clearTimeout(timer);
        child.removeEventListener('message', onMessage);
        child.removeEventListener('error', onError);
        child.removeEventListener('messageerror', onMessageError);
      };
      const onMessage = (event) => {
        if (event.data?.requestId !== childRequestId || event.data?.protocol !== data.protocol) return;
        cleanup(); resolve(event.data);
      };
      const onError = (event) => { event.preventDefault(); cleanup(); reject(new Error('Nested worker emitted an error.')); };
      const onMessageError = () => { cleanup(); reject(new Error('Nested worker message could not be decoded.')); };
      child.addEventListener('message', onMessage);
      child.addEventListener('error', onError);
      child.addEventListener('messageerror', onMessageError);
      try {
        child.postMessage({ protocol: data.protocol, action: 'sample', requestId: childRequestId, runId: data.runId });
      } catch (error) {
        cleanup(); reject(error);
      }
    });
  } finally {
    child.terminate();
  }
  return { requestedType: data.childType, childRequestId, childScriptPath: path, payload, terminationRequested: true };
}

const nativeTimezoneRealmKind = nativeTimezoneKind();
const nativeTimezoneInstanceId = nativeTimezoneRealmKind === 'window' ? null : nativeTimezoneToken();
const nativeTimezoneEventReads = { install: null, activate: null };

if (nativeTimezoneRealmKind === 'window') {
  // This is a fixture-owned namespace, not a replacement for any built-in.
  // Installing it reads NO Date/Intl values until the explicit run action.
  Object.defineProperty(globalThis, 'NativeTimezoneFixtureProbe', {
    value: Object.freeze({ read: nativeTimezoneRead }), writable: false, configurable: false,
  });
} else if (nativeTimezoneRealmKind === 'service-worker') {
  globalThis.addEventListener('install', (event) => {
    nativeTimezoneEventReads.install = nativeTimezoneRead('install');
    event.waitUntil(globalThis.skipWaiting());
  });
  globalThis.addEventListener('activate', (event) => {
    nativeTimezoneEventReads.activate = nativeTimezoneRead('activate');
    // Deliberately no clients.claim(), fetch handler, CacheStorage or IndexedDB.
    event.waitUntil(Promise.resolve());
  });
  globalThis.addEventListener('message', (event) => {
    if (!nativeTimezoneValidRequest(event.data) || event.data.action !== 'sample' || event.ports.length !== 1) return;
    if (typeof event.source?.url !== 'string') return;
    const clientURL = new URL(event.source.url);
    if (clientURL.origin !== globalThis.location.origin
        || !['/native-timezone-fixture/index.html', '/native-timezone-fixture/', '/native-timezone-fixture/frame.html'].includes(clientURL.pathname)) return;
    // This callback runs in ServiceWorkerGlobalScope and replies through the
    // MessagePort transferred directly to registration.active, never a frame callback.
    const reply = nativeTimezoneEnvelope(event.data);
    event.ports[0].postMessage(reply);
    event.ports[0].close();
    event.waitUntil(Promise.resolve());
  });
} else if (nativeTimezoneRealmKind === 'shared-worker') {
  globalThis.addEventListener('connect', (event) => {
    for (const port of event.ports) {
      port.addEventListener('message', (message) => {
        if (nativeTimezoneValidRequest(message.data) && message.data.action === 'sample') port.postMessage(nativeTimezoneEnvelope(message.data));
      });
      port.start();
    }
  });
} else if (nativeTimezoneRealmKind === 'dedicated-worker') {
  globalThis.addEventListener('message', (event) => {
    if (!nativeTimezoneValidRequest(event.data)) return;
    if (event.data.action === 'sample') {
      globalThis.postMessage(nativeTimezoneEnvelope(event.data));
    } else if (event.data.action === 'nested-sample') {
      nativeTimezoneNested(event.data).then(
        (nested) => globalThis.postMessage({ ...nativeTimezoneEnvelope(event.data), action: 'nested-result', nested }),
        (error) => globalThis.postMessage({ ...nativeTimezoneEnvelope(event.data), action: 'nested-result', nestedError: nativeTimezoneError(error) }),
      );
    }
  });
}
