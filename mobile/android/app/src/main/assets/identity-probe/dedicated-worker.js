'use strict';
// These names resolve only through the App's local asset interception.
if (self.location.origin === 'https://appassets.androidplatform.net' &&
    self.location.pathname === '/assets/identity-probe/dedicated-worker.js') {
  importScripts('timing.js', 'readings.js', 'protocol.js', 'worker-agent.js');
  AbsIdentityWorkerAgent.install(self, false);
}
