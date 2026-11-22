/* Only explicitly marked, same-origin navigation probes are faulted. No global offline switch. */
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  if (event.data?.type !== "FIXTURE_PRIME" || event.data.run !== CFG.run || !event.ports[0]) return;
  event.waitUntil((async () => {
    try {
      // No install-time caching. Cache API storage is deliberate despite HTTP no-store.
      const url = new URL(CFG.offline, self.location.origin).href;
      const fresh = await fetch(url, {cache: "no-store", credentials: "same-origin"});
      if (!fresh.ok) throw new Error("Prime HTTP " + fresh.status);
      const cache = await caches.open(CFG.cache);
      await cache.put(url, fresh);
      event.ports[0].postMessage({ok: true, run: CFG.run, cachedOnly: url, wholePhoneOffline: false});
    } catch (e) {event.ports[0].postMessage({ok: false, error: e.message});}
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || event.request.mode !== "navigate" ||
      url.origin !== self.location.origin || url.searchParams.get("fixture_offline") !== "1") return;
  if (url.pathname === CFG.offline) {
    event.respondWith((async () => {
      const cache = await caches.open(CFG.cache);
      return await cache.match(new URL(CFG.offline, self.location.origin).href) || Response.error();
    })());
  } else if (url.pathname === CFG.never) {
    // Genuine navigation failure, NOT a fake old DOM, 200 fallback, or whole-origin interception.
    event.respondWith(Promise.resolve(Response.error()));
  }
});
