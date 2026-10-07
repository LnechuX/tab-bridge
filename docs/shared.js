// Tab Bridge (телефон) — общее для страницы и service worker:
//   KV        — хранилище в IndexedDB (его видят и страница, и обработчик push)
//   TB.core   — логика устройств и сообщений (tb-core.js)
//   TB.push   — подписка на push-уведомления через сервер ntfy
(function (g) {
  "use strict";

  const VERSION = "3.5.0";                 // версия приложения на телефоне
  const DEFAULT_SERVER = "https://ntfy.sh";
  const NTFY_VAPID = "BEMjM0sNxh41x0a6Lz3YaqkJ7AUhZefxsOQgw-at69i0fM1CybVBcj7-QQXf4N_tPCgFnOXdRbQ5jrSrr9Yg9Lc";
  const FETCH_OPTS = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
  const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");

  // ---------- KV ----------
  let dbp = null;
  function db() {
    dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open("tab-bridge", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const t = d.transaction("kv", mode);
      const out = fn(t.objectStore("kv"));
      t.oncomplete = () => res(typeof out === "function" ? out() : out && "result" in out ? out.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    }));
  }
  const KV = {
    async get(k, d) { const v = await tx("readonly", (s) => s.get(k)); return v === undefined ? d : v; },
    getAll(keys) {
      return tx("readonly", (s) => {
        const reqs = keys.map((k) => [k, s.get(k)]);
        return () => { const o = {}; for (const [k, r] of reqs) if (r.result !== undefined) o[k] = r.result; return o; };
      });
    },
    set(k, v) { return tx("readwrite", (s) => { s.put(v, k); }); },
    setMany(o) { return tx("readwrite", (s) => { for (const k of Object.keys(o)) s.put(o[k], k); }); },
    clear() { return tx("readwrite", (s) => { s.clear(); }); }
  };

  // Полученные файлы хранятся внутри приложения; до 150 МБ — лишнее удаляется само
  const FILES_LIMIT = 150 * 1024 * 1024;
  const core = g.TBCore.create({ kv: KV, kind: "phone", defaultServer: DEFAULT_SERVER, blobs: g.TBBlobs || null, maxBytes: FILES_LIMIT, version: VERSION });

  async function server() { return cleanUrl(await KV.get("server", DEFAULT_SERVER)) || DEFAULT_SERVER; }

  // ---------- push ----------
  function b64urlToBytes(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function vapidKey(srv) {
    if (srv === DEFAULT_SERVER) return NTFY_VAPID;
    try {
      const t = await (await fetch(srv + "/config.js", FETCH_OPTS)).text();
      const m = t.match(/web_push_public_key"?\s*:\s*"([A-Za-z0-9_-]+)"/);
      return m ? m[1] : "";
    } catch { return ""; }
  }

  // Подписаться на push по личной теме этого телефона (или продлить подписку).
  async function register(reg) {
    if (!(await KV.get("secret", ""))) throw new Error("Сначала подключите устройство.");
    const srv = await server();
    const key = await vapidKey(srv);
    if (!key) throw new Error("Этот сервер не поддерживает push-уведомления.");
    const appKey = b64urlToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const old = sub.options && sub.options.applicationServerKey;
      if (old && !sameBytes(new Uint8Array(old), appKey)) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const j = sub.toJSON();
    const r = await fetch(srv + "/v1/webpush", {
      ...FETCH_OPTS, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: j.endpoint, auth: j.keys.auth, p256dh: j.keys.p256dh, topics: [await core.inboxTopic()] })
    });
    if (!r.ok) throw new Error(`Сервер не принял подписку на уведомления (${r.status})`);
    await KV.set("pushAt", Date.now());
  }

  async function unregister(reg) {
    try {
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      try {
        await fetch((await server()) + "/v1/webpush", {
          ...FETCH_OPTS, method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
      } catch {}
      await sub.unsubscribe();
    } catch {}
  }

  // Полностью отключить это устройство (по своей воле или когда его удалили с другого).
  async function wipe(reg, tellOthers) {
    if (tellOthers) { try { await core.leave(); } catch {} }
    if (reg) await unregister(reg);
    const keep = { openIn: await KV.get("openIn"), deviceName: await KV.get("deviceName") };  // настройки телефона не теряем
    await KV.clear();
    if (g.TBBlobs) await g.TBBlobs.clear().catch(() => {});                                  // и полученные файлы
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) await KV.set(k, v);
  }

  // ---------- где открывать ссылки ----------
  // На iPhone приложение с экрана «Домой» открывает внешние ссылки во встроенном окне.
  // Чтобы ссылка открылась в настоящем браузере, используем адреса-«переходники» браузеров:
  // x-safari-https:// (Safari, iOS 15 и 17+), googlechromes:// (Chrome), yandexbrowser-open-url:// и т.д.
  const UA = (g.navigator && g.navigator.userAgent) || "";
  const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/i.test(UA) && g.navigator && g.navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(UA);
  const OPEN_MODES = IS_IOS
    ? [["safari", "Safari"], ["chrome", "Chrome"], ["yandex", "Яндекс Браузер"], ["firefox", "Firefox"], ["app", "Внутри Tab Bridge"]]
    : IS_ANDROID
      ? [["default", "Браузер по умолчанию"], ["chrome", "Chrome"], ["yandex", "Яндекс Браузер"], ["firefox", "Firefox"]]
      : [["default", "Браузер по умолчанию"]];
  const defaultOpenMode = () => (IS_IOS ? "safari" : "default");

  // Адрес, по которому нужно перейти, чтобы ссылка открылась в выбранном браузере.
  function openTarget(url, mode) {
    if (!g.TBCrypto.isSafeUrl(url)) return "";
    const u = new URL(url);
    const https = u.protocol === "https:";
    const rest = url.replace(/^https?:\/\//i, "");
    if (IS_IOS) {
      if (mode === "safari") return (https ? "x-safari-https://" : "x-safari-http://") + rest;
      if (mode === "chrome") return (https ? "googlechromes://" : "googlechrome://") + rest;
      if (mode === "yandex") return "yandexbrowser-open-url://" + encodeURIComponent(url);
      if (mode === "firefox") return "firefox://open-url?url=" + encodeURIComponent(url);
      return url;
    }
    if (IS_ANDROID) {
      const pkg = { chrome: "com.android.chrome", yandex: "com.yandex.browser", firefox: "org.mozilla.firefox" }[mode];
      if (pkg && !u.hash) {
        return `intent://${rest}#Intent;scheme=${https ? "https" : "http"};package=${pkg};` +
          `S.browser_fallback_url=${encodeURIComponent(url)};end`;
      }
    }
    return url;
  }

  // ---------- быстрая отправка (закладка «📤 На ПК» и Быстрая команда) ----------
  // Ссылка передаётся странице send.html во фрагменте адреса (#...): эта часть
  // никогда не уходит в сеть — ни на GitHub, ни куда-либо ещё.
  const appBase = () => g.location.origin + g.location.pathname.replace(/[^/]*$/, "");
  // Адрес самого Tab Bridge (например, скопированный при настройке команды) — отправлять его незачем
  const isOwnUrl = (u) => {
    const x = String(u || "").replace(/^x-safari-/i, "").split(/[?#]/)[0];
    return [appBase(), appBase() + "index.html", appBase() + "send.html"].includes(x);
  };
  const quick = {
    sendPage: () => appBase() + "send.html",
    // Код закладки: берёт адрес и заголовок открытой страницы и переходит на send.html.
    bookmarklet: () =>
      "javascript:(function(){location.href=" + JSON.stringify(appBase() + "send.html#r=back&t=").replace(/"/g, "'") +
      "+encodeURIComponent(document.title.slice(0,200))+'&u='+encodeURIComponent(location.href)})()",
    // Начало адреса для Быстрой команды (дальше команда подставляет закодированную ссылку).
    shortcutPrefix: (ios16) => (ios16 ? "" : "x-safari-") + appBase() + "send.html#u=",
    // Разобрать фрагмент send.html: { url, title, back }
    parse(hash) {
      const h = String(hash || "").replace(/^#/, "");
      const at = h.startsWith("u=") ? 0 : h.indexOf("&u=") + 1;
      const head = at > 0 ? h.slice(0, at - 1) : at === 0 ? "" : h;
      const p = new URLSearchParams(head);
      let raw = at >= 0 ? h.slice(at + 2) : "";
      // Быстрая команда может прислать ссылку как закодированной, так и «как есть»
      if (!/^https?:\/\//i.test(raw)) { try { raw = decodeURIComponent(raw); } catch {} }
      let url = g.TBCrypto.extractUrl(raw) || (g.TBCrypto.isSafeUrl(raw) ? raw : "");
      let text = url ? "" : String(raw || "").trim().slice(0, 200000);
      if (isOwnUrl(url)) { url = ""; text = ""; }
      // empty: адрес вида «send.html#u=» без ссылки — команда «На ПК» ничего не передала
      return { url, text, title: String(p.get("t") || "").slice(0, 300), back: p.get("r") === "back", empty: at >= 0 && !url && !text };
    }
  };

  g.KV = KV;
  g.TB = {
    core, push: { register, unregister }, wipe, server, DEFAULT_SERVER, cleanUrl,
    openTarget, OPEN_MODES, defaultOpenMode, IS_IOS, IS_ANDROID, quick, VERSION, isOwnUrl
  };
})(self);
