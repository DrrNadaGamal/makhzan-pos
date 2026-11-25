// Caches the app shell so the till opens with no connection. The API is never cached here:
// the app keeps its own copy of the catalog and queues sales, so it always knows whether it is really online.
const V = 'makhzan-v1';
const SHELL = ['/', '/app.js', '/logic.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('/'))));
});
