// Garde l'interface disponible hors ligne ; les données viennent toujours de GitHub
const C = 'hb-app-v2', FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/favicon-192.png', 'fonts/TheanoDidot-Regular.woff2', 'fonts/FreeSans.woff2', 'fonts/FreeSans-Bold.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
