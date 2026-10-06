// Tab Bridge — страница для телефона. Работает в любом браузере, шифрование то же, что в расширении.
// Данные хранятся в IndexedDB (см. shared.js), чтобы их видел и обработчик push-уведомлений.
(async function () {
  "use strict";

  const C = window.TBCrypto;
  const I = window.TBInbox;
  const $ = (id) => document.getElementById(id);
  const FETCH_OPTS = I.FETCH_OPTS;
  const nowSec = () => Math.floor(Date.now() / 1000);

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

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  // ---------- переход со старой версии (localStorage) ----------
  try {
    const old = localStorage.getItem("tb_secret");
    if (old && !(await KV.get("secret", ""))) {
      const get = (k, d) => { try { const v = localStorage.getItem("tb_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
      await KV.setMany({
        secret: get("secret", ""), server: get("server", I.DEFAULT_SERVER), deviceId: get("deviceId", randId(12)),
        deviceName: get("deviceName", guessName()), startTs: get("startTs", nowSec()), since: get("since", String(nowSec())),
        seen: get("seen", []), nonces: get("nonces", []), history: get("history", [])
      });
    }
    Object.keys(localStorage).filter((k) => k.startsWith("tb_")).forEach((k) => localStorage.removeItem(k));
  } catch {}

  // ---------- то, что пришло в адресе ----------
  // Ключ из QR-кода приходит во фрагменте (#k=...), который браузер не отправляет на сервер.
  const frag = new URLSearchParams(location.hash.slice(1));
  const incoming = { secret: frag.get("k") || "", server: frag.get("s") || "" };
  // «Поделиться» на Android приходит в параметрах запроса.
  const q = new URLSearchParams(location.search);
  const sharedUrl = C.extractUrl([q.get("url"), q.get("text"), q.get("title")].filter(Boolean).join(" "));
  const sharedTitle = q.get("title") || "";
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);

  const swReady = "serviceWorker" in navigator
    ? navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);

  function setMsg(el, text, cls = "muted") {
    el.textContent = text;
    el.className = "msg " + cls;
  }

  // ---------- экраны ----------
  async function showSetup(isEdit) {
    stopLive();
    $("app").hidden = true;
    $("openSettings").hidden = true;
    $("setup").hidden = false;
    $("setupTitle").textContent = isEdit ? "Настройки" : "Подключение";
    $("saveSetup").textContent = isEdit ? "Сохранить" : "Подключить";
    $("cancelSetup").hidden = !isEdit;
    $("forget").hidden = !isEdit;
    $("setupHint").textContent = incoming.secret && !isEdit
      ? "Ключ получен из QR-кода. Нажмите «Подключить»."
      : "Отсканируйте камерой телефона QR-код из расширения на компьютере или вставьте ключ.";
    $("secret").value = C.formatSecret(incoming.secret || await KV.get("secret", ""));
    $("server").value = incoming.server || await I.server();
    $("deviceName").value = (await KV.get("deviceName", "")) || guessName();
    $("setupMsg").textContent = "";
  }

  async function showApp() {
    $("setup").hidden = true;
    $("app").hidden = false;
    $("openSettings").hidden = false;
    await renderList();
    await renderPush();
    startLive();
  }

  $("showSecret").addEventListener("change", () => {
    $("secret").type = $("showSecret").checked ? "text" : "password";
  });

  $("saveSetup").addEventListener("click", async () => {
    const secret = C.normalizeSecret($("secret").value);
    const srv = I.cleanUrl($("server").value) || I.DEFAULT_SERVER;
    const bad = C.checkSecret(secret);
    if (bad) return setMsg($("setupMsg"), bad, "err");
    if (!/^https:\/\/[^/\s]+/i.test(srv)) return setMsg($("setupMsg"), "Сервер должен быть на https://", "err");

    const changed = C.normalizeSecret(await KV.get("secret", "")) !== secret || (await I.server()) !== srv;
    const patch = { secret, server: srv, deviceName: $("deviceName").value.trim().slice(0, 40) || guessName() };
    if (!(await KV.get("deviceId", ""))) patch.deviceId = randId(12);
    if (changed) {
      const now = nowSec();
      Object.assign(patch, { startTs: now, since: String(now), seen: [], nonces: [], history: [] });
    }
    await KV.setMany(patch);
    incoming.secret = "";
    incoming.server = "";
    $("secret").value = "";
    // нажатие «Подключить» — подходящий момент сразу попросить разрешение на уведомления
    if (pushSupported && Notification.permission === "default" && (!isIOS || isStandalone)) {
      enablePush().catch(() => {});
    } else if (pushSupported && Notification.permission === "granted") {
      refreshPush();
    }
    await showApp();
    maybeSendShared();
  });

  $("cancelSetup").addEventListener("click", () => { $("secret").value = ""; showApp(); });
  $("openSettings").addEventListener("click", () => showSetup(true));

  $("forget").addEventListener("click", async () => {
    if (!confirm("Удалить ключ, историю и отключить уведомления на этом устройстве?")) return;
    const reg = await swReady;
    if (reg) await TBPush.unregister(reg);
    await KV.clear();
    incoming.secret = "";
    await showSetup(false);
    setMsg($("setupMsg"), "Данные удалены.", "ok");
  });

  // ---------- уведомления ----------
  async function renderPush() {
    const card = $("pushCard");
    const btn = $("pushBtn");
    const text = $("pushText");
    $("pushOk").hidden = true;
    card.hidden = false;
    btn.hidden = true;

    if (isIOS && !isStandalone) {
      text.textContent = "Чтобы вкладки с компьютера приходили уведомлениями, добавьте страницу на главный экран: " +
        "кнопка «Поделиться» внизу Safari → «На экран „Домой“». Затем откройте Tab Bridge с главного экрана.";
      return;
    }
    if (!pushSupported) {
      text.textContent = "Этот браузер не поддерживает уведомления. Откройте страницу, чтобы увидеть присланные вкладки, " +
        "или используйте Chrome либо Яндекс Браузер.";
      return;
    }
    if (Notification.permission === "denied") {
      text.textContent = "Уведомления запрещены. Разрешите их для этого сайта в настройках браузера " +
        "(значок замка в адресной строке → Уведомления), затем обновите страницу.";
      return;
    }
    const reg = await swReady;
    const sub = reg && await reg.pushManager.getSubscription();
    if (Notification.permission === "granted" && sub && (await KV.get("pushAt", 0))) {
      card.hidden = true;
      $("pushOk").hidden = false;
      return;
    }
    text.textContent = "Включите уведомления — тогда вкладка, отправленная с компьютера, сразу появится на телефоне, " +
      "и её можно будет открыть одним нажатием.";
    btn.hidden = false;
  }

  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { await renderPush(); return; }
    const reg = await swReady;
    if (!reg) throw new Error("Браузер не дал запустить фоновый обработчик.");
    await TBPush.register(reg);
    await renderPush();
  }

  // продлеваем подписку при каждом открытии (сервер удаляет давно не обновлявшиеся)
  async function refreshPush() {
    try {
      const reg = await swReady;
      if (reg && Notification.permission === "granted") await TBPush.register(reg);
    } catch {}
  }

  $("pushBtn").addEventListener("click", async () => {
    $("pushBtn").disabled = true;
    setMsg($("pushMsg"), "Включаю…");
    try {
      await enablePush();
      setMsg($("pushMsg"), "");
    } catch (e) {
      setMsg($("pushMsg"), String(e?.message || e), "err");
    } finally {
      $("pushBtn").disabled = false;
    }
  });

  // ---------- отправка ----------
  async function sendLink(url, title) {
    const group = await C.deriveGroup(await KV.get("secret", ""));
    const message = await C.sealLink(group, {
      url, title, from: await KV.get("deviceName", guessName()), device: await KV.get("deviceId", "")
    });
    const r = await fetch(await I.server(), {
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
  async function maybeSendShared() {
    if (sharedHandled || !sharedUrl || !(await KV.get("secret", ""))) return;
    sharedHandled = true;
    $("url").value = sharedUrl;
    doSend(sharedUrl, sharedTitle);
  }

  // ---------- список полученных ----------
  function ago(sec) {
    const d = Math.max(0, nowSec() - sec);
    if (d < 60) return "только что";
    if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
    if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
    return new Date(sec * 1000).toLocaleDateString();
  }

  async function renderList() {
    const items = (await KV.get("history", [])).filter((h) => C.isSafeUrl(h.url));
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

  $("clear").addEventListener("click", async () => { await KV.set("history", []); renderList(); });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "tb-updated") renderList();
    });
  }

  // ---------- проверка, пока страница открыта ----------
  async function poll() {
    try {
      const r = await I.poll();
      if (r.fresh.length) {
        renderList();
        if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
      }
      setMsg($("state"), "Проверено в " + new Date().toLocaleTimeString(), "muted small");
    } catch (e) {
      setMsg($("state"), "Нет связи с сервером: " + (e?.message || e), "err small");
    }
  }

  let ws = null;
  let timer = null;
  async function connectWs() {
    if (ws && ws.readyState <= 1) return;
    try {
      const group = await C.deriveGroup(await KV.get("secret", ""));
      const sock = new WebSocket(`${(await I.server()).replace(/^http/i, "ws")}/${group.topic}/ws`);
      ws = sock;
      sock.onmessage = async (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.event !== "message") return;
        const r = await I.process([m]);
        if (r.fresh.length) renderList();
      };
      sock.onclose = sock.onerror = () => { if (ws === sock) ws = null; };
    } catch { ws = null; }
  }

  async function startLive() {
    if (document.hidden || !(await KV.get("secret", ""))) return;
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
    if (document.hidden) stopLive();
    else { startLive(); renderList(); }
  });

  // ---------- запуск ----------
  if (incoming.secret || !(await KV.get("secret", ""))) {
    await showSetup(false);
  } else {
    await showApp();
    refreshPush();
    maybeSendShared();
  }
})();
