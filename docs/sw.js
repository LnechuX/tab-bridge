// Tab Bridge — service worker страницы для телефона.
// 1) Принимает push-уведомления (только по личной теме этого телефона), расшифровывает ссылку
//    прямо на телефоне и показывает уведомление. Нажатие открывает ссылку.
// 2) Позволяет установить страницу на главный экран и попасть в меню «Поделиться».
importScripts("tb-crypto.js", "tb-core.js", "blobstore.js", "shared.js");

const CACHE = "tab-bridge-v10";
const ICON = "icons/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// Всегда свежая версия из сети, кэш — только запасной вариант без интернета.
// Важно для приватности: параметры адреса (?url=…&text=… из «Поделиться» на Android)
// НЕ уходят в сеть — страницу запрашиваем без них, а сама страница читает их локально.
async function onShareTarget(request) {
  try {
    const fd = await request.formData();
    const files = [];
    let n = 0;
    for (const f of fd.getAll("files")) {
      if (!(f instanceof File) || !f.size || f.size > TBCrypto.MAX_FILE || n >= 10) continue;
      const key = "share:" + Date.now() + ":" + n++;
      await TBBlobs.put(key, f);
      files.push({ key, name: f.name, type: f.type });
    }
    await KV.set("pendingShare", {
      title: String(fd.get("title") || "").slice(0, 300), text: String(fd.get("text") || "").slice(0, 200000),
      url: String(fd.get("url") || "").slice(0, 2400), files, ts: Date.now()
    });
  } catch {}
  return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === self.location.origin && url.pathname.endsWith("/share-target")) {
    e.respondWith(onShareTarget(e.request));
    return;
  }
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  const clean = url.origin + url.pathname;
  const netReq = url.search
    ? new Request(clean, { credentials: "omit", cache: "no-store", redirect: "follow" })
    : e.request;
  e.respondWith(
    fetch(netReq)
      .then((r) => {
        if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(clean, copy)); }
        if (r.redirected && e.request.mode === "navigate") return Response.redirect(r.url, 302);
        return r;
      })
      .catch(() => caches.match(clean))
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
    if (h.kind === "text" || h.kind === "file") {
      const what = h.kind === "text" ? "✏️ Текст" : "🖼 Картинка";
      await self.registration.showNotification(`${what}${h.from ? ` с «${h.from}»` : ""}`, {
        body: h.status === "error" ? `Не скачано: ${h.error}` : (h.kind === "text" ? h.title : `${h.title} — нажмите, чтобы посмотреть`),
        tag: "tb-" + h.id, icon: ICON, badge: ICON, data: { id: h.id, kind: h.kind }
      });
      continue;
    }
    await self.registration.showNotification(h.title || hostOf(h.url), {
      body: [h.from ? `С «${h.from}»` : "", hostOf(h.url), "нажмите, чтобы открыть"].filter(Boolean).join(" · "),
      tag: "tb-" + h.id, icon: ICON, badge: ICON, data: { url: h.url, id: h.id }
    });
  }
  if (res.fresh.length || res.devicesChanged || res.sentChanged) await tellPages({ type: "tb-updated" });
}

self.addEventListener("push", (e) => e.waitUntil(onPush(e)));

async function onNotificationClick(d) {
  const mode = await KV.get("openIn", TB.defaultOpenMode());
  const target = TB.openTarget(d.url, mode);
  if (!target) return;
  if (target === d.url) {
    // обычная ссылка: браузер телефона откроет её сам
    await Promise.all([self.clients.openWindow(d.url), TB.core.markOpened(d.id).catch(() => {})]);
    return;
  }
  // «Переходник» в другой браузер (Safari, Chrome…) из фона открыть нельзя —
  // передаём его странице приложения, она перейдёт по нему.
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const c = list.find((x) => new URL(x.url).origin === self.location.origin);
  if (c) {
    try { await c.focus(); } catch {}
    c.postMessage({ type: "tb-open", id: d.id });
  } else {
    await self.clients.openWindow("./#o=" + encodeURIComponent(d.id));
  }
}

// Текст или картинка: открыть приложение и показать присланное
async function openInApp(id) {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const c = list.find((x) => new URL(x.url).origin === self.location.origin);
  if (c) { try { await c.focus(); } catch {} c.postMessage({ type: "tb-open", id }); }
  else await self.clients.openWindow("./#o=" + encodeURIComponent(id));
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (d.kind === "text" || d.kind === "file") { e.waitUntil(openInApp(String(d.id)).catch(() => {})); return; }
  if (!d.url || !TBCrypto.isSafeUrl(d.url)) return;
  e.waitUntil(onNotificationClick(d).catch(() => {}));
});

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(TB.push.register(self.registration).catch(() => {}));
});
