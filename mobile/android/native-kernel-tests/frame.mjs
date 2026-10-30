import { PROTOCOL, aggregateSteps, validateConfiguration } from './model.mjs';
import { runRealm } from './runner.mjs';

let started = false;
const state = document.getElementById('frame-state');

globalThis.addEventListener('message', async (event) => {
  if (started || globalThis.parent === globalThis || event.source !== globalThis.parent) return;
  const message = event.data;
  if (message?.protocol !== PROTOCOL || message.action !== 'run-realm' || !['same', 'cross'].includes(message.realmId)) return;
  let config;
  try {
    config = validateConfiguration(message.config, globalThis.location.origin, message.realmId);
    if (event.origin !== config.primaryOrigin) return;
  } catch (error) {
    state.textContent = `FAIL — rejected parent configuration: ${String(error.message).slice(0, 300)}`;
    return;
  }
  started = true;
  state.textContent = `RUNNING — explicit ${message.realmId}-origin synthetic run.`;
  try {
    const steps = await runRealm(config, message.realmId);
    state.textContent = `${aggregateSteps(steps)} — observed checks returned. No worker cold-stop, browser restart or native acceptance is claimed.`;
    globalThis.parent.postMessage({ protocol: PROTOCOL, action: 'realm-results', runId: config.runId, realmId: message.realmId, steps }, config.primaryOrigin);
  } catch (error) {
    state.textContent = 'FAIL — subrealm did not complete.';
    globalThis.parent.postMessage({
      protocol: PROTOCOL, action: 'realm-results', runId: config.runId, realmId: message.realmId,
      error: String(error?.message ?? error).slice(0, 600),
    }, config.primaryOrigin);
  }
});
