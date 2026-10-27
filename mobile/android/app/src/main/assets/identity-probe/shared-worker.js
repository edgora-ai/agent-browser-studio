'use strict';
if (self.location.origin === 'https://appassets.androidplatform.net' &&
    self.location.pathname === '/assets/identity-probe/shared-worker.js') {
  importScripts('timing.js', 'readings.js', 'protocol.js', 'worker-agent.js');
  AbsIdentityWorkerAgent.install(self, true);
}
