// Service worker for Reg-Poker Online.
//
// This is a REALTIME app, so the worker is deliberately conservative:
//  - /socket.io/* is never touched. Websocket upgrades bypass service
//    workers entirely, but the polling-fallback GETs and the client script
//    DO hit fetch — caching either can wedge the connection or serve a
//    client that mismatches the server's wire protocol after a deploy.
//  - /api/* is never touched: game state must always be live.
//  - Pages and static assets are network-first, so a deploy is picked up on
//    the next load with no stale-code tricks; the cache only answers when
//    the network can't.
//  - Only content-addressed /uploads/* and /icons/* are cache-first.
//  - Updates never force a reload: a waiting worker stays waiting until the
//    player asks for it (see pwa.js) or the next natural navigation.

const VERSION = 'v2-velvet';
const STATIC_CACHE = `pp-static-${VERSION}`;
const MEDIA_CACHE = 'pp-media'; // content-addressed, survives versions
const MEDIA_LIMIT = 40;

const PRECACHE = [
  '/offline.html',
  '/manifest.webmanifest',
  '/css/base.css',
  '/icons/icon-192.png',
];

// Only these navigations are worth caching as shells. /games/:id and
// /hands/:id are deliberately absent: a dead table redirects (an
// opaqueredirect response would poison the URL) and an offline table shell
// is useless without its socket.
const CACHEABLE_PAGES = new Set(['/', '/index.html', '/me']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
  // No skipWaiting: the new worker waits politely (update toast in pwa.js).
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('pp-static-') && key !== STATIC_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  // No clients.claim(): existing pages keep their current worker until they
  // navigate — pairs with the no-forced-reload rule.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function cacheable(res) {
  return res && res.ok && res.type === 'basic';
}

async function trimMedia() {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MEDIA_LIMIT; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    /* trimming is best-effort */
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Live-only paths: hands off entirely (browser default handling).
  if (
    path.startsWith('/socket.io/') ||
    path.startsWith('/api/') ||
    path.startsWith('/unsubscribe/') ||
    path === '/healthz'
  ) {
    return;
  }

  // Immutable media: cache-first.
  if (path.startsWith('/uploads/') || path.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(MEDIA_CACHE).then((cache) => cache.put(request, copy)).then(trimMedia);
            }
            return res;
          })
      )
    );
    return;
  }

  // Navigations: network-first, offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (cacheable(res) && CACHEABLE_PAGES.has(path)) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match('/offline.html');
        })
    );
    return;
  }

  // Static assets (css/js/shared/manifest): network-first with cache fallback.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

// ---- push ----

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Reg-Poker Online';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'pineapple-poker',
      renotify: data.type === 'turn',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
