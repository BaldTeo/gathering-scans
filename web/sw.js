/**
 * GatheringScans Client-Side Offline Cache Service Worker (Requirement 5)
 * Caches app shell, scan metadata, and 3D Tileset chunks (.json, .glb) in the user's
 * local browser CacheStorage so scans remain viewable when the processing PC is offline.
 * Strictly zero scan cache is ever stored on the Linux VPS.
 */

const CACHE_NAME = "gathering-scans-offline-v64";
const SCAN_TILES_CACHE = "gathering-scans-tiles-v2";
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
  "/lib/basis/basis_transcoder.js",
  "/lib/basis/basis_transcoder.wasm",
  "/assets/gathering_cloud_logo.png",
  "/assets/gathering_cloud_logo_dark.png",
  "/assets/gathering_construction_logo_dark.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((u) =>
          fetch(u, { cache: "no-cache" })
            .then((resp) => {
              if (resp && resp.status === 200) {
                return cache.put(new Request(self.location.origin + u), resp);
              }
            })
            .catch(() => {})
        )
      );
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== SCAN_TILES_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function matchStreamCache(req) {
  const tileCache = await caches.open(SCAN_TILES_CACHE);
  const exactHit = await tileCache.match(req);
  if (exactHit) return exactHit;
  const pathHit = await tileCache.match(req, { ignoreSearch: true });
  if (pathHit) return pathHit;
  const fallbackHit = await caches.match(req);
  if (fallbackHit) return fallbackHit;
  return caches.match(req, { ignoreSearch: true });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // For /stream/ 3D tileset & GLB requests: try network first, refresh any existing offline cache entry, and fall back to offline browser cache when PC/network is offline
  if (url.pathname.startsWith("/stream/")) {
    event.respondWith(
      fetch(req)
        .then(async (networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const clone = networkResp.clone();
            caches.open(SCAN_TILES_CACHE).then(async (tileCache) => {
              const existing = (await tileCache.match(req)) || (await tileCache.match(req, { ignoreSearch: true }));
              if (existing) {
                const allKeys = await tileCache.keys();
                for (const k of allKeys) {
                  try {
                    if (new URL(k.url).pathname === url.pathname && k.url !== req.url) {
                      await tileCache.delete(k);
                    }
                  } catch (_) {}
                }
                await tileCache.put(req, clone);
              }
            }).catch(() => {});
            return networkResp;
          }
          if (networkResp && (networkResp.status === 503 || networkResp.status === 502 || networkResp.status === 504)) {
            const cached = await matchStreamCache(req);
            return cached || networkResp;
          }
          return networkResp;
        })
        .catch(async () => {
          const cached = await matchStreamCache(req);
          if (cached) return cached;
          return new Response(
            JSON.stringify({
              error: "PC is offline and this 3D tile is not cached in your browser.",
              pc_online: false,
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        })
    );
    return;
  }

  const isShellAsset = APP_SHELL.includes(url.pathname);
  const isDynamicShareHtml =
    isShellAsset &&
    (url.pathname === "/" || url.pathname === "/index.html") &&
    url.search.includes("share=");
  if (url.pathname === "/api/scans" || isShellAsset) {
    const canonicalKey = isShellAsset ? new Request(url.origin + url.pathname) : req;
    const matchOpts = isShellAsset ? { ignoreSearch: true } : undefined;
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            if (!isDynamicShareHtml) {
              const clone = networkResp.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(canonicalKey, clone));
            }
            return networkResp;
          }
          if (networkResp && networkResp.status === 503) {
            return caches.match(canonicalKey, matchOpts).then((cached) => cached || networkResp);
          }
          return networkResp;
        })
        .catch(() => {
          return caches.match(canonicalKey, matchOpts).then((cached) => {
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
