// Tab Bridge (телефон) — общее для страницы и service worker:
//   KV       — хранилище в IndexedDB (доступно и странице, и фоновому обработчику push)
//   TBInbox  — приём, расшифровка и проверка сообщений
//   TBPush   — подписка на push-уведомления через сервер ntfy
(function (g) {
  "use strict";

  const C = g.TBCrypto;
  const DEFAULT_SERVER = "https://ntfy.sh";
  const NTFY_VAPID = "BEMjM0sNxh41x0a6Lz3YaqkJ7AUhZefxsOQgw-at69i0fM1CybVBcj7-QQXf4N_tPCgFnOXdRbQ5jrSrr9Yg9Lc";
  const FETCH_OPTS = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
  const MAX_SEEN = 400;
  const MAX_HISTORY = 30;
  const nowSec = () => Math.floor(Date.now() / 1000);
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
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    }));
  }
  const KV = {
    async get(k, d) { const v = await tx("readonly", (s) => s.get(k)); return v === undefined ? d : v; },
    set(k, v) { return tx("readwrite", (s) => { s.put(v, k); }); },
    setMany(o) { return tx("readwrite", (s) => { for (const k of Object.keys(o)) s.put(o[k], k); }); },
    clear() { return tx("readwrite", (s) => { s.clear(); }); }
  };

  async function server() { return cleanUrl(await KV.get("server", DEFAULT_SERVER)) || DEFAULT_SERVER; }

  // ---------- приём ----------
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // Возвращает { fresh: [новые ссылки], own: число своих сообщений }
  function process(msgs) {
    return serial(async () => {
      const secret = await KV.get("secret", "");
      if (!secret) return { fresh: [], own: 0 };
      const group = await C.deriveGroup(secret);
      const startTs = await KV.get("startTs", nowSec());
      const myId = await KV.get("deviceId", "");
      const seen = new Set(await KV.get("seen", []));
      const nonces = new Set(await KV.get("nonces", []));
      const fresh = [];
      let own = 0;
      for (const m of msgs) {
        if (!m || m.event !== "message" || !m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        if (typeof m.time !== "number" || m.time < startTs) continue;
        const link = await C.openLink(group, m.message);
        if (!link || nonces.has(link.nonce)) continue;        // чужое, подделка или повтор
        nonces.add(link.nonce);
        if (Math.abs(link.ts - m.time) > C.MAX_CLOCK_SKEW) continue;
        if (link.device === myId) { own++; continue; }
        fresh.push({ id: m.id, url: link.url, title: link.title, from: link.from, time: m.time });
      }
      const history = await KV.get("history", []);
      const ids = new Set(history.map((h) => h.id));
      const add = fresh.filter((h) => !ids.has(h.id)).reverse();
      await KV.setMany({
        seen: [...seen].slice(-MAX_SEEN),
        nonces: [...nonces].slice(-MAX_SEEN),
        history: [...add, ...history].slice(0, MAX_HISTORY)
      });
      return { fresh: add, own };
    });
  }

  async function poll() {
    const secret = await KV.get("secret", "");
    if (!secret) return { fresh: [], own: 0 };
    const group = await C.deriveGroup(secret);
    const since = await KV.get("since", String(await KV.get("startTs", nowSec())));
    const r = await fetch(`${await server()}/${group.topic}/json?poll=1&since=${encodeURIComponent(since)}`, FETCH_OPTS);
    if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
    const msgs = (await r.text()).split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const res = await process(msgs);
    const last = msgs.filter((m) => m.event === "message" && m.id).at(-1);
    if (last) await KV.set("since", last.id);
    return res;
  }

  // ---------- push ----------
  function b64urlToBytes(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }

  async function vapidKey(srv) {
    if (srv === DEFAULT_SERVER) return NTFY_VAPID;
    try {
      const t = await (await fetch(srv + "/config.js", FETCH_OPTS)).text();
      const m = t.match(/web_push_public_key"?\s*:\s*"([A-Za-z0-9_-]+)"/);
      return m ? m[1] : "";
    } catch { return ""; }
  }

  // Подписаться (или продлить подписку). reg — ServiceWorkerRegistration.
  async function register(reg) {
    const secret = await KV.get("secret", "");
    if (!secret) throw new Error("Сначала подключите устройство.");
    const srv = await server();
    const key = await vapidKey(srv);
    if (!key) throw new Error("Этот сервер не поддерживает push-уведомления.");
    const appKey = b64urlToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // подписка от другого сервера — пересоздаём
      const old = sub.options && sub.options.applicationServerKey;
      if (old && !sameBytes(new Uint8Array(old), appKey)) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const j = sub.toJSON();
    const group = await C.deriveGroup(secret);
    const r = await fetch(srv + "/v1/webpush", {
      ...FETCH_OPTS,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: j.endpoint, auth: j.keys.auth, p256dh: j.keys.p256dh, topics: [group.topic] })
    });
    if (!r.ok) throw new Error(`Сервер не принял подписку (${r.status})`);
    await KV.set("pushAt", Date.now());
    return true;
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

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  g.KV = KV;
  g.TBInbox = { process, poll, server, DEFAULT_SERVER, FETCH_OPTS, cleanUrl };
  g.TBPush = { register, unregister };
})(self);
