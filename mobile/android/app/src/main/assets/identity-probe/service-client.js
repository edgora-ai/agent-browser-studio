(function (root) {
  'use strict';
  const protocol = root.AbsIdentityProtocol;

  async function release(realm, registration) {
    const outcome = await root.AbsIdentityTiming.within(realm, 1000, () => registration.unregister(),
      { timeout: 'SW_UNREGISTER_FAILED', error: 'SW_UNREGISTER_FAILED' });
    // false is also valid here: the worker normally already unregistered itself.
    return outcome.ok && typeof outcome.value === 'boolean'
      ? { ok: true } : { ok: false, code: 'SW_UNREGISTER_FAILED' };
  }

  async function activate(realm, registration, binding, milliseconds) {
    const listeners = [];
    let cleanupFailed = false;
    const watched = new Set();
    function watch(target, name, callback) {
      target.addEventListener(name, callback);
      listeners.push(() => target.removeEventListener(name, callback));
    }
    let outcome;
    try {
      outcome = await root.AbsIdentityTiming.within(realm, milliseconds, () => new Promise((resolve) => {
        function inspect() {
          try {
            const candidates = [registration.installing, registration.waiting, registration.active].filter(Boolean);
            for (const worker of candidates) {
              if (!watched.has(worker)) {
                watched.add(worker);
                watch(worker, 'statechange', inspect);
              }
              if (worker.scriptURL !== protocol.resource(binding)) {
                resolve(null);
                return;
              }
            }
            if (registration.active && registration.active.state === 'activated') resolve(registration.active);
            else if (candidates.some((worker) => worker.state === 'redundant')) resolve(null);
          } catch (error) {
            resolve(null);
          }
        }
        watch(registration, 'updatefound', inspect);
        inspect();
      }), { error: 'SW_ACTIVATION_FAILED' });
    } finally {
      for (const remove of listeners.reverse()) {
        try {
          remove();
        } catch (error) {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) return { ok: false, code: 'CLEANUP_FAILED' };
    return outcome.ok && outcome.value ? outcome : { ok: false, code: outcome.code || 'SW_ACTIVATION_FAILED' };
  }

  async function run(realm, binding) {
    let registration = null;
    let abandoned = false;
    let result;
    let port1;
    let port2;
    try {
      const container = realm.navigator && realm.navigator.serviceWorker;
      if (container === undefined || container === null) return protocol.unsupported(binding.kind);
      const budget = root.AbsIdentityTiming.budget(realm, 6000);
      const registering = Promise.resolve().then(() => container.register(protocol.resource(binding), {
        scope: protocol.scope(binding), updateViaCache: 'none'
      })).then((owned) => {
        // Never unregister a returned object with a different scope.
        if (!owned || owned.scope !== protocol.scope(binding)) throw new TypeError();
        registration = owned;
        if (abandoned) {
          // Registration cannot be cancelled. A late resolution still cleans up only
          // this exact registration. The reported timeout remains failed/unconfirmed,
          // regardless of the late cleanup outcome (never a retrospective PASS).
          return release(realm, owned).then(() => owned);
        }
        return owned;
      });
      const registered = await root.AbsIdentityTiming.within(realm, budget.remaining(), () => registering,
        { timeout: 'SW_CLEANUP_UNCONFIRMED', error: 'SW_REGISTER_FAILED' });
      if (!registered.ok) {
        abandoned = true;
        result = protocol.failed(binding.kind, registered.code);
      } else {
        const active = await activate(realm, registration, binding, budget.remaining());
        if (!active.ok) result = protocol.failed(binding.kind, active.code);
        else {
          const channel = new realm.MessageChannel();
          port1 = channel.port1;
          port2 = channel.port2;
          result = await root.AbsIdentityChannels.exchange(realm, {
            binding, target: port1, errorTarget: active.value, endpoint: { target: port1 },
            milliseconds: budget.remaining(),
            start() {
              port1.start();
              active.value.postMessage(protocol.request(binding), [port2]);
            }
          });
        }
      }
    } catch (error) {
      result = protocol.failed(binding.kind, 'START_FAILED');
    } finally {
      // Also cover setup/clock failures after a non-cancellable register() began.
      abandoned = true;
      for (const port of [port1, port2]) {
        if (port) {
          try {
            port.close();
          } catch (error) {
            result = protocol.failed(binding.kind, 'CLEANUP_FAILED', result && result.values);
          }
        }
      }
      if (registration) {
        const cleaned = await release(realm, registration);
        if (!cleaned.ok) result = protocol.failed(binding.kind, cleaned.code, result && result.values);
      }
    }
    return result;
  }

  root.AbsIdentityServiceClient = Object.freeze({ run });
})(globalThis);
