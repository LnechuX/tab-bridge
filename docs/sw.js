// Tab Bridge — service worker страницы для телефона.
// 1) Принимает push-уведомления (только по личной теме этого телефона), расшифровывает ссылку
//    прямо на телефоне и показывает уведомление. Нажатие открывает ссылку.
// 2) Позволяет установить страницу на главный экран и попасть в меню «Поделиться».
importScripts("tb-crypto.js", "tb-core.js", "shared.js");

const CACHE = "tab-bridge-v4";
const ICON = "icons/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// Всегда свежая версия из сети, кэш — только запасной вариант без интернета.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && !url.search) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function tellPages(msg) {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  list.forEach((c) => c.postMessage(msg));
}

async function onPush(event) {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch {}

  if (data && data.event === "subscription_expiring") {
    try { await TB.push.register(self.registration); } catch {}
    return;
  }

  let res = { fresh: [] };
  try {
    res = data && data.event === "message" && data.message
      ? await TB.core.handle([data.message])
      : await TB.core.poll();
  } catch {}

  if (res.removedMe) {
    await TB.wipe(self.registration, false);
    await self.registration.showNotification("Tab Bridge отключён", {
      body: "Это устройство удалили из списка на другом устройстве.", tag: "tb-removed", icon: ICON
    });
    await tellPages({ type: "tb-removed" });
    return;
  }

  for (const h of res.fresh) {
    await self.registration.showNotification(h.title || hostOf(h.url), {
      body: [h.from ? `С «${h.from}»` : "", hostOf(h.url), "нажмите, чтобы открыть"].filter(Boolean).join(" · "),
      tag: "tb-" + h.id, icon: ICON, badge: ICON, data: { url: h.url, id: h.id }
    });
  }
  if (res.fresh.length || res.devicesChanged || res.sentChanged) await tellPages({ type: "tb-updated" });
}

self.addEventListener("push", (e) => e.waitUntil(onPush(e)));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (!d.url || !TBCrypto.isSafeUrl(d.url)) return;
  e.waitUntil(Promise.all([
    self.clients.openWindow(d.url),
    TB.core.markOpened(d.id).catch(() => {})
  ]));
});

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(TB.push.register(self.registration).catch(() => {}));
});
