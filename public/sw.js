/* Service worker de la PWA.
 * - Archivos estáticos (_next/static, íconos, logo): se guardan en caché y se sirven al instante.
 * - Pantallas: siempre desde la red (los datos deben estar al día); sin conexión se muestra /offline.html.
 * - Nunca guarda datos: las llamadas a la base de datos (Supabase) y /api no pasan por la caché.
 */
const VERSION = "v1";
const ESTATICOS = `estaticos-${VERSION}`;
const PRECARGA = ["/offline.html", "/logo.svg", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(ESTATICOS).then((c) => c.addAll(PRECARGA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== ESTATICOS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || /\.(svg|png|woff2?)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(ESTATICOS).then((c) => c.put(req, copia)); }
      return res;
    })));
  }
});
