const CACHE = "grok-phone-v15";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js?v=15",
  "/app.js",
  "/styles.css?v=15",
  "/styles.css",
  "/marked.min.js",
  "/purify.min.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // network only
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
