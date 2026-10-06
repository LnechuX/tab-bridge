// Tab Bridge — страница для телефона. Работает в любом браузере, шифрование то же, что в расширении.
(function () {
  "use strict";

  const C = window.TBCrypto;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_SERVER = "https://ntfy.sh";
  const MAX_SEEN = 400;
  const MAX_HISTORY = 30;
  const FETCH_OPTS = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ---------- хранилище (только этот браузер на этом устройстве) ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem("tb_" + k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) { try { localStorage.setItem("tb_" + k, JSON.stringify(v)); } catch {} },
    wipe() {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith("tb_")).forEach((k) => localStorage.removeItem(k));
      } catch {}
    }
  };

  function randId(n) {
    const abc = "abcdefghijkmnpqrstuvwxyz23456789";
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b & 31]).join("");
  }

  function guessName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Android/i.test(ua)) return "Android";
    return "Телефон";
  }

  const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
  const server = () => cleanUrl(store.get("server", DEFAULT_SERVER)) || DEFAULT_SERVER;

  // ---------- то, что пришло в адресе ----------
  // Ключ из QR-кода приходит во фрагменте (#k=...), который браузер не отправляет на сервер.
  // Сразу убираем его из адресной строки и истории.
  const frag = new URLSearchParams(location.hash.slice(1));
  const incoming = { secret: frag.get("k") || "", server: frag.get("s") || "" };
  // «Поделиться» на Android (share target) приходит в параметрах запроса.
  const q = new URLSearchParams(location.search);
  const sharedUrl = C.extractUrl([q.get("url"), q.get("text"), q.get("title")].filter(Boolean).join(" "));
  const sharedTitle = q.get("title") || "";
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);

  // ---------- экраны ----------
  function showSetup(isEdit) {
    $("app").hidden = true;
    $("openSettings").hidden = true;
    $("setup").hidden = false;
    $("setupTitle").textContent = isEdit ? "Настройки" : "Подключение";
    $("saveSetup").textContent = isEdit ? "Сохранить" : "Подключить";
    $("cancelSetup").hidden = !isEdit;
    $("forget").hidden = !isEdit;
    $("setupHint").textContent = incoming.secret && !isEdit
      ? "Ключ получен из QR-кода. Проверьте название устройства и нажмите «Подключить»."
      : "Вставьте ключ из настроек расширения или отсканируйте QR-код камерой телефона.";
    $("secret").value = C.formatSecret(incoming.secret || store.get("secret", ""));
    $("server").value = incoming.server || server();
    $("deviceName").value = store.get("deviceName", "") || guessName();
    $("setupMsg").textContent = "";
  }

  function showApp() {
    $("setup").hidden = true;
    $("app").hidden = false;
    $("openSettings").hidden = false;
    renderList();
    startLive();
  }

  function setMsg(el, text, cls = "muted") {
    el.textContent = text;
    el.className = "msg " + cls;
  }

  $("showSecret").addEventListener("change", () => {
    $("secret").type = $("showSecret").checked ? "text" : "password";
  });

  $("saveSetup").addEventListener("click", () => {
    const secret = C.normalizeSecret($("secret").value);
    const srv = cleanUrl($("server").value) || DEFAULT_SERVER;
    const bad = C.checkSecret(secret);
    if (bad) return setMsg($("setupMsg"), bad, "err");
    if (!/^https:\/\/[^/\s]+/i.test(srv)) return setMsg($("setupMsg"), "Сервер должен быть на https://", "err");

    const changed = C.normalizeSecret(store.get("secret", "")) !== secret || server() !== srv;
    store.set("secret", secret);
    store.set("server", srv);
    store.set("deviceName", $("deviceName").value.trim().slice(0, 40) || guessName());
    if (!store.get("deviceId", "")) store.set("deviceId", randId(12));
    if (changed) {
      const now = nowSec();
      store.set("startTs", now);
      store.set("since", String(now));
      store.set("seen", []);
      store.set("nonces", []);
      store.set("history", []);
    }
    incoming.secret = "";
    incoming.server = "";
    $("secret").value = "";
    stopLive();
    showApp();
    maybeSendShared();
  });

  $("cancelSetup").addEventListener("click", () => { $("secret").value = ""; showApp(); });
  $("openSettings").addEventListener("click", () => { stopLive(); showSetup(true); });

  $("forget").addEventListener("click", () => {
    if (!confirm("Удалить ключ и историю с этого устройства?")) return;
    stopLive();
    store.wipe();
    incoming.secret = "";
    showSetup(false);
    setMsg($("setupMsg"), "Данные удалены.", "ok");
  });

  // ---------- отправка ----------
  async function sendLink(url, title) {
    const group = await C.deriveGroup(store.get("secret", ""));
    const message = await C.sealLink(group, {
      url, title, from: store.get("deviceName", guessName()), device: store.get("deviceId", "")
    });
    const r = await fetch(server(), {
      ...FETCH_OPTS,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: group.topic, message })
    });
    if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
  }

  async function doSend(url, title) {
    const u = C.extractUrl(url) || (C.isSafeUrl(url.trim()) ? url.trim() : "");
    if (!u) return setMsg($("sendMsg"), "Нужна ссылка, начинающаяся с https:// или http://", "err");
    $("send").disabled = true;
    setMsg($("sendMsg"), "Шифрую и отправляю…");
    try {
      await sendLink(u, title);
      setMsg($("sendMsg"), "✓ Отправлено на ваши устройства", "ok");
      $("url").value = "";
    } catch (e) {
      setMsg($("sendMsg"), String(e?.message || e), "err");
    } finally {
      $("send").disabled = false;
    }
  }

  $("send").addEventListener("click", () => doSend($("url").value, ""));
  $("url").addEventListener("keydown", (e) => { if (e.key === "Enter") doSend($("url").value, ""); });
  $("paste").addEventListener("click", async () => {
    try {
      const t = await navigator.clipboard.readText();
      $("url").value = C.extractUrl(t) || t.trim();
    } catch {
      setMsg($("sendMsg"), "Браузер не дал доступ к буферу — вставьте ссылку вручную.", "err");
    }
  });

  let sharedHandled = false;
  function maybeSendShared() {
    if (sharedHandled || !sharedUrl || !store.get("secret", "")) return;
    sharedHandled = true;
    $("url").value = sharedUrl;
    doSend(sharedUrl, sharedTitle);
  }

  // ---------- получение ----------
  function ago(sec) {
    const d = Math.max(0, nowSec() - sec);
    if (d < 60) return "только что";
    if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
    if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
    return new Date(sec * 1000).toLocaleDateString();
  }

  function renderList() {
    const items = store.get("history", []).filter((h) => C.isSafeUrl(h.url));
    const list = $("list");
    list.textContent = "";
    $("empty").hidden = items.length > 0;
    $("clear").hidden = items.length === 0;
    for (const h of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = h.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = h.title || h.url;
      const m = document.createElement("span");
      m.className = "m";
      m.textContent = [h.from, ago(h.time)].filter(Boolean).join(" · ");
      a.append(t, m);
      li.append(a);
      list.append(li);
    }
  }

  $("clear").addEventListener("click", () => { store.set("history", []); renderList(); });

  let chain = Promise.resolve();
  function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

  async function processMessages(msgs) {
    const secret = store.get("secret", "");
    if (!secret) return 0;
    const group = await C.deriveGroup(secret);
    const startTs = store.get("startTs", nowSec());
    const myId = store.get("deviceId", "");
    const seen = new Set(store.get("seen", []));
    const nonces = new Set(store.get("nonces", []));
    const fresh = [];
    for (const m of msgs) {
      if (!m || m.event !== "message" || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      if (typeof m.time !== "number" || m.time < startTs) continue;
      const link = await C.openLink(group, m.message);
      if (!link || nonces.has(link.nonce)) continue;
      nonces.add(link.nonce);
      if (Math.abs(link.ts - m.time) > C.MAX_CLOCK_SKEW) continue;
      if (link.device === myId) continue;
      fresh.push({ id: m.id, url: link.url, title: link.title, from: link.from, time: m.time });
    }
    store.set("seen", [...seen].slice(-MAX_SEEN));
    store.set("nonces", [...nonces].slice(-MAX_SEEN));
    if (fresh.length) {
      store.set("history", [...fresh.reverse(), ...store.get("history", [])].slice(0, MAX_HISTORY));
      renderList();
      if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
    }
    return fresh.length;
  }

  function poll() {
    return serial(async () => {
      const secret = store.get("secret", "");
      if (!secret) return;
      try {
        const group = await C.deriveGroup(secret);
        const since = store.get("since", String(nowSec()));
        const r = await fetch(`${server()}/${group.topic}/json?poll=1&since=${encodeURIComponent(since)}`, FETCH_OPTS);
        if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
        const msgs = (await r.text()).split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        await processMessages(msgs);
        const last = msgs.filter((m) => m.event === "message" && m.id).at(-1);
        if (last) store.set("since", last.id);
        setMsg($("state"), "Проверено в " + new Date().toLocaleTimeString(), "muted small");
      } catch (e) {
        setMsg($("state"), "Нет связи с сервером: " + (e?.message || e), "err small");
      }
    });
  }

  let ws = null;
  let timer = null;
  async function connectWs() {
    if (ws && ws.readyState <= 1) return;
    try {
      const group = await C.deriveGroup(store.get("secret", ""));
      const sock = new WebSocket(`${server().replace(/^http/i, "ws")}/${group.topic}/ws`);
      ws = sock;
      sock.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.event === "message") serial(() => processMessages([m]));
      };
      sock.onclose = sock.onerror = () => { if (ws === sock) ws = null; };
    } catch { ws = null; }
  }

  function startLive() {
    if (document.hidden || !store.get("secret", "")) return;
    poll();
    connectWs();
    clearInterval(timer);
    timer = setInterval(() => { poll(); connectWs(); }, 20000);
  }

  function stopLive() {
    clearInterval(timer);
    timer = null;
    try { ws?.close(); } catch {}
    ws = null;
  }

  document.addEventListener("visibilitychange", () => {
    if ($("app").hidden) return;
    if (document.hidden) stopLive(); else startLive();
  });

  // ---------- запуск ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (incoming.secret || !store.get("secret", "")) {
    showSetup(false);
  } else {
    showApp();
    maybeSendShared();
  }
})();
