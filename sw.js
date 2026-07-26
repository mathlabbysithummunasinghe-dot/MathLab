// MathLab service worker — caches only the app shell (this HTML page + icons)
// so the interface still loads on a flaky/offline connection. It deliberately
// does NOT cache Firebase/Firestore calls or any other cross-origin requests —
// those always go straight to the network so student data stays live and
// accurate. Bump CACHE_NAME whenever the app shell changes to force a refresh.
const CACHE_NAME = 'mathlab-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle simple same-origin GET requests for the app shell itself.
  // Everything else (Firebase, EmailJS, YouTube, Google Drive, R2 uploads,
  // cross-origin anything) is left completely alone and goes straight to
  // the network, untouched by the cache.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        // Network succeeded — use it, and refresh the cached copy for next time offline.
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return networkResponse;
      })
      .catch(() =>
        // Offline / request failed — fall back to whatever we have cached.
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
