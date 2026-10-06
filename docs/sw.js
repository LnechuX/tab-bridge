// Минимальный service worker: нужен, чтобы страницу можно было установить на главный экран
// и чтобы на Android она появилась в меню «Поделиться». Всегда берёт свежую версию из сети,
// кэш — только запасной вариант без интернета. Запросы к серверу ntfy не трогает.
const CACHE = "tab-bridge-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && !url.search) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
