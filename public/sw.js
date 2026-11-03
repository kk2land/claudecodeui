// Service Worker for CloudCLI PWA (browser and Android WebView).
// Cache policy mirrors server/modules/static-assets:
// - Navigations/HTML are network-only and bypass the HTTP cache, so a rebuilt
//   frontend is picked up on the next load. Offline shows a plain notice.
// - Content-hashed build assets under /assets/ are cache-first: a new build always
//   changes their file name.
// - Everything else stays network-first; the HTTP cache handles revalidation.
// A new version claims open clients and deletes only this app's older caches. It
// never touches localStorage, cookies, drafts or other apps' caches.
const CACHE_NAME = 'claude-ui-v3';
const CACHE_PREFIX = 'claude-ui-';
const PRECACHE_URLS = ['/manifest.json'];
const HASHED_ASSET_PATH = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const BYPASS_PATH_PREFIXES = [
  '/api/',
  '/ws',
  '/shell',
  '/plugin-ws',
  '/android-notifications',
  '/desktop-notifications'
];

function isBypassedPath(pathname) {
  return BYPASS_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix));
}

function offlineNavigationResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Offline</title><h1>Offline</h1><p>Please check your connection.</p>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function handleNavigation(request) {
  try {
    // Do not use the HTTP cache here: an old cached index.html would keep pointing at
    // the previous build's assets and would hide a rebuilt app from the WebView.
    return await fetch(request, { cache: 'no-store' });
  } catch {
    return offlineNavigationResponse();
  }
}

async function handleHashedAsset(request, event) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.status === 200) {
    // Caching is an optimization: a quota/storage failure must not turn a fetched
    // response into a load failure, so the write outlives the response but stays best effort.
    event.waitUntil(storeHashedAsset(request, response.clone()));
  }
  return response;
}

async function storeHashedAsset(request, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch {
    // Ignore: the response was already delivered from the network.
  }
}

// Install: precache only the manifest (needed for PWA install). HTML and build
// output are never precached, so a rebuild is never masked by an old snapshot.
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBypassedPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (HASHED_ASSET_PATH.test(url.pathname)) {
    event.respondWith(handleHashedAsset(request, event));
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

// Activate: delete only this app's older cache versions, then take control of open
// pages so the freshly built HTML is loaded by the next navigation.
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
