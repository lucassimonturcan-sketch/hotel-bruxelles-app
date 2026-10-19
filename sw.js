// Service worker minimal : il ne garde en cache que les polices et les icônes ;
// la page et le programme viennent toujours du réseau (pas de vieille version bloquée).
const C = 'hb-app-v10';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !/\/(fonts|icons)\//.test(u.pathname)) return;
  e.respondWith(caches.open(C).then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { c.put(e.request, n.clone()); return n; }))));
});
// Notification envoyée par GitHub quand Claude a répondu
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hôtel Bruxelles', { body: d.body || 'L’agent a répondu.', icon: 'icons/favicon-192.png', badge: 'icons/favicon-192.png' }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : clients.openWindow('./')));
});
