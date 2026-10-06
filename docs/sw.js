// Tab Bridge — service worker страницы для телефона.
// 1) Принимает push-уведомления от сервера ntfy, расшифровывает ссылку прямо на телефоне
//    и показывает уведомление. Нажатие на уведомление открывает ссылку.
// 2) Позволяет установить страницу на главный экран и попасть в меню «Поделиться».
importScripts("tb-crypto.js", "shared.js");

const CACHE = "tab-bridge-v3";

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
        if (r.ok && !url.search) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

const ICON = "icons/icon-192.png";

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function visibleClient() {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return list.some((c) => c.visibilityState === "visible");
}

async function onPush(event) {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch {}

  // ntfy предупреждает, что подписка скоро истечёт, — продлеваем её
  if (data && data.event === "subscription_expiring") {
    try { await TBPush.register(self.registration); } catch {}
    return;
  }

  let res = { fresh: [], own: 0 };
  try {
    res = data && data.event === "message" && data.message
      ? await TBInbox.process([data.message])
      : await TBInbox.poll();
  } catch {}

  for (const h of res.fresh) {
    await self.registration.showNotification(h.title || hostOf(h.url), {
      body: [h.from ? `С «${h.from}»` : "", hostOf(h.url), "нажмите, чтобы открыть"].filter(Boolean).join(" · "),
      tag: "tb-" + h.id,
      icon: ICON,
      badge: ICON,
      data: { url: h.url }
    });
  }

  if (res.fresh.length) {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: "tb-updated" }));
  } else if (res.own && !(await visibleClient())) {
    // это наше же сообщение (отправили с этого телефона) — коротко подтверждаем и убираем
    await self.registration.showNotification("✓ Отправлено на ваши устройства", { tag: "tb-sent", icon: ICON, silent: true });
    await new Promise((r) => setTimeout(r, 3000));
    (await self.registration.getNotifications({ tag: "tb-sent" })).forEach((n) => n.close());
  }
}

self.addEventListener("push", (e) => e.waitUntil(onPush(e)));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url;
  if (url && TBCrypto.isSafeUrl(url)) e.waitUntil(self.clients.openWindow(url));
});

// Браузер сам сменил ключи подписки — заново регистрируемся на сервере
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(TBPush.register(self.registration).catch(() => {}));
});
