/* xtiandOS · mjane — offline-first shell service worker.
   - Navigation requests: network-first, cache fallback (fresh index.html).
   - Static assets (same-origin, non-API): cache-first + background revalidate.
   - /api and /health: network-only (never cached — chat, session, SSE, etc.).
   Registered only in secure contexts; ignored silently elsewhere. */
const CACHE = "xtiandos-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add("/index.html")).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname === "/health") return;

  // Vite dev-server transform endpoints must always hit the network.
  if (/^\/(@|src\/|node_modules\/)/.test(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(
          () =>
            caches.match(req).then((hit) => hit || caches.match("/index.html")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const fetchAndUpdate = fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      });
      return hit || fetchAndUpdate;
    }),
  );
});