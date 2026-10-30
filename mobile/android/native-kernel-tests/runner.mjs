import {
  FIXTURE_ROOT, PROTOCOL, assessEnvelope, assessSnapshot, syntheticToken, validateConfiguration,
} from './model.mjs';

class Unsupported extends Error {}

export function realmPlan(realmId) {
  const definitions = [['window', 'Window: actual default Date / Intl']];
  for (const type of ['classic', 'module']) {
    definitions.push([`dedicated-${type}`, `${type} DedicatedWorker: entry + message`]);
    definitions.push([`dedicated-${type}-rebuilt`, `${type} DedicatedWorker: terminate() then create a new worker`]);
  }
  for (const parent of ['classic', 'module']) {
    for (const child of ['classic', 'module']) definitions.push([`nested-${parent}-${child}`, `Nested DedicatedWorker: ${parent} parent → ${child} child`]);
  }
  for (const type of ['classic', 'module']) {
    definitions.push([`shared-${type}`, `${type} SharedWorker: initial connection`]);
    definitions.push([`shared-${type}-reconnect`, `${type} SharedWorker: close port + reconnect (not a cold-start claim)`]);
  }
  for (const type of ['classic', 'module']) {
    definitions.push([`service-${type}`, `${type} ServiceWorker: install / activate / actual worker message`]);
    definitions.push([`service-${type}-message-again`, `${type} ServiceWorker: second active-worker message (not a restart)`]);
    definitions.push([`service-${type}-cleanup`, `${type} ServiceWorker: unregister only its exact owned scope + read back`]);
  }
  return definitions.map(([id, label]) => ({ id: `${realmId}/${id}`, label: `${realmId} · ${label}`, status: 'NOT_RUN', reason: 'Not executed.' }));
}

function errorText(error) {
  return `${String(error?.name ?? 'Error')}: ${String(error?.message ?? error)}`.slice(0, 600);
}

