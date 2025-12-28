self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const MAP_CACHE = 'map-cache-v2';
const CACHE_HOSTS = new Set([
  'build.protomaps.com',
  'protomaps.github.io',
  'build-metadata.protomaps.dev'
]);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!CACHE_HOSTS.has(url.hostname)) return;

  event.respondWith(
    caches.open(MAP_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          cache.put(req, res.clone()).catch(() => {});
          return res;
        });
      })
    )
  );
});
