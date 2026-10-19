// Garde l'interface disponible hors ligne ; les données viennent toujours de GitHub
const C = 'hb-app-v4', FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/favicon-192.png', 'fonts/TheanoDidot-Regular.woff2', 'fonts/FreeSans.woff2', 'fonts/FreeSans-Bold.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
// Notification envoyée par GitHub quand Claude a répondu
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hôtel Bruxelles', { body: d.body || 'Claude a répondu.', icon: 'icons/favicon-192.png', badge: 'icons/favicon-192.png', data: { n: d.n } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = './' + (e.notification.data && e.notification.data.n ? '?n=' + e.notification.data.n : '');
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cs => { for (const c of cs) { c.navigate(url); return c.focus(); } return clients.openWindow(url); }));
});
