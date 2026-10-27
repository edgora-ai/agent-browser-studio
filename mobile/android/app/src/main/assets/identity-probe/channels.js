(function (root) {
  'use strict';

  async function exchange(realm, options) {
    const protocol = root.AbsIdentityProtocol;
    const binding = options.binding;
    const listeners = [];
    let cleanupFailed = false;
    function listen(target, type, callback) {
      target.addEventListener(type, callback);
      listeners.push(() => target.removeEventListener(type, callback));
    }
    let outcome;
    try {
      outcome = await root.AbsIdentityTiming.within(realm, options.milliseconds, () => new Promise((resolve) => {
        listen(options.target, 'message', (event) => {
          if (!protocol.endpointMatches(event, options.endpoint) ||
              !protocol.envelopeMatches(event.data, binding, 'abs-identity:result')) return;
          resolve(protocol.resultFromReply(event.data, binding));
        });
        listen(options.target, 'messageerror', () => resolve(protocol.failed(binding.kind, 'MESSAGE_ERROR')));
        listen(options.errorTarget || options.target, 'error', () => resolve(protocol.failed(binding.kind, 'CONTEXT_ERROR')));
        try {
          const starting = options.start();
          if (starting && typeof starting.then === 'function') {
            starting.then(undefined, () => resolve(protocol.failed(binding.kind, 'START_FAILED')));
          }
        } catch (error) {
          resolve(protocol.failed(binding.kind, 'START_FAILED'));
        }
      }), { error: 'START_FAILED' });
    } finally {
      for (const remove of listeners.reverse()) {
        try {
          remove();
        } catch (error) {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) return protocol.failed(binding.kind, 'CLEANUP_FAILED');
    return outcome.ok ? outcome.value : protocol.failed(binding.kind, outcome.code);
  }

  root.AbsIdentityChannels = Object.freeze({ exchange });
})(globalThis);
