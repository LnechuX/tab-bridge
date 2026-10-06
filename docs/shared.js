// Tab Bridge (телефон) — общее для страницы и service worker:
//   KV        — хранилище в IndexedDB (его видят и страница, и обработчик push)
//   TB.core   — логика устройств и сообщений (tb-core.js)
//   TB.push   — подписка на push-уведомления через сервер ntfy
(function (g) {
  "use strict";

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

  const core = g.TBCore.create({ kv: KV, kind: "phone", defaultServer: DEFAULT_SERVER });

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
    await KV.clear();
  }

  g.KV = KV;
  g.TB = { core, push: { register, unregister }, wipe, server, DEFAULT_SERVER, cleanUrl };
})(self);
