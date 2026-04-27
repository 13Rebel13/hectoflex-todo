const CACHE = 'hf-todo-v4';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.includes('workers.dev') || req.url.includes('/api/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res)=>{ const c=res.clone(); caches.open(CACHE).then(cache=>cache.put(req,c)); return res; })));
});

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'LOCAL_NOTIFY') {
    self.registration.showNotification(d.title || 'HectoFlex', {
      body: d.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: d.tag || 'hf-local'
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clis) => {
    for (const c of clis) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow((event.notification && event.notification.data && event.notification.data.url) || './');
  }));
});


self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  const title = data.title || 'HectoFlex';
  const options = {
    body: data.body || '',
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    tag: data.tag || 'hf-push',
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
