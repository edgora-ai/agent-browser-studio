import {
  FIXTURE_ROOT, PROTOCOL, STATUSES, aggregateSteps, lifecycleLimitations,
  syntheticToken, validateConfiguration,
} from './model.mjs';
import { realmPlan, runRealm } from './runner.mjs';

const form = document.getElementById('fixture-form');
const status = document.getElementById('run-status');
const body = document.getElementById('results-body');
const raw = document.getElementById('raw-report');
const frames = document.getElementById('fixture-frames');
let started = false;
let report = null;

function replaceRealmSteps(next) {
  const byId = new Map(next.map((step) => [step.id, step]));
  report.steps = report.steps.map((step) => byId.get(step.id) ?? step);
}

function render() {
  if (!report) return;
  const observations = report.steps.filter((step) => step.id.includes('/'));
  report.automatedObservationStatus = aggregateSteps(observations);
  report.fullCoverageStatus = aggregateSteps(report.steps);
  status.textContent = `${report.runState} — automated observations: ${report.automatedObservationStatus}; full coverage: ${report.fullCoverageStatus}; native acceptance: NOT_RUN.`;
  const fragment = document.createDocumentFragment();
  for (const step of report.steps) {
    const tr = document.createElement('tr');
    tr.dataset.status = step.status;
    for (const text of [step.label, step.status, step.reason]) {
      const td = document.createElement('td');
      td.textContent = text ?? '';
      tr.append(td);
    }
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  const json = JSON.stringify(report, null, 2);
  if (json.length > 2 * 1024 * 1024) {
    // Never silently truncate a successful-looking evidence report.
    report.rawEvidenceComplete = false;
    if (!report.steps.some((step) => step.id === 'report-size')) {
      report.steps.push({ id: 'report-size', label: 'Bounded evidence output', status: 'FAIL', reason: 'JSON exceeded the 2,097,152 UTF-16-code-unit display bound; a complete exported result is unavailable.' });
      render(); return;
    }
    raw.textContent = JSON.stringify({ nativeAcceptance: 'NOT_RUN', status: 'FAIL', rawEvidenceComplete: false, reason: 'Evidence display exceeded its bound. This is not acceptance.' }, null, 2);
  } else {
    raw.textContent = json;
  }
}

function validateFrameSteps(steps, realmId) {
  const expected = new Set(realmPlan(realmId).map((step) => step.id));
  if (!Array.isArray(steps) || steps.length !== expected.size) throw new Error('Frame returned an incomplete observation plan.');
  if (JSON.stringify(steps).length > 1024 * 1024) throw new Error('Frame result exceeded the synthetic evidence bound.');
  for (const step of steps) {
    if (!expected.delete(step?.id) || !STATUSES.includes(step.status) || step.status === 'RUNNING'
        || typeof step.label !== 'string' || typeof step.reason !== 'string') throw new Error('Frame returned malformed or nonterminal observations.');
  }
  if (expected.size) throw new Error('Frame did not return every planned observation.');
}

function runFrame(config, realmId) {
  const origin = realmId === 'cross' ? config.crossOrigin : config.primaryOrigin;
  const frame = document.createElement('iframe');
  frame.id = `fixture-frame-${realmId}`;
  frame.title = `${realmId}-origin synthetic timezone fixture`;
  frame.referrerPolicy = 'no-referrer';
  // No credential store or external page is read. The only destination is the
  // fixed synthetic frame route on one of the two explicitly approved origins.
  return new Promise((resolve, reject) => {
    let sent = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Frame run timed out. Its unreported checks are NOT_RUN, not PASS. The frame is retained for any pending exact-owned ServiceWorker cleanup; completion is unknown.'));
    }, 300000);
    const cleanup = () => {
      clearTimeout(timer);
      globalThis.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onError);
    };
    const onLoad = () => {
      if (sent) return;
      sent = true;
      frame.contentWindow.postMessage({ protocol: PROTOCOL, action: 'run-realm', realmId, config }, origin);
    };
    const onError = () => { cleanup(); reject(new Error('Synthetic iframe could not be loaded.')); };
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== origin
          || event.data?.protocol !== PROTOCOL || event.data.action !== 'realm-results'
          || event.data.runId !== config.runId || event.data.realmId !== realmId) return;
      cleanup();
      try {
        if (event.data.error) throw new Error(`Frame failed: ${String(event.data.error).slice(0, 600)}`);
        validateFrameSteps(event.data.steps, realmId);
        resolve(event.data.steps);
      } catch (error) { reject(error); }
    };
    globalThis.addEventListener('message', onMessage);
    frame.addEventListener('load', onLoad);
    frame.addEventListener('error', onError);
    frame.src = new URL(`${FIXTURE_ROOT}frame.html`, origin).href;
    frames.append(frame);
  });
}

// Deliberately no load handler, URL-triggered run, auto-submit or timer starts a run.
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (started) return;
  let config;
  try {
    if (!document.getElementById('fixture-consent').checked) throw new Error('The explicit synthetic-run authorization is required.');
    config = validateConfiguration({
      primaryOrigin: document.getElementById('primary-origin').value,
      crossOrigin: document.getElementById('cross-origin').value,
      expectedZone: document.getElementById('expected-zone').value,
      runId: syntheticToken(),
    }, globalThis.location.origin);
  } catch (error) {
    status.textContent = `FAIL — configuration rejected before sampling: ${String(error?.message ?? error).slice(0, 600)}`;
    return;
  }
  started = true;
  document.getElementById('run-fields').disabled = true;
  report = {
    schemaVersion: 1,
    fixture: 'Android native timezone read-only experiment',
    runState: 'RUNNING',
    nativeAcceptance: 'NOT_RUN',
    nativeAcceptanceReason: 'Web observations alone do not attest native APK/patch provenance or the unperformed lifecycle scenarios.',
    configuration: config,
    rawEvidenceComplete: true,
    steps: [
      ...realmPlan('main'),
      { id: 'same/frame-transport', label: 'same · actual iframe transport', status: 'NOT_RUN', reason: 'No frame has been created.' },
      ...realmPlan('same'),
      { id: 'cross/frame-transport', label: 'cross · actual iframe transport', status: 'NOT_RUN', reason: 'No frame has been created.' },
      ...realmPlan('cross'),
      ...lifecycleLimitations(config.expectedZone),
    ],
  };
  render();
  try {
    replaceRealmSteps(await runRealm(config, 'main', (steps) => { replaceRealmSteps(steps); render(); }));
    for (const realmId of ['same', 'cross']) {
      const transport = report.steps.find((step) => step.id === `${realmId}/frame-transport`);
      transport.status = 'RUNNING'; transport.reason = 'Loading only the fixed synthetic frame route.'; render();
      try {
        replaceRealmSteps(await runFrame(config, realmId));
        transport.status = 'PASS';
        transport.reason = 'Exact iframe window, explicit origin, protocol, run identifier and complete terminal observation plan matched. This transport result is not a ServiceWorker result.';
      } catch (error) {
        transport.status = 'FAIL'; transport.reason = String(error?.message ?? error).slice(0, 900);
      }
      render();
    }
    report.runState = 'FINISHED_WITH_LIMITATIONS';
  } catch (error) {
    report.runState = 'FAILED';
    report.steps.push({ id: 'orchestration', label: 'Fixture orchestration', status: 'FAIL', reason: String(error?.message ?? error).slice(0, 900) });
  }
  render();
});
