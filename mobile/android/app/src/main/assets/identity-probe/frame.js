(function (realm) {
  'use strict';
  const protocol = realm.AbsIdentityProtocol;
  if (realm.parent === realm || realm.location.pathname !== protocol.BASE + 'frame.html') return;
  const kind = realm.location.origin === protocol.APP_ORIGIN ? 'same-origin-frame'
    : realm.location.origin === protocol.FRAME_ORIGIN ? 'cross-origin-frame' : null;
  const binding = protocol.bindingFromParameters(realm.location.hash, kind);
  if (!binding) return;
  let started = false;
  realm.addEventListener('message', async (event) => {
    if (started || event.source !== realm.parent || event.origin !== protocol.APP_ORIGIN ||
        !protocol.isRequest(event.data, binding)) return;
    started = true;
    let result;
    try {
      result = protocol.context(kind, await realm.AbsIdentityReadings.collect(realm, true));
    } catch (error) {
      result = protocol.failed(kind, 'INTERNAL_ERROR');
    }
    // Only the main document owns the Android bridge.
    try {
      realm.parent.postMessage(protocol.reply(binding, result), protocol.APP_ORIGIN);
      return null;
    } catch (error) {
      // No raw exception escapes; the main frame will report its bounded timeout.
      return 'MESSAGE_ERROR';
    }
  });
})(globalThis);
