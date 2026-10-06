// Tab Bridge — страница (приложение) для телефона.
// Подключение сохраняется в IndexedDB навсегда, пока вы сами не отключите телефон.
(async function () {
  "use strict";

  // Защита от встраивания в чужой сайт (кликджекинг): работаем только как самостоятельная страница.
  if (window.top !== window.self) {
    document.documentElement.textContent = "Tab Bridge нельзя открывать внутри другого сайта.";
    return;
  }

  const C = window.TBCrypto;
  const core = TB.core;
  const $ = (id) => document.getElementById(id);
  const nowSec = () => Math.floor(Date.now() / 1000);

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const guessName = () => /iPhone/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : "Телефон";

  const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : "🔹");
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function setMsg(node, text, cls = "muted") { node.textContent = text; node.className = "msg " + cls; }
  function ago(sec) {
    const d = Math.max(0, nowSec() - sec);
    if (d < 60) return "только что";
    if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
    if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
    return new Date(sec * 1000).toLocaleDateString();
  }

  // ---------- переход со старой версии ----------
  try {
    const old = localStorage.getItem("tb_secret");
    if (old && !(await KV.get("secret", ""))) {
      const get = (k, d) => { try { const v = localStorage.getItem("tb_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
      await KV.setMany({ secret: get("secret", ""), server: get("server", TB.DEFAULT_SERVER), deviceId: get("deviceId", ""), deviceName: get("deviceName", guessName()), startTs: get("startTs", nowSec()) });
    }
    Object.keys(localStorage).filter((k) => k.startsWith("tb_")).forEach((k) => localStorage.removeItem(k));
  } catch {}
  if (await KV.get("secret", "") && !(await KV.get("deviceId", ""))) await KV.set("deviceId", TBCore.randId(12));

  // ---------- что пришло в адресе ----------
  // Ключ из QR-кода — во фрагменте (#k=...), который браузер не отправляет на сервер. Сразу стираем его.
  const frag = new URLSearchParams(location.hash.slice(1));
  const incoming = { secret: frag.get("k") || "", server: frag.get("s") || "" };
  let openId = frag.get("o") || "";   // открыть ссылку (пришли из уведомления)
  const q = new URLSearchParams(location.search);
  let sharedUrl = C.extractUrl([q.get("url"), q.get("text"), q.get("title")].filter(Boolean).join(" "));
  const sharedTitle = q.get("title") || "";
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);

  const swReady = "serviceWorker" in navigator
    ? navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);

  const paired = async () => Boolean(await KV.get("secret", "")) && Boolean(await KV.get("deviceId", ""));

  // ---------- экраны ----------
  function show(id) {
    for (const s of ["install", "setup", "app", "settings"]) $(s).hidden = s !== id;
    $("openSettings").hidden = id !== "app";
    if (id !== "app") stopLive();
  }

  async function showSetup(note) {
    show("setup");
    $("deviceName").value = (await KV.get("deviceName", "")) || guessName();
    $("secret").value = C.formatSecret(incoming.secret);
    $("server").value = incoming.server || TB.DEFAULT_SERVER;
    $("manual").open = Boolean(incoming.secret);
    setMsg($("setupMsg"), note || "", note ? "ok" : "muted");
    $("setupHint").textContent = incoming.secret
      ? "Ключ получен из QR-кода — нажмите «Подключить»."
      : "Откройте на компьютере настройки Tab Bridge, нажмите «Показать QR-код» и отсканируйте его.";
  }

  async function showApp() {
    show("app");
    const i = await core.info();
    $("meLine").textContent = `🔒 ${i.me.name} · сквозное шифрование`;
    await render();
    await renderPush();
    startLive();
  }

  // ---------- подключение ----------
  async function connect(secret, server) {
    const bad = C.checkSecret(secret);
    if (bad) return setMsg($("setupMsg"), bad, "err");
    const srv = TB.cleanUrl(server) || TB.DEFAULT_SERVER;
    if (!/^https:\/\/[^/\s]+/i.test(srv)) return setMsg($("setupMsg"), "Сервер должен быть на https://", "err");
    setMsg($("setupMsg"), "Подключаю…");
    const reg = await swReady;
    if (await paired()) await TB.wipe(reg, true);
    await core.pair(secret, srv, $("deviceName").value.trim() || guessName());
    incoming.secret = ""; incoming.server = "";
    try { await navigator.storage?.persist?.(); } catch {}
    // нажатие — подходящий момент попросить разрешение на уведомления
    if (pushSupported && Notification.permission === "default" && (!isIOS || isStandalone)) enablePush().catch(() => {});
    else refreshPush();
    await showApp();
    setTimeout(() => poll(), 2500); // компьютер отвечает «привет» — подтягиваем его в список
    maybeSendShared();
  }

  $("saveSetup").addEventListener("click", () => connect(C.normalizeSecret($("secret").value), $("server").value));
  $("pairHere").addEventListener("click", () => showSetup());

  // ---------- сканер QR ----------
  let stream = null, scanTimer = null;
  function stopScan() {
    clearInterval(scanTimer); scanTimer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $("video").srcObject = null;
    $("scanner").hidden = true;
  }
  function parseCode(text) {
    const t = String(text || "").trim();
    const hashAt = t.indexOf("#");
    if (hashAt >= 0) {
      const p = new URLSearchParams(t.slice(hashAt + 1));
      if (p.get("k")) return { secret: C.normalizeSecret(p.get("k")), server: p.get("s") || "" };
    }
    const n = C.normalizeSecret(t);
    return C.checkSecret(n) ? null : { secret: n, server: "" };
  }
  $("scan").addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMsg($("setupMsg"), "Камера недоступна в этом браузере — введите ключ вручную.", "err");
      $("manual").open = true;
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (e) {
      setMsg($("setupMsg"), e && e.name === "NotAllowedError"
        ? "Нет доступа к камере. Разрешите его в настройках браузера или введите ключ вручную."
        : "Не удалось включить камеру — введите ключ вручную.", "err");
      $("manual").open = true;
      return;
    }
    $("scanner").hidden = false;
    $("scanMsg").textContent = "Наведите камеру на QR-код на экране компьютера";
    const video = $("video");
    video.srcObject = stream;
    try { await video.play(); } catch {}
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    scanTimer = setInterval(() => {
      if (!video.videoWidth) return;
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (!code) return;
      const r = parseCode(code.data);
      if (!r) { $("scanMsg").textContent = "Это не код Tab Bridge. Откройте на компьютере «Показать QR-код»."; return; }
      stopScan();
      if (navigator.vibrate) try { navigator.vibrate(80); } catch {}
      connect(r.secret, r.server);
    }, 200);
  });
  $("scanCancel").addEventListener("click", stopScan);

  // ---------- уведомления ----------
  async function renderPush() {
    const card = $("pushCard"), btn = $("pushBtn"), text = $("pushText");
    card.hidden = false; btn.hidden = true;
    if (isIOS && !isStandalone) {
      text.textContent = "Чтобы получать уведомления, добавьте Tab Bridge на экран «Домой» (Поделиться → На экран «Домой») и подключите его там через «Сканировать QR-код».";
      return;
    }
    if (!pushSupported) { text.textContent = "Этот браузер не поддерживает уведомления — откройте страницу, чтобы увидеть присланные вкладки, или используйте Chrome."; return; }
    if (Notification.permission === "denied") { text.textContent = "Уведомления запрещены. Разрешите их для этого сайта в настройках браузера и обновите страницу."; return; }
    const reg = await swReady;
    const sub = reg && await reg.pushManager.getSubscription().catch(() => null);
    if (Notification.permission === "granted" && sub && await KV.get("pushAt", 0)) { card.hidden = true; return; }
    text.textContent = "Включите уведомления — вкладка, отправленная с компьютера, сразу появится на телефоне, и её можно открыть одним нажатием.";
    btn.hidden = false;
  }
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      const reg = await swReady;
      if (!reg) throw new Error("Браузер не дал запустить фоновый обработчик.");
      await TB.push.register(reg);
    }
    await renderPush();
  }
  async function refreshPush() {
    try { const reg = await swReady; if (reg && pushSupported && Notification.permission === "granted") await TB.push.register(reg); } catch {}
  }
  $("pushBtn").addEventListener("click", async () => {
    $("pushBtn").disabled = true;
    setMsg($("pushMsg"), "Включаю…");
    try { await enablePush(); setMsg($("pushMsg"), ""); }
    catch (e) { setMsg($("pushMsg"), String(e?.message || e), "err"); }
    finally { $("pushBtn").disabled = false; }
  });

  // ---------- открытие ссылок ----------
  const modeName = (m) => (TB.OPEN_MODES.find((x) => x[0] === m) || [m, m])[1];
  async function openMode() {
    const m = await KV.get("openIn", TB.defaultOpenMode());
    return TB.OPEN_MODES.some((x) => x[0] === m) ? m : TB.defaultOpenMode();
  }
  // Режим держим в памяти: открывать нужно синхронно по нажатию, иначе iOS заблокирует окно.
  let currentMode = await openMode();
  function openLink(h, mode) {
    const target = TB.openTarget(h.url, mode || currentMode);
    if (!target) return;
    if (target === h.url) window.open(h.url, "_blank", "noopener,noreferrer");
    else location.href = target;   // переход в выбранный браузер (Safari, Chrome…)
    core.markOpened(h.id).then(render).catch(() => {});
  }
  // Открыть ссылку из уведомления. Браузер может не разрешить открыть её без нажатия —
  // поэтому сверху показываем карточку с кнопкой «Открыть»: тогда хватит одного касания.
  let pendingOpen = null;
  async function openById(id) {
    const h = (await core.info()).history.find((x) => x.id === id);
    if (!h) return;
    pendingOpen = h;
    $("openTitle").textContent = h.title || h.url;
    $("openGo").textContent = currentMode === "app" || currentMode === "default" ? "Открыть" : `Открыть в ${modeName(currentMode)}`;
    $("openCard").hidden = false;
    const target = TB.openTarget(h.url, currentMode);
    if (target && target !== h.url) {
      try { location.href = target; core.markOpened(h.id).then(render).catch(() => {}); } catch {}
    }
  }
  window.addEventListener("hashchange", () => {
    const o = new URLSearchParams(location.hash.slice(1)).get("o");
    if (o) { history.replaceState(null, "", location.pathname); openById(o); }
  });
  $("openGo").addEventListener("click", () => { if (pendingOpen) openLink(pendingOpen); $("openCard").hidden = true; pendingOpen = null; });
  $("openClose").addEventListener("click", () => { $("openCard").hidden = true; pendingOpen = null; });

  function showSheet(h) {
    $("sheetTitle").textContent = h.title || h.url;
    const box = $("sheetActions");
    box.textContent = "";
    for (const [m, label] of TB.OPEN_MODES) {
      const b = el("button", "", m === "app" ? "Открыть внутри Tab Bridge" : m === "default" ? "Открыть в браузере по умолчанию" : `Открыть в ${label}`);
      b.addEventListener("click", () => { hideSheet(); openLink(h, m); });
      box.append(b);
    }
    const copy = el("button", "", "Скопировать ссылку");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(h.url); copy.textContent = "✓ Скопировано"; }
      catch { copy.textContent = "Не удалось скопировать"; }
      setTimeout(hideSheet, 700);
    });
    box.append(copy);
    $("sheet").hidden = false;
  }
  function hideSheet() { $("sheet").hidden = true; }
  $("sheetCancel").addEventListener("click", hideSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) hideSheet(); });

  // ---------- отрисовка ----------
  let view = "recv";
  const STATE = {
    failed: ["не отправлено", "err"], sent: ["отправлено", ""],
    delivered: ["доставлено ✓", "st-delivered"], opened: ["открыто ✓✓", "st-opened"]
  };

  async function render() {
    const i = await core.info();
    renderTargets(i);
    renderList(i);
    renderDevices(i);
  }

  function renderTargets(i) {
    const box = $("targets");
    box.textContent = "";
    if (!i.devices.length) {
      box.append(el("div", "muted", "Компьютер появится здесь через несколько секунд после подключения. Если его нет — откройте на компьютере браузер."));
      return;
    }
    const mk = (label, ic, ids, primary) => {
      const b = el("button", primary ? "primary" : "");
      b.append(el("span", "ic", ic), el("span", "nm", label));
      b.addEventListener("click", () => doSend(ids, b));
      return b;
    };
    if (i.devices.length === 1) box.append(mk(`Отправить на «${i.devices[0].name}»`, icon(i.devices[0].kind), [i.devices[0].id], true));
    else {
      for (const d of i.devices) box.append(mk(d.name, icon(d.kind), [d.id], false));
      const all = el("button", "primary all", `На все устройства (${i.devices.length})`);
      all.addEventListener("click", () => doSend([], all));
      box.append(all);
    }
  }

  function renderList(i) {
    $("tabRecv").classList.toggle("on", view === "recv");
    $("tabSent").classList.toggle("on", view === "sent");
    const list = $("list");
    list.textContent = "";
    const items = view === "recv" ? i.history : i.sent;
    $("empty").hidden = items.length > 0;
    $("empty").textContent = view === "recv"
      ? "Пока ничего не приходило. Нажмите «Отправить» в Tab Bridge на компьютере."
      : "Вы ещё ничего не отправляли с этого телефона.";
    $("clear").hidden = !(i.history.length || i.sent.length);
    for (const it of items.slice(0, 30)) {
      if (view === "recv") {
        if (!C.isSafeUrl(it.url)) continue;
        const li = el("li", "recv" + (it.opened ? "" : " unread")), a = el("a");
        a.href = it.url; a.rel = "noopener noreferrer";
        a.append(el("span", "t", it.title || it.url),
          el("span", "m", [it.from ? `от «${it.from}»` : "", hostOf(it.url), ago(it.time), it.opened ? "открыто" : ""].filter(Boolean).join(" · ")));
        a.addEventListener("click", (e) => { e.preventDefault(); openLink(it); });
        const more = el("button", "more", "⋯");
        more.setAttribute("aria-label", "Другие способы открыть");
        more.addEventListener("click", () => showSheet(it));
        li.append(a, more);
        list.append(li);
      } else {
        const li = el("li", "sent");
        li.append(el("span", "t", it.title || it.url));
        const m = el("span", "m");
        it.to.forEach((t, n) => {
          if (n) m.append(document.createTextNode(", "));
          const [label, cls] = STATE[t.s] || STATE.sent;
          m.append(document.createTextNode(`→ ${t.name} · `), el("span", cls, label));
        });
        m.append(document.createTextNode(` · ${ago(it.time)}`));
        li.append(m);
        if (it.to.some((t) => t.s === "failed")) {
          const b = el("button", "retry", "Повторить");
          b.addEventListener("click", async () => {
            b.disabled = true;
            try { await core.resend(it.i); setMsg($("sendMsg"), "✓ Отправлено повторно", "ok"); }
            catch (e) { setMsg($("sendMsg"), String(e?.message || e), "err"); }
            render();
          });
          li.append(b);
        }
        list.append(li);
      }
    }
  }

  function renderDevices(i) {
    const box = $("devices");
    box.textContent = "";
    const row = (d, isMe) => {
      const div = el("div", "dev");
      const g = el("div", "grow");
      const nm = el("div", "nm", d.name);
      if (isMe) nm.append(el("span", "you", "этот телефон"));
      g.append(nm, el("div", "muted small", isMe ? "" : (d.lastSeen ? "в сети " + ago(d.lastSeen) : "")));
      div.append(el("span", "ic", icon(isMe ? "phone" : d.kind)), g);
      if (!isMe) {
        const b = el("button", "", "Удалить");
        b.addEventListener("click", async () => {
          if (!confirm(`Удалить «${d.name}»? На него больше нельзя будет отправлять, а само устройство отключится, как только выйдет в сеть.`)) return;
          b.disabled = true;
          try { await core.removeDevice(d.id); } catch (e) { alert(String(e?.message || e)); }
          render();
        });
        div.append(b);
      }
      box.append(div);
    };
    row(i.me, true);
    i.devices.forEach((d) => row(d, false));
  }

  $("tabRecv").addEventListener("click", async () => { view = "recv"; renderList(await core.info()); });
  $("tabSent").addEventListener("click", async () => { view = "sent"; renderList(await core.info()); });
  $("clear").addEventListener("click", async () => { await core.clearHistory(); render(); });

  // ---------- отправка ----------
  let busy = false;
  async function doSend(ids, btn, presetUrl, presetTitle) {
    if (busy) return;
    const raw = presetUrl || $("url").value;
    const u = C.extractUrl(raw) || (C.isSafeUrl(raw.trim()) ? raw.trim() : "");
    if (!u) return setMsg($("sendMsg"), "Вставьте ссылку, начинающуюся с https:// или http://", "err");
    busy = true;
    if (btn) btn.disabled = true;
    setMsg($("sendMsg"), "Шифрую и отправляю…");
    try {
      const e = await core.sendLink(u, presetTitle || "", ids);
      setMsg($("sendMsg"), "✓ Отправлено на " + e.to.map((x) => `«${x.name}»`).join(", "), "ok");
      $("url").value = "";
      view = "sent";
      render();
    } catch (e) {
      setMsg($("sendMsg"), String(e?.message || e), "err");
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  $("paste").addEventListener("click", async () => {
    try { const t = await navigator.clipboard.readText(); $("url").value = C.extractUrl(t) || t.trim(); }
    catch { setMsg($("sendMsg"), "Браузер не дал доступ к буферу — вставьте ссылку вручную.", "err"); }
  });

  // «Поделиться» на Android: одно устройство — отправляем сразу, несколько — даём выбрать
  async function maybeSendShared() {
    if (!sharedUrl || !(await paired())) return;
    const u = sharedUrl;
    sharedUrl = "";
    const i = await core.info();
    $("url").value = u;
    if (i.devices.length === 1) doSend([i.devices[0].id], null, u, sharedTitle);
    else if (i.devices.length > 1) setMsg($("sendMsg"), "Выберите, куда отправить ссылку.");
    else setMsg($("sendMsg"), "Компьютер ещё не появился в списке — подождите несколько секунд и нажмите «Отправить».", "err");
  }

  // ---------- настройки ----------
  $("openSettings").addEventListener("click", async () => {
    show("settings");
    $("myName").value = (await core.info()).me.name;
    const sel = $("openIn");
    sel.textContent = "";
    for (const [m, label] of TB.OPEN_MODES) { const o = el("option", "", label); o.value = m; sel.append(o); }
    sel.value = await openMode();
    renderOpenHint();
    setMsg($("settingsMsg"), "");
  });
  function renderOpenHint() {
    const m = $("openIn").value;
    $("openHint").textContent =
      TB.IS_IOS && m === "safari" ? "Нужна iOS 15 или 17 и новее (на iOS 16 Safari так не открывается — выберите другой браузер)." :
      m === "app" ? "Ссылка откроется во встроенном окне поверх Tab Bridge." :
      m === "default" ? "Ссылка откроется так, как настроено в телефоне." :
      `Нужно, чтобы ${modeName(m)} был установлен. Нажмите «Проверить».`;
  }
  $("openIn").addEventListener("change", async () => {
    await KV.set("openIn", $("openIn").value);
    currentMode = $("openIn").value;
    renderOpenHint();
    setMsg($("settingsMsg"), "Сохранено ✓", "ok");
  });
  $("testOpen").addEventListener("click", () => {
    const t = TB.openTarget("https://example.com/", $("openIn").value);
    if (t === "https://example.com/") window.open(t, "_blank", "noopener,noreferrer"); else location.href = t;
  });
  $("closeSettings").addEventListener("click", showApp);
  $("saveName").addEventListener("click", async () => {
    await core.rename($("myName").value);
    setMsg($("settingsMsg"), "Сохранено ✓ — новое имя увидят ваши устройства", "ok");
  });
  $("forget").addEventListener("click", async () => {
    if (!confirm("Отключить этот телефон? Он исчезнет из списка на остальных устройствах.")) return;
    await TB.wipe(await swReady, true);
    await showSetup("Телефон отключён. Чтобы подключить снова — отсканируйте QR-код.");
  });

  // ---------- обновление, пока открыто ----------
  async function onResult(r) {
    if (!r) return;
    if (r.removedMe) {
      await TB.wipe(await swReady, false);
      return showSetup("Этот телефон удалили из списка на другом устройстве. Чтобы подключить снова — отсканируйте QR-код.");
    }
    if (r.clockSkew) setMsg($("state"), "Часы телефона или компьютера расходятся больше чем на 10 минут — проверьте дату и время.", "err small");
    if (r.fresh.length && navigator.vibrate) try { navigator.vibrate(60); } catch {}
    if (r.fresh.length || r.devicesChanged || r.sentChanged) render();
  }

  async function poll() {
    try {
      const r = await core.poll();
      await onResult(r);
      if (!r.clockSkew) setMsg($("state"), "Проверено в " + new Date().toLocaleTimeString(), "muted small");
    } catch (e) {
      setMsg($("state"), "Нет связи с сервером: " + (e?.message || e), "err small");
    }
  }

  let ws = null, timer = null;
  async function connectWs() {
    if (ws && ws.readyState <= 1) return;
    try {
      const url = await core.wsUrl();
      if (!url) return;
      const sock = new WebSocket(url);
      ws = sock;
      sock.onmessage = async (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.event === "message") onResult(await core.handle([m]));
      };
      sock.onclose = sock.onerror = () => { if (ws === sock) ws = null; };
    } catch { ws = null; }
  }
  async function startLive() {
    if (document.hidden || !(await paired())) return;
    poll();
    connectWs();
    core.maybeHello().catch(() => {});
    clearInterval(timer);
    timer = setInterval(() => { poll(); connectWs(); }, 20000);
  }
  function stopLive() {
    clearInterval(timer); timer = null;
    try { ws?.close(); } catch {}
    ws = null;
  }
  document.addEventListener("visibilitychange", () => {
    if ($("app").hidden) return;
    if (document.hidden) stopLive(); else { startLive(); render(); }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (!e.data) return;
      if (e.data.type === "tb-updated" && !$("app").hidden) render();
      if (e.data.type === "tb-removed") showSetup("Этот телефон удалили из списка на другом устройстве.");
      if (e.data.type === "tb-open" && e.data.id) openById(String(e.data.id));
    });
  }

  // ---------- запуск ----------
  if (await paired() && !incoming.secret) {
    await showApp();
    if (openId) { const id = openId; openId = ""; openById(id); }
    refreshPush();
    maybeSendShared();
  } else if (isIOS && !isStandalone && incoming.secret) {
    show("install");
  } else {
    await showSetup();
  }
})();
