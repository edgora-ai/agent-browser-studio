(function (root) {
  'use strict';

  async function frame(realm, binding) {
    const protocol = root.AbsIdentityProtocol;
    let element;
    let load;
    let result;
    try {
      element = realm.document.createElement('iframe');
      element.hidden = true;
      element.title = binding.kind === 'same-origin-frame' ? '同源身份采集' : '跨源身份采集';
      element.referrerPolicy = 'no-referrer';
      element.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      const origin = binding.kind === 'cross-origin-frame' ? protocol.FRAME_ORIGIN : protocol.APP_ORIGIN;
      // An iframe has a stable WindowProxy; capture it only after insertion.
      result = await root.AbsIdentityChannels.exchange(realm, {
        binding, target: realm, errorTarget: element,
        endpoint: { get source() { return element.contentWindow; }, origin },
        milliseconds: 4000,
        start() {
          load = () => element.contentWindow.postMessage(protocol.request(binding), origin);
          element.addEventListener('load', load);
          element.src = protocol.resource(binding);
          realm.document.body.appendChild(element);
        }
      });
    } catch (error) {
      result = protocol.failed(binding.kind, 'START_FAILED');
    } finally {
      if (element) {
        try {
          if (load) element.removeEventListener('load', load);
          element.remove();
        } catch (error) {
          result = protocol.failed(binding.kind, 'CLEANUP_FAILED');
        }
      }
    }
    return result;
  }

  async function worker(realm, binding) {
    const protocol = root.AbsIdentityProtocol;
    const shared = binding.kind === 'shared-worker';
    let instance;
    let target;
    let result;
    try {
      const Constructor = realm[shared ? 'SharedWorker' : 'Worker'];
      if (Constructor === undefined || Constructor === null) return protocol.unsupported(binding.kind);
      instance = new Constructor(protocol.resource(binding), { name: 'abs-identity-' + binding.requestId });
      target = shared ? instance.port : instance;
      result = await root.AbsIdentityChannels.exchange(realm, {
        binding, target, errorTarget: instance, endpoint: { target }, milliseconds: 4000,
        start() {
          if (shared) target.start();
          // Control data only. No observed or expected parent identity crosses this boundary.
          target.postMessage(protocol.request(binding));
        }
      });
    } catch (error) {
      result = protocol.failed(binding.kind, 'START_FAILED');
    } finally {
      if (instance) {
        try {
          if (shared) instance.port.close();
          else instance.terminate();
        } catch (error) {
          result = protocol.failed(binding.kind, 'CLEANUP_FAILED');
        }
      }
    }
    return result;
  }

  root.AbsIdentityContexts = Object.freeze({ frame, worker });
})(globalThis);
