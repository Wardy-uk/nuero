// SAiM Alt is RETIRED (21 Oct 2026) — this is a KILL-SWITCH, not a worker.
// A browser still holding an old Alt/legacy service worker fetches /sw.js on
// its next navigation, installs this, and it: deletes every cache, unregisters
// itself, then reloads each open tab — which now meets the 301 to
// https://sara.nickward.co.uk. It intercepts nothing (no fetch handler).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.navigate(c.url);
  })());
});
