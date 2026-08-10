const CACHE = "grok-phone-v45";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js?v=45",
  "/app.js",
  "/history-merge.mjs",
  "/thinking-ui.mjs",
  "/activity-ui.mjs",
  "/voice-ui.mjs",
  "/styles.css?v=45",
  "/styles.css",
  "/marked.min.js",
  "/purify.min.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Network-first for app shell (JS/CSS/HTML) so mic/dictation fixes land on the
 * phone without a stuck cache-first service worker. Icons stay cache-first.
 */
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // network only

  const path = url.pathname;
  const isShell =
    path === "/" ||
    path.endsWith(".html") ||
    path.endsWith(".js") ||
    path.endsWith(".mjs") ||
    path.endsWith(".css") ||
    path.endsWith(".webmanifest");

  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match(path)))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