function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out; its completion is not proven.`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function workerPath(type) {
  return `${FIXTURE_ROOT}${type === 'module' ? 'realm-module.mjs' : 'realm-probe.js'}`;
}

function workerURL(config, realmId, type) {
  const url = new URL(workerPath(type), globalThis.location.origin);
  url.searchParams.set('runId', config.runId);
  url.searchParams.set('realmId', realmId);
  return url;
}

function command(config, action = 'sample', extra = {}) {
  return { protocol: PROTOCOL, action, runId: config.runId, requestId: syntheticToken(), ...extra };
}

function requestEndpoint(endpoint, errorTarget, message, milliseconds = 8000, send = () => endpoint.postMessage(message)) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out.')); }, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      endpoint.removeEventListener('message', onMessage);
      endpoint.removeEventListener('messageerror', onMessageError);
      errorTarget?.removeEventListener('error', onError);
    };
    const onMessage = (event) => {
      if (event.data?.requestId !== message.requestId) return;
      cleanup(); resolve(event.data);
    };
    const onMessageError = () => { cleanup(); reject(new Error('Worker message could not be decoded.')); };
    const onError = (event) => {
      event.preventDefault(); cleanup();
      reject(new Error('Worker emitted an error; script/module/API/CSP support is not a PASS.'));
    };
    endpoint.addEventListener('message', onMessage);
    endpoint.addEventListener('messageerror', onMessageError);
    errorTarget?.addEventListener('error', onError);
    if (typeof endpoint.start === 'function') endpoint.start();
    try { send(); } catch (error) { cleanup(); reject(error); }
  });
}

async function dedicatedRead(config, realmId, type, action = 'sample', extra = {}) {
  if (typeof Worker !== 'function') throw new Unsupported('DedicatedWorker is unavailable.');
  const worker = new Worker(workerURL(config, realmId, type), { type, name: `timezone-${realmId}-${syntheticToken()}` });
  const message = command(config, action, extra);
  let payload;
  try {
    payload = await requestEndpoint(worker, worker, message, action === 'nested-sample' ? 12000 : 8000);
  } finally {
    worker.terminate();
  }
  return { payload, requestId: message.requestId, terminationRequested: true };
}

function expectedEnvelope(config, type, requestId, realmKind = 'dedicated-worker', extra = {}) {
  return {
    expectedZone: config.expectedZone, runId: config.runId, requestId,
    executionMode: type, realmKind, scriptPath: workerPath(type), ...extra,
  };
}

function observed(assessment, evidence, extraFailures = []) {
  const failures = [...assessment.failures, ...extraFailures];
  return { status: failures.length ? 'FAIL' : 'PASS', reason: failures.length ? failures.join('\n') : 'Observed Date/Intl values match the selected profile and both named-zone controls.', evidence };
}

async function sharedRead(config, realmId, type) {
  if (typeof SharedWorker !== 'function') throw new Unsupported('SharedWorker is unavailable in this runtime.');
  const worker = new SharedWorker(workerURL(config, realmId, type), { type, name: `timezone-${config.runId}-${realmId}-${type}` });
  const message = command(config);
  let payload;
  try {
    payload = await requestEndpoint(worker.port, worker, message);
  } finally {
    worker.port.close(); // Port closure is not evidence of SharedWorker termination.
  }
  return { payload, requestId: message.requestId, portClosed: true };
}

function waitForActivation(registration) {
  return new Promise((resolve, reject) => {
    const observedWorkers = new Set();
    const timer = setTimeout(() => { cleanup(); reject(new Error('ServiceWorker activation timed out.')); }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      registration.removeEventListener('updatefound', check);
      for (const worker of observedWorkers) worker.removeEventListener('statechange', check);
    };
    const check = () => {
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (worker && !observedWorkers.has(worker)) {
          observedWorkers.add(worker);
          worker.addEventListener('statechange', check);
        }
      }
      if (registration.active?.state === 'activated') { cleanup(); resolve(registration.active); return; }
      if (observedWorkers.size && [...observedWorkers].every((worker) => worker.state === 'redundant')) {
        cleanup(); reject(new Error('The fixture ServiceWorker became redundant before activation.'));
      }
    };
    registration.addEventListener('updatefound', check);
    check();
  });
}

async function serviceMessage(activeWorker, config) {
  if (typeof MessageChannel !== 'function') throw new Unsupported('MessageChannel is unavailable.');
  const channel = new MessageChannel();
  const message = command(config);
  let payload;
  try {
    payload = await requestEndpoint(channel.port1, activeWorker, message, 8000,
      () => activeWorker.postMessage(message, [channel.port2]));
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
  return { payload, requestId: message.requestId };
}

async function unregisterOwned(registration, scope, script) {
  if (registration.scope !== scope) throw new Error('Refusing cleanup: registration scope is not exactly fixture-owned.');
  for (const worker of [registration.installing, registration.waiting, registration.active]) {
    if (worker && worker.scriptURL !== script) throw new Error('Refusing cleanup: an unexpected script occupies this scope.');
  }
  const removed = await deadline(registration.unregister(), 10000, 'Owned ServiceWorker unregister');
  const readBack = await deadline(navigator.serviceWorker.getRegistration(scope), 8000, 'Owned scope read-back');
  const exactRegistrationPresent = readBack?.scope === scope;
  return {
    status: removed && !exactRegistrationPresent ? 'PASS' : 'FAIL',
    reason: removed && !exactRegistrationPresent ? 'Exact owned registration removed; exact-scope read-back is absent. This does not prove worker process termination.' : 'Unregister/read-back did not prove removal of this exact owned registration.',
    evidence: { scope, script, unregisterReturned: removed, exactRegistrationPresent },
  };
}

export async function runRealm(input, realmId, onUpdate = () => {}) {
  const config = validateConfiguration(input, globalThis.location.origin, realmId);
  const steps = realmPlan(realmId);
  const row = (id) => steps.find((step) => step.id === `${realmId}/${id}`);
  const execute = async (id, operation) => {
    const step = row(id);
    step.status = 'RUNNING'; step.reason = 'Explicit fixture action in progress.'; onUpdate(steps);
    try {
      Object.assign(step, await operation());
    } catch (error) {
      step.status = error instanceof Unsupported ? 'UNSUPPORTED' : 'FAIL';
      step.reason = errorText(error);
    }
    onUpdate(steps);
    return step;
  };
  if (globalThis.isSecureContext !== true || navigator.serviceWorker?.controller) {
    row('window').status = 'FAIL';
    row('window').reason = 'Requires a trustworthy loopback secure context, not a page controlled by any existing ServiceWorker. No worker or registration was created.';
    onUpdate(steps); return steps;
  }
  await execute('window', async () => {
    if (typeof globalThis.NativeTimezoneFixtureProbe?.read !== 'function') throw new Error('Read-only probe script is not available.');
    const snapshot = globalThis.NativeTimezoneFixtureProbe.read('explicit-window-action');
    return observed(assessSnapshot(snapshot, config.expectedZone, 'explicit-window-action'), snapshot);
  });

  for (const type of ['classic', 'module']) {
    let first;
    const firstStep = await execute(`dedicated-${type}`, async () => {
      first = await dedicatedRead(config, realmId, type);
      return observed(assessEnvelope(first.payload, expectedEnvelope(config, type, first.requestId)), first);
    });
    await execute(`dedicated-${type}-rebuilt`, async () => {
      const rebuilt = await dedicatedRead(config, realmId, type);
      const failures = [];
      if (!first?.terminationRequested || firstStep.status !== 'PASS') failures.push('The predecessor was not both successfully sampled and terminated via DedicatedWorker.terminate().');
      if (rebuilt.payload?.instanceId === first?.payload?.instanceId) failures.push('The reconstructed worker did not have a distinct script instance identity.');
      return observed(assessEnvelope(rebuilt.payload, expectedEnvelope(config, type, rebuilt.requestId)), rebuilt, failures);
    });
  }
  for (const parentType of ['classic', 'module']) {
    for (const childType of ['classic', 'module']) {
      await execute(`nested-${parentType}-${childType}`, async () => {
        const result = await dedicatedRead(config, realmId, parentType, 'nested-sample', { childType });
        const assessment = assessEnvelope(result.payload, expectedEnvelope(config, parentType, result.requestId, 'dedicated-worker', { action: 'nested-result' }));
        const nested = result.payload?.nested;
        const failures = [];
        if (result.payload?.action !== 'nested-result') failures.push('No actual nested-worker result was returned.');
        if (result.payload?.nestedError) failures.push(`Nested worker failed: ${errorText(result.payload.nestedError)}`);
        if (!nested || nested.requestedType !== childType || nested.terminationRequested !== true || nested.childScriptPath !== workerPath(childType)) failures.push('Nested worker relationship/termination evidence is incomplete.');
        failures.push(...assessEnvelope(nested?.payload, expectedEnvelope(config, childType, nested?.childRequestId)).failures.map((failure) => `child: ${failure}`));
        if (nested?.payload?.instanceId === result.payload?.instanceId) failures.push('Parent and nested child must have different script instance identities.');
        return observed(assessment, result, failures);
      });
    }
  }
  for (const type of ['classic', 'module']) {
    let first;
    await execute(`shared-${type}`, async () => {
      first = await sharedRead(config, realmId, type);
      return observed(assessEnvelope(first.payload, expectedEnvelope(config, type, first.requestId, 'shared-worker')), first);
    });
    await execute(`shared-${type}-reconnect`, async () => {
      const next = await sharedRead(config, realmId, type);
      const relationship = first?.payload?.instanceId
        ? (first.payload.instanceId === next.payload?.instanceId ? 'same-script-instance' : 'different-script-instance') : 'previous-instance-unobserved';
      return observed(assessEnvelope(next.payload, expectedEnvelope(config, type, next.requestId, 'shared-worker')),
        { ...next, connectionRelationship: relationship, controlledColdStart: 'NOT_RUN' },
        first?.portClosed ? [] : ['No successfully sampled and closed predecessor connection was observed.']);
    });
  }
  for (const type of ['classic', 'module']) {
    const scope = new URL(`${FIXTURE_ROOT}sw/${config.runId}/${realmId}/${type}/`, globalThis.location.origin).href;
    const script = new URL('entry.js', scope).href;
    const state = { attempted: false, registration: null, active: null, expired: false, rejected: false, cleanupPromise: null };
    const cleanupStep = row(`service-${type}-cleanup`);
    const cleanupKnown = () => {
      if (!state.cleanupPromise) state.cleanupPromise = unregisterOwned(state.registration, scope, script);
      return state.cleanupPromise;
    };
    await execute(`service-${type}`, async () => {
      if (!('serviceWorker' in navigator)) throw new Unsupported('ServiceWorker is unavailable in this runtime.');
      if (typeof MessageChannel !== 'function') throw new Unsupported('MessageChannel is unavailable.');
      // Only this exact candidate scope is queried. Never enumerate registrations.
      const existing = await deadline(navigator.serviceWorker.getRegistration(scope), 8000, 'Exact-scope preflight');
      if (existing) throw new Error('A pre-existing registration covers the candidate fixture scope; it was neither replaced nor removed.');
      state.attempted = true;
      const pendingRegistration = navigator.serviceWorker.register(script, { scope, type, updateViaCache: 'none' });
      // Browser registration has no abort API. A late result may ONLY clean up
      // this owned reference; a deadline failure is never promoted to PASS.
      pendingRegistration.then((registration) => {
        state.registration = registration;
        if (state.expired) {
          cleanupKnown().then((observation) => {
            cleanupStep.lateCleanup = observation; onUpdate(steps);
          }, (error) => {
            cleanupStep.lateCleanup = { status: 'FAIL', reason: errorText(error) }; onUpdate(steps);
          });
        }
      }, (error) => {
        state.rejected = true;
        if (state.expired) { cleanupStep.lateRegistrationError = errorText(error); onUpdate(steps); }
      });
      try {
        state.registration = await deadline(pendingRegistration, 15000, 'Fixture ServiceWorker register');
      } catch (error) {
        state.expired = !state.rejected;
        throw error;
      }
      if (state.registration.scope !== scope) throw new Error('Browser returned a different ServiceWorker scope.');
      state.active = await waitForActivation(state.registration);
      const sample = await serviceMessage(state.active, config);
      return observed(assessEnvelope(sample.payload, expectedEnvelope(config, type, sample.requestId, 'service-worker', {
        scriptPath: new URL(script).pathname, serviceScope: scope, requireLifecycle: true,
      })), { ...sample, scope, script, controlledColdStart: 'NOT_RUN' });
    });
    await execute(`service-${type}-message-again`, async () => {
      if (!state.active || state.expired) return { status: 'NOT_RUN', reason: 'No activated worker from a completed registration is available.' };
      const sample = await serviceMessage(state.active, config);
      return observed(assessEnvelope(sample.payload, expectedEnvelope(config, type, sample.requestId, 'service-worker', {
        scriptPath: new URL(script).pathname, serviceScope: scope, requireLifecycle: false,
      })), { ...sample, scope, script, controlledColdStart: 'NOT_RUN' });
    });
    await execute(`service-${type}-cleanup`, async () => {
      if (!state.attempted) return { status: 'NOT_RUN', reason: 'No fixture registration was attempted; no registration was removed.' };
      if (state.expired) {
        // Also cover a resolution racing the deadline callback: the pending
        // promise may already have delivered a reference before expired was set.
        let cleanupObservation = null;
        if (state.registration) {
          try { cleanupObservation = await cleanupKnown(); }
          catch (error) { cleanupObservation = { status: 'FAIL', reason: errorText(error) }; }
        }
        return { status: 'FAIL', reason: 'Registration missed its deadline. Late exact-owned cleanup is attempted if a registration materializes; the missed deadline is never promoted to PASS.', evidence: { scope, script, cleanupObservation } };
      }
      if (!state.registration) return { status: 'NOT_RUN', reason: 'Registration failed before returning an owned registration reference; no other registrations were removed.', evidence: { scope, script } };
      return cleanupKnown();
    });
  }
  return steps;
}
