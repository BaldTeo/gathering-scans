/**
 * GatheringScans Client-Side Offline Cache Service Worker (Requirement 5)
 * Caches app shell, scan metadata, and 3D Tileset chunks (.json, .glb) in the user's
 * local browser CacheStorage so scans remain viewable when the processing PC is offline.
 * Strictly zero scan cache is ever stored on the Linux VPS.
 */

const CACHE_NAME = "gathering-scans-offline-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/lib/three.min.js",
  "/lib/OrbitControls.js",
  "/lib/GLTFLoader.js",
  "/lib/KTX2Loader.js",
  "/lib/meshopt_decoder.js",
  "/lib/3d-tiles-renderer.bundle.js",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {});
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // For 3D tileset streams (/stream/...) and scan list (/api/scans):
  // Try network first; if the Windows PC is offline (network error or 503), fall back to browser CacheStorage!
  if (
    url.pathname.startsWith("/stream/") ||
    url.pathname.startsWith("/api/scans") ||
    APP_SHELL.includes(url.pathname)
  ) {
    event.respondWith(
      fetch(req)
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const clone = networkResp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            return networkResp;
          }
          if (networkResp && networkResp.status === 503) {
            return caches.match(req).then((cached) => cached || networkResp);
          }
          return networkResp;
        })
        .catch(() => {
          return caches.match(req).then((cached) => {
            if (cached) return cached;
            return new Response(
              JSON.stringify({
                error: "PC is offline and this resource is not cached in your browser.",
                pc_online: false,
              }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          });
        })
    );
  }
});
