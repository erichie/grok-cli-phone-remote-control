const CACHE = "grok-phone-v61";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js?v=61",
  "/app.js",
  "/history-merge.mjs",
  "/thinking-ui.mjs",
  "/activity-ui.mjs",
  "/voice-ui.mjs",
  "/standup-ui.mjs",
  "/loops-ui.mjs",
  "/styles.css?v=61",
  "/styles.css",
  "/marked.min.js",
  "/purify.min.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/splash-1170x2532.png",
  "/splash-1179x2556.png",
  "/splash-1290x2796.png",
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
 * Stale-while-revalidate for the app shell so a backgrounded iOS PWA can
 * paint instantly from cache. A background fetch updates the cache for next
 * launch (avoids a stuck old SW without blocking first paint).
 * Icons stay cache-first. APIs are network-only.
 */
function staleWhileRevalidate(request, fallbackPath) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const networked = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            cache.put(request, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached || (fallbackPath ? cache.match(fallbackPath) : undefined));
      return cached || networked;
    })
  );
}

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
    e.respondWith(staleWhileRevalidate(e.request, path));
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
