(function (root) {
  'use strict';

  function install(realm, shared) {
    const protocol = root.AbsIdentityProtocol;
    const kind = shared ? 'shared-worker' : 'dedicated-worker';
    if (realm.location.origin !== protocol.APP_ORIGIN ||
        realm.location.pathname !== protocol.BASE + kind + '.js') return;
    const binding = protocol.bindingFromParameters(realm.location.hash, kind);
    if (!binding) return;
    let started = false;
    function connect(target) {
      target.addEventListener('message', async (event) => {
        if (started || !protocol.endpointMatches(event, { target }) || !protocol.isRequest(event.data, binding)) return;
        started = true;
        let result;
        try {
          result = protocol.context(kind, await root.AbsIdentityReadings.collect(realm, false));
        } catch (error) {
          result = protocol.failed(kind, 'INTERNAL_ERROR');
        }
        let deliveryCode = null;
        try {
          target.postMessage(protocol.reply(binding, result));
        } catch (error) {
          deliveryCode = 'MESSAGE_ERROR';
        }
        try {
          if (shared) target.close();
          realm.close();
        } catch (error) {
          deliveryCode = 'CLEANUP_FAILED';
        }
        return deliveryCode;
      });
      if (shared) target.start();
    }
    if (shared) realm.addEventListener('connect', (event) => {
      if (event.ports && event.ports.length === 1) connect(event.ports[0]);
    });
    else connect(realm);
  }

  root.AbsIdentityWorkerAgent = Object.freeze({ install });
})(globalThis);
