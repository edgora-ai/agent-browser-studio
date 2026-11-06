'use strict';
if (self.location.origin === 'https://appassets.androidplatform.net' &&
    self.location.pathname === '/assets/identity-probe/service-worker.js') {
  importScripts('timing.js', 'readings.js', 'protocol.js');
  (function (realm) {
    const protocol = realm.AbsIdentityProtocol;
    const kind = 'service-worker';
    const binding = protocol.bindingFromParameters(realm.location.search, kind);
    if (!binding || realm.registration.scope !== protocol.scope(binding)) return;
    let started = false;
    function trustedClient(event) {
      try {
        if (event.origin !== protocol.APP_ORIGIN || !event.source || event.source.type !== 'window' ||
            event.source.frameType !== 'top-level' || typeof event.source.id !== 'string' || !event.source.id) return false;
        const url = new URL(event.source.url);
        return url.origin === protocol.APP_ORIGIN && url.pathname === protocol.BASE + 'index.html' &&
          protocol.challengeFromHash(url.hash) === binding.challenge;
      } catch (error) {
        return false;
      }
    }
    async function respond(port) {
      let result;
      try {
        // Read this ServiceWorkerGlobalScope, never a Window or a client's values.
        result = protocol.context(kind, await realm.AbsIdentityReadings.collect(realm, false));
      } catch (error) {
        result = protocol.failed(kind, 'INTERNAL_ERROR');
      }
      const cleaned = await realm.AbsIdentityTiming.within(realm, 1000, () => realm.registration.unregister(),
        { timeout: 'SW_UNREGISTER_FAILED', error: 'SW_UNREGISTER_FAILED' });
      const released = cleaned.ok && cleaned.value === true;
      if (!released) result = protocol.failed(kind, 'SW_UNREGISTER_FAILED', result.values);
      let deliveryCode = null;
      try {
        port.postMessage(protocol.reply(binding, result, released));
      } catch (error) {
        // The parent will fail its bounded wait if even the error reply cannot be delivered.
        deliveryCode = 'MESSAGE_ERROR';
      }
      try {
        port.close();
      } catch (error) {
        deliveryCode = 'CLEANUP_FAILED';
      }
      return deliveryCode;
    }
    realm.addEventListener('message', (event) => {
      if (started || !trustedClient(event) || !protocol.isRequest(event.data, binding) ||
          !event.ports || event.ports.length !== 1) return;
      started = true;
      event.waitUntil(respond(event.ports[0]));
    });
    // Deliberately no fetch handler, clients.claim(), skipWaiting(), storage or cache operations.
  })(self);
}
