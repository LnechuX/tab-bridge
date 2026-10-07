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

  const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : k === "sender" ? "📤" : "🔹");
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
  const incoming = { secret: frag.get("k") || "", server: frag.get("s") || "", fromApp: frag.get("sender") === "1" };
  let openId = frag.get("o") || "";   // открыть ссылку (пришли из уведомления)
  const q = new URLSearchParams(location.search);
  let sharedUrl = C.extractUrl([q.get("url"), q.get("text"), q.get("title")].filter(Boolean).join(" "));
  const sharedTitle = q.get("title") || "";
  const wantClip = q.get("a") === "clip";   // ярлык «Отправить скопированную ссылку» (Android)
  let wantShared = q.get("shared") === "1";  // «Поделиться» картинкой/текстом на Android
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);

  const swReady = "serviceWorker" in navigator
    ? navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);

  const paired = async () => Boolean(await KV.get("secret", "")) && Boolean(await KV.get("deviceId", ""));

  // ---------- экраны ----------
  let lastScreen = "app";
  function show(id) {
    if (id !== "quick") lastScreen = id;
    for (const s of ["install", "setup", "app", "settings", "quick"]) $(s).hidden = s !== id;
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
    const sender = i.me.kind === "sender";
    $("meLine").textContent = `🔒 ${i.me.name} · сквозное шифрование`;
    $("senderCard").hidden = !sender;
    $("tabRecv").hidden = sender;
    if (sender) view = "sent";
    $("quickBanner").hidden = !(isIOS && !(await KV.get("quickBannerHidden", false)));
    $("quickBannerGo").textContent = (window.TB_PHONE || {}).shortcutUrl ? "Настроить за 1 минуту" : "Настроить";
    $("androidHint").hidden = !TB.IS_ANDROID;
    $("pasteHint").hidden = !isIOS;
    await render();
    if (sender) $("pushCard").hidden = true; else await renderPush();
    startLive();
    flushPendingSend();
    core.maybeCleanup().catch(() => {});
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

  // Safari на iPhone, открытый по QR-коду (или кнопкой из приложения), подключается сам —
  // только для отправки. Получать вкладки будет приложение на экране «Домой».
  async function pairSafariSender(secret, server) {
    const s = C.normalizeSecret(secret);
    if (C.checkSecret(s)) return false;
    const srv = TB.cleanUrl(server) || TB.DEFAULT_SERVER;
    const same = (await paired()) && C.normalizeSecret(await KV.get("secret", "")) === s && (await TB.server()) === srv;
    if (!same) {
      if (await paired()) await TB.wipe(null, true);
      await core.pair(s, srv, "Safari · " + guessName(), { kind: "sender" });
      try { await navigator.storage?.persist?.(); } catch {}
    }
    return true;
  }

  async function showInstall() {
    show("install");
    // пришли кнопкой «Подключить Safari» из приложения — приложение уже установлено
    $("installCard").hidden = incoming.fromApp;
    $("safariOkText").textContent = incoming.fromApp
      ? "Вернитесь в приложение Tab Bridge — там следующий шаг. Кнопка «◀ Tab Bridge» вверху слева или значок на экране «Домой»."
      : "Теперь из Safari можно отправлять ссылки на компьютер. Чтобы и получать — установите приложение:";
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
      if (navigator.vibrate && navigator.userActivation?.hasBeenActive) try { navigator.vibrate(80); } catch {}
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
    if (h.kind === "text" || h.kind === "file") return showViewer(id);
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
  let sheetCancelHook = null;
  function hideSheet() { $("sheet").hidden = true; sheetCancelHook = null; }
  function cancelSheet() { const h = sheetCancelHook; hideSheet(); if (h) h(); }
  $("sheetCancel").addEventListener("click", cancelSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) cancelSheet(); });

  // ---------- отрисовка ----------
  let view = "recv";
  const STATE = {
    failed: ["не отправлено", "err"], sent: ["отправлено", ""],
    delivered: ["доставлено ✓", "st-delivered"], opened: ["открыто ✓✓", "st-opened"]
  };

  async function render() {
    const i = await core.info();
    renderTargets(i);
    renderClipTarget(i);
    renderList(i);
    renderDevices(i);
  }

  async function renderClipTarget(i) {
    const ids = await quickIds(i);
    const t = i.targets;
    const label = !t.length ? "" :
      ids && ids.length === 1 ? `на «${(t.find((d) => d.id === ids[0]) || {}).name}»` :
      ids ? "на все устройства" : "вы выберете, на какое устройство";
    for (const id of ["clipTarget", "photoTarget", "textTarget"]) $(id).textContent = label;
  }

  function renderTargets(i) {
    const box = $("targets");
    box.textContent = "";
    if (!i.targets.length) {
      box.append(el("div", "muted", "Компьютер появится здесь через несколько секунд после подключения. Если его нет — откройте на компьютере браузер."));
      return;
    }
    const mk = (label, ic, ids, primary) => {
      const b = el("button", primary ? "primary" : "");
      b.append(el("span", "ic", ic), el("span", "nm", label));
      b.addEventListener("click", () => doSend(ids, b));
      return b;
    };
    if (i.targets.length === 1) box.append(mk(`Отправить на «${i.targets[0].name}»`, icon(i.targets[0].kind), [i.targets[0].id], true));
    else {
      for (const d of i.targets) box.append(mk(d.name, icon(d.kind), [d.id], false));
      const all = el("button", "primary all", `На все устройства (${i.targets.length})`);
      all.addEventListener("click", () => doSend([], all));
      box.append(all);
    }
  }

  // ---------- полученные текст и картинки ----------
  const IMAGE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const isImage = (h) => h.kind === "file" && IMAGE.includes(h.file?.mime);
  let thumbUrls = [];
  function recvItem(it) {
    const li = el("li", "recv" + (it.opened ? "" : " unread"));
    const a = el("a");
    a.href = "#";
    let pic;
    if (isImage(it) && it.status === "ok") {
      pic = el("img", "rthumb");
      pic.alt = "";
      core.getFile(it.id).then((b) => { if (b) { const u = URL.createObjectURL(b); thumbUrls.push(u); pic.src = u; } });
    } else pic = el("span", "rk", it.status === "gone" ? "🗑" : it.kind === "text" ? "✏️" : it.status === "error" ? "⚠️" : it.kind === "file" && !isImage(it) ? "📎" : "🖼");
    const state = it.status === "loading" ? "скачивается…" : it.status === "error" ? "не скачан — нажмите, чтобы повторить" :
      it.status === "gone" ? "файл удалён" : it.opened ? "открыто" : "";
    const body = el("span", "grow");
    body.append(el("span", "t" + (it.status === "error" ? " err-t" : ""), it.kind === "text" ? (it.title || "Текст") : it.title),
      el("span", "m", [it.from ? `от «${it.from}»` : "", ago(it.time), state].filter(Boolean).join(" · ")));
    a.append(pic, body);
    a.classList.add("recv-row");
    a.addEventListener("click", (e) => { e.preventDefault(); showViewer(it.id); });
    li.append(a);
    return li;
  }

  function vbtn(label, fn, primary) {
    const b = el("button", primary ? "primary" : "", label);
    b.addEventListener("click", fn);
    $("viewerActions").append(b);
    return b;
  }
  let viewerUrl = null;
  function closeViewer() {
    $("viewer").hidden = true;
    $("viewerBody").textContent = "";
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  }
  $("viewerClose").addEventListener("click", closeViewer);

  async function showViewer(id) {
    const h = (await core.info()).history.find((x) => x.id === id);
    if (!h) return;
    closeViewer();
    $("viewer").hidden = false;
    $("viewerActions").textContent = "";
    setMsg($("viewerMsg"), "");
    $("viewerTitle").textContent = h.kind === "text" ? "Текст" : h.title;
    $("viewerMeta").textContent = [h.from ? `от «${h.from}»` : "", ago(h.time)].filter(Boolean).join(", ");
    if (h.status === "loading") { setMsg($("viewerMsg"), "Скачиваю…"); setTimeout(() => showViewer(id), 800); return; }
    if (h.status === "gone") {
      $("viewerBody").append(el("p", "muted center", h.gone === "age" ? "Файл удалён автоматически: истёк срок хранения (Настройки → Память)."
        : h.gone === "space" ? "Файл удалён автоматически, чтобы освободить место для новых." : "Файл удалён с телефона."));
      return;
    }
    if (h.status === "error") {
      setMsg($("viewerMsg"), h.error || "Не удалось скачать.", "err");
      vbtn("Повторить", async () => { setMsg($("viewerMsg"), "Скачиваю…"); await core.fetchFile(id); render(); showViewer(id); }, true);
      return;
    }
    core.markOpened(id).then(render).catch(() => {});
    if (h.kind === "text") {
      const text = (await core.getText(id)) || "";      // длинный текст лежит в хранилище файлов
      h.text = text;
      const pre = el("pre", "", text);
      $("viewerBody").append(pre);
      vbtn("📋 Скопировать текст", async () => {
        try { await navigator.clipboard.writeText(text); setMsg($("viewerMsg"), "✓ Скопировано", "ok"); }
        catch { setMsg($("viewerMsg"), "Не удалось скопировать — выделите текст и скопируйте.", "err"); }
      }, true);
      const links = C.extractUrl(h.text || "");
      if (links) vbtn("Открыть ссылку из текста", () => openLink({ id: h.id, url: links }));
      return;
    }
    const blob = await core.getFile(id);
    if (!blob) return setMsg($("viewerMsg"), "Файл не найден на телефоне (история была очищена).", "err");
    const file = new File([blob], h.file.name, { type: blob.type });
    if (isImage(h)) {
      viewerUrl = URL.createObjectURL(blob);
      const img = el("img");
      img.src = viewerUrl;
      img.alt = h.title;
      $("viewerBody").append(img);
    } else {
      $("viewerBody").append(el("p", "muted center", "Этот файл можно только сохранить."));
    }
    // «Сохранить»: на iPhone/Android — через меню «Поделиться» (там «Сохранить изображение»)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      vbtn(isImage(h) ? "Сохранить в «Фото» или поделиться" : "Сохранить или поделиться", async () => {
        try { await navigator.share({ files: [file] }); } catch (e) { if (e?.name !== "AbortError") setMsg($("viewerMsg"), "Не удалось открыть меню «Поделиться».", "err"); }
      }, true);
    } else {
      vbtn("Скачать", () => {
        const a = el("a"); a.href = URL.createObjectURL(blob); a.download = h.file.name;
        document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }, true);
    }
    if (isImage(h) && window.ClipboardItem && navigator.clipboard?.write) {
      vbtn("📋 Скопировать картинку", async () => {
        try {
          const png = blob.type === "image/png" ? blob : await toPng(blob);
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          setMsg($("viewerMsg"), "✓ Скопировано", "ok");
        } catch { setMsg($("viewerMsg"), "Не удалось скопировать.", "err"); }
      });
    }
  }
  async function toPng(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    return new Promise((r) => c.toBlob(r, "image/png"));
  }

  function renderList(i) {
    thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    thumbUrls = [];
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
        if (it.kind === "text" || it.kind === "file") { list.append(recvItem(it)); continue; }
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
        const ki = it.kind === "text" ? "✏️ " : it.kind === "file" ? "🖼 " : "";
        li.append(el("span", "t", ki + (it.title || it.url)));
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
      if (isMe) nm.append(el("span", "you", d.kind === "sender" ? "этот Safari" : "этот телефон"));
      const meta = [d.kind === "sender" ? "только отправка" : "", !isMe && d.lastSeen ? "в сети " + ago(d.lastSeen) : ""].filter(Boolean).join(" · ");
      g.append(nm, el("div", "muted small", meta));
      div.append(el("span", "ic", icon(isMe && d.kind !== "sender" ? "phone" : d.kind)), g);
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

  // ---------- отправка: общее для ссылок, скриншотов и текста ----------
  let busy = false;
  let doneTimer = null;

  // Выполнить отправку с индикацией. job(ids) → запись «Отправлено» (или массив записей).
  async function runSend(ids, job, btn, busyText) {
    if (busy) return false;
    busy = true;
    if (btn) btn.disabled = true;
    $("sentDone").hidden = true;
    setMsg($("sendMsg"), busyText || "Отправляю…");
    try {
      const res = await job(ids, (t) => setMsg($("sendMsg"), t));
      const e = Array.isArray(res) ? res[res.length - 1] : res;
      setMsg($("sendMsg"), "");
      $("sentDoneText").textContent = "Отправлено на " + e.to.filter((x) => x.s !== "failed").map((x) => `«${x.name}»`).join(", ");
      $("sentDone").hidden = false;
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => { $("sentDone").hidden = true; }, 8000);
      view = "sent";
      render();
      return true;
    } catch (e) {
      setMsg($("sendMsg"), String(e?.message || e), "err");
      return false;
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  // Куда отправлять без вопросов: один получатель — ему; иначе настройка «Быстрая отправка».
  // null — нужно спросить.
  async function quickIds(i) {
    const t = i.targets;
    if (t.length === 1) return [t[0].id];
    if (!t.length) return null;
    const qt = await KV.get("quickTarget", "ask");
    if (qt === "all") return [];
    if (t.some((d) => d.id === qt)) return [qt];
    return null;
  }

  // Спросить, куда отправить (нижнее меню со списком устройств). Возвращает ids или null.
  function chooseTargets(i, what) {
    return new Promise((resolve) => {
      $("sheetTitle").textContent = "Куда отправить" + (what ? " " + what : "") + "?";
      const box = $("sheetActions");
      box.textContent = "";
      const pick = (ids) => { hideSheet(); resolve(ids); };
      for (const d of i.targets) {
        const b = el("button", "", `${icon(d.kind)}  ${d.name}`);
        b.addEventListener("click", () => pick([d.id]));
        box.append(b);
      }
      const all = el("button", "primary", `На все устройства (${i.targets.length})`);
      all.addEventListener("click", () => pick([]));
      box.append(all);
      sheetCancelHook = () => resolve(null);
      $("sheet").hidden = false;
    });
  }

  // Определить получателей: сразу или спросить. null — отмена / некуда.
  async function pickTargets(what) {
    const i = await core.info();
    if (!i.targets.length) {
      setMsg($("sendMsg"), "Компьютер ещё не появился в списке. Откройте на компьютере браузер и попробуйте через несколько секунд.", "err");
      return null;
    }
    return (await quickIds(i)) ?? (await chooseTargets(i, what));
  }

  // --- ссылки ---
  async function doSend(ids, btn, presetUrl, presetTitle) {
    const raw = presetUrl || $("url").value;
    const u = C.extractUrl(raw) || (C.isSafeUrl(raw.trim()) ? raw.trim() : "");
    if (!u) return setMsg($("sendMsg"), "Вставьте ссылку, начинающуюся с https:// или http://", "err");
    const ok = await runSend(ids, (to) => core.sendLink(u, presetTitle || "", to), btn);
    if (ok) $("url").value = "";
    return ok;
  }

  $("paste").addEventListener("click", async () => {
    try { const t = await navigator.clipboard.readText(); $("url").value = C.extractUrl(t) || t.trim(); }
    catch { setMsg($("sendMsg"), "Браузер не дал доступ к буферу — вставьте ссылку вручную.", "err"); }
  });

  async function quickSend(u, title, after) {
    const ids = await pickTargets(hostOf(u));
    if (!ids) { $("url").value = u; $("manualSend").open = true; return; }
    const ok = await doSend(ids, null, u, title);
    if (ok && after) after();
  }

  // «📋 Вставить и отправить»: ссылка — отправляем; просто текст — открываем «Текст»; картинка — «Скриншот»
  $("clipSend").addEventListener("click", () => {
    // буфер нужно прочитать сразу по нажатию — иначе iPhone не даст доступ
    const p = navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error("нет доступа"));
    p.then(async (t) => {
      const u = C.extractUrl(t);
      if (u) return quickSend(u, "");
      if (String(t || "").trim()) {
        setPane("text");
        $("textInput").value = t;
        return setMsg($("sendMsg"), "В буфере текст, а не ссылка. Проверьте его и нажмите «Отправить текст».");
      }
      if (await pasteImage(true)) return;
      setMsg($("sendMsg"), "Сначала скопируйте ссылку: «Поделиться» → «Скопировать». Потом нажмите кнопку ещё раз.", "err");
    }, async () => {
      if (await pasteImage(true)) return;
      setMsg($("sendMsg"), "Не удалось вставить. Когда iPhone спросит «Вставить?», нажмите «Вставить».", "err");
    });
  });

  // --- вкладки ---
  function setPane(name) {
    for (const [seg, pane, n] of [["segLink", "paneLink", "link"], ["segPhoto", "panePhoto", "photo"], ["segText", "paneText", "text"]]) {
      $(seg).setAttribute("aria-selected", String(n === name));
      $(pane).hidden = n !== name;
    }
    setMsg($("sendMsg"), "");
    $("sentDone").hidden = true;
  }
  $("segLink").addEventListener("click", () => setPane("link"));
  $("segPhoto").addEventListener("click", () => setPane("photo"));
  $("segText").addEventListener("click", () => { setPane("text"); $("textInput").focus(); });

  // --- скриншоты и фото ---
  let photos = [];                               // [{ blob, name, url }]
  const MAX_PHOTOS = 10;
  function renderPhotos() {
    const box = $("thumbs");
    box.textContent = "";
    photos.forEach((p, n) => {
      const d = el("div", "thumb");
      const img = el("img");
      img.src = p.url;
      img.alt = p.name;
      const x = el("button", "", "✕");
      x.setAttribute("aria-label", "Убрать " + p.name);
      x.addEventListener("click", () => { URL.revokeObjectURL(p.url); photos.splice(n, 1); renderPhotos(); });
      d.append(img, x);
      box.append(d);
    });
    $("photoSend").hidden = !photos.length;
    $("photoSendMain").textContent = photos.length > 1 ? `Отправить ${photos.length} картинки` : "Отправить картинку";
  }
  function addPhotos(list) {
    for (const f of list) {
      if (!/^image\//.test(f.type || "")) { setMsg($("sendMsg"), `«${f.name || "файл"}» — не картинка.`, "err"); continue; }
      if (f.size > C.MAX_FILE) { setMsg($("sendMsg"), `«${f.name || "картинка"}» больше 14 МБ — такую не отправить.`, "err"); continue; }
      if (photos.length >= MAX_PHOTOS) { setMsg($("sendMsg"), `За раз — не больше ${MAX_PHOTOS} картинок.`, "err"); break; }
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : `Скриншот ${new Date().toLocaleString().replace(/[/:]/g, "-")}.${ext}`;
      photos.push({ blob: f, name, url: URL.createObjectURL(f) });
    }
    renderPhotos();
  }
  $("photoPick").addEventListener("click", () => $("photoInput").click());
  $("photoInput").addEventListener("change", () => { addPhotos([...$("photoInput").files]); $("photoInput").value = ""; });

  // Вставить картинку из буфера. quiet — не ругаться, если картинки нет.
  async function pasteImage(quiet) {
    try {
      if (!navigator.clipboard?.read) throw new Error("no");
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => /^image\//.test(t));
        if (type) {
          const blob = await it.getType(type);
          setPane("photo");
          addPhotos([new File([blob], "image." + (type.split("/")[1] || "png"), { type })]);
          return true;
        }
      }
    } catch {}
    if (!quiet) setMsg($("sendMsg"), "В буфере нет картинки. Скопируйте скриншот: миниатюра → ⎙ → «Скопировать».", "err");
    return false;
  }
  $("photoPaste").addEventListener("click", () => pasteImage(false));

  async function sendPhotos() {
    if (!photos.length) return false;
    const ids = await pickTargets(photos.length > 1 ? "картинки" : "картинку");
    if (!ids) return false;
    const list = photos.slice();
    const ok = await runSend(ids, async (to, progress) => {
      const out = [];
      for (let n = 0; n < list.length; n++) {
        progress(list.length > 1 ? `Отправляю ${n + 1} из ${list.length}…` : "Шифрую и отправляю…");
        out.push(await core.sendFile(list[n].blob, list[n].name, to));
        URL.revokeObjectURL(list[n].url);
        photos = photos.filter((p) => p !== list[n]);
        renderPhotos();
      }
      return out;
    }, $("photoSend"), "Шифрую и отправляю…");
    if (ok) renderPhotos();
    return ok;
  }
  $("photoSend").addEventListener("click", () => sendPhotos());

  // --- текст ---
  $("textPaste").addEventListener("click", async () => {
    try { const t = await navigator.clipboard.readText(); if (t) $("textInput").value = t; else setMsg($("sendMsg"), "Буфер пуст.", "err"); }
    catch { setMsg($("sendMsg"), "Не удалось вставить. Когда iPhone спросит «Вставить?», нажмите «Вставить».", "err"); }
  });
  async function sendTextNow(text, after) {
    const ids = await pickTargets("текст");
    if (!ids) return false;
    const ok = await runSend(ids, (to) => core.sendText(text, to), $("textSend"));
    if (ok) { $("textInput").value = ""; if (after) after(); }
    return ok;
  }
  $("textSend").addEventListener("click", () => {
    const t = $("textInput").value;
    if (!t.trim()) return setMsg($("sendMsg"), "Напишите или вставьте текст.", "err");
    sendTextNow(t);
  });

  // «Поделиться» на Android: после успешной отправки приложение пробует закрыться само
  const closeSoon = () => setTimeout(() => { try { window.close(); } catch {} }, 1200);
  async function maybeSendShared() {
    if (!(await paired())) return;
    if (sharedUrl) {
      const u = sharedUrl;
      sharedUrl = "";
      return quickSend(u, sharedTitle, closeSoon);
    }
    if (!wantShared) return;
    wantShared = false;
    const p = await KV.get("pendingShare", null);
    await KV.set("pendingShare", null);
    if (!p) return;
    if (Date.now() - (p.ts || 0) > 10 * 60 * 1000) { for (const f of p.files || []) TBBlobs.del(f.key).catch(() => {}); return; }
    const files = [];
    for (const f of p.files || []) {
      const b = await TBBlobs.get(f.key).catch(() => null);
      TBBlobs.del(f.key).catch(() => {});
      if (b) files.push(new File([b], f.name || "image.png", { type: f.type || b.type }));
    }
    if (files.length) {
      setPane("photo");
      addPhotos(files);
      // получатель известен — отправляем сразу, как и ссылки; иначе пользователь выберет
      if ((await quickIds(await core.info())) && await sendPhotos()) closeSoon();
      return;
    }
    const u = C.extractUrl([p.url, p.text, p.title].filter(Boolean).join(" "));
    if (u) return quickSend(u, p.title || "", closeSoon);
    if (String(p.text || "").trim()) { setPane("text"); $("textInput").value = p.text; return sendTextNow(p.text, closeSoon); }
  }

  // Ссылка, которую пытались отправить из ещё не подключённого браузера (send.html)
  let pendingTries = 0;
  async function flushPendingSend() {
    const p = await KV.get("pendingSend", null);
    if (!p || (!p.u && !p.x)) return;
    if (Date.now() - (p.ts || 0) > 30 * 60 * 1000 || (p.u && !C.isSafeUrl(p.u))) { await KV.set("pendingSend", null); return; }
    const i = await core.info();
    if (!i.targets.length && pendingTries++ < 6) { setTimeout(async () => { await poll(); flushPendingSend(); }, 2500); return; }
    await KV.set("pendingSend", null);
    if (p.u) quickSend(p.u, p.t || ""); else sendTextNow(p.x);
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
    const i = await core.info();
    const qs = $("quickTarget");
    qs.textContent = "";
    const addOpt = (v, t) => { const o = el("option", "", t); o.value = v; qs.append(o); };
    addOpt("ask", i.targets.length > 1 ? "Спрашивать, куда отправить" : "Сразу на единственное устройство");
    if (i.targets.length > 1) {
      addOpt("all", "На все устройства");
      for (const d of i.targets) addOpt(d.id, `Только на «${d.name}»`);
    }
    const qv = await KV.get("quickTarget", "ask");
    qs.value = [...qs.options].some((o) => o.value === qv) ? qv : "ask";
    $("openInBlock").hidden = i.me.kind === "sender";
    setMsg($("settingsMsg"), "");
    setMsg($("memMsg"), "");
    renderMemory();
  });
  // ---------- память ----------
  const mb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1).replace(".0", "") + " МБ" : Math.max(0, Math.round(n / 1024)) + " КБ";
  async function renderMemory() {
    const st = await core.storageStats();
    let usage = 0;
    try { usage = (await navigator.storage.estimate()).usage || 0; } catch {}
    $("memStats").textContent = `Полученных файлов: ${st.files} (${mb(st.bytes)} из ${mb(st.maxBytes)}). ` +
      `Записей: ${st.history} получено, ${st.sent} отправлено.` + (usage ? ` Всего Tab Bridge занимает ${mb(usage)}.` : "");
    $("keepDays").value = String(st.keepDays);
  }
  $("keepDays").addEventListener("change", async () => {
    await core.setKeepDays(Number($("keepDays").value));
    setMsg($("memMsg"), "Сохранено ✓", "ok");
    renderMemory();
  });
  $("deleteFiles").addEventListener("click", async () => {
    if (!confirm("Удалить все полученные картинки и файлы с телефона? Записи в истории останутся. Картинки, сохранённые в «Фото», не пострадают.")) return;
    await core.deleteFiles();
    setMsg($("memMsg"), "Файлы удалены ✓", "ok");
    renderMemory();
  });
  $("clearAll").addEventListener("click", async () => {
    if (!confirm("Очистить всю историю и удалить полученные файлы с телефона?")) return;
    await core.clearHistory();
    setMsg($("memMsg"), "История и файлы удалены ✓", "ok");
    renderMemory();
  });

  $("quickTarget").addEventListener("change", async () => {
    await KV.set("quickTarget", $("quickTarget").value);
    setMsg($("settingsMsg"), "Сохранено ✓", "ok");
  });
  $("openQuick").addEventListener("click", () => showQuick());
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

  // ---------- мастер «Быстрая отправка» ----------
  const PHONE_CFG = window.TB_PHONE || {};
  const shortcutUrl = /^https:\/\/www\.icloud\.com\/shortcuts\/[A-Za-z0-9]+/.test(PHONE_CFG.shortcutUrl || "") ? PHONE_CFG.shortcutUrl : "";
  let safariLink = "";
  let safariTimer = null;

  // Подключён ли уже Safari этого телефона (виден в группе как «только отправка»)
  async function safariReady() {
    const i = await core.info();
    if (isIOS && !isStandalone && i.paired) return true;          // мы и есть Safari
    return i.devices.some((d) => d.kind === "sender");
  }

  async function showQuick() {
    show("quick");
    window.scrollTo(0, 0);
    setMsg($("quickMsg"), "");
    $("bookmarkletCode").value = TB.quick.bookmarklet();
    $("qBookmark").hidden = !isIOS;
    $("shortcutOneTap").hidden = !shortcutUrl;
    $("shortcutManual").hidden = Boolean(shortcutUrl);
    if (!isIOS) {
      for (const n of [1, 2, 3]) $("wiz" + n).hidden = true;
      $("wizAndroid").hidden = false;
      $("wizProgress").textContent = "";
      return;
    }
    $("wizAndroid").hidden = true;
    // ссылка для Safari готовится заранее: переход должен случиться сразу по нажатию
    safariLink = "";
    if (await paired()) {
      const secret = C.normalizeSecret(await KV.get("secret", ""));
      const srv = await TB.server();
      safariLink = "x-safari-" + TB.quick.sendPage().replace(/send\.html$/, "") +
        "#k=" + secret + (srv !== TB.DEFAULT_SERVER ? "&s=" + encodeURIComponent(srv) : "") + "&sender=1";
    }
    goStep((await safariReady()) ? 2 : 1);
  }

  function goStep(n) {
    for (const k of [1, 2, 3]) $("wiz" + k).hidden = k !== n;
    $("wizProgress").textContent = `Шаг ${n} из 3`;
    clearInterval(safariTimer);
    safariTimer = null;
    if (n === 1) {
      setStatus("safariStatus", "", "");
      $("wiz1Next").disabled = true;
      // ждём, пока Safari подключится (проверяем каждые 3 секунды и при возврате в приложение)
      safariTimer = setInterval(checkSafari, 3000);
    }
    window.scrollTo(0, 0);
  }

  function setStatus(id, text, cls) { $(id).textContent = text; $(id).className = "wiz-status " + (cls || ""); }

  let checking = false;
  async function checkSafari() {
    if (checking || $("wiz1").hidden) return;
    checking = true;
    try {
      try { await core.poll(); } catch {}
      if (await safariReady()) {
        clearInterval(safariTimer); safariTimer = null;
        setStatus("safariStatus", "✓ Safari подключён", "ok");
        $("wiz1Next").disabled = false;
        setTimeout(() => { if (!$("wiz1").hidden) goStep(2); }, 1200);
      }
    } finally { checking = false; }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("quick").hidden) checkSafari(); });

  $("linkSafari").addEventListener("click", () => {
    if (!safariLink) return setStatus("safariStatus", "Сначала подключите это приложение по QR-коду.", "");
    setStatus("safariStatus", "Жду, когда Safari подключится…", "wait");
    location.href = safariLink;
  });
  $("wiz1Next").addEventListener("click", () => goStep(2));

  $("addShortcut").addEventListener("click", () => { if (shortcutUrl) location.href = shortcutUrl; });
  $("openShortcuts").addEventListener("click", () => { location.href = "shortcuts://create-shortcut"; });
  async function copy(text, statusId, okText) {
    try { await navigator.clipboard.writeText(text); setStatus(statusId, okText, "ok"); }
    catch { setStatus(statusId, "Не удалось скопировать. Нажмите ещё раз.", ""); }
  }
  $("copyShortcut").addEventListener("click", () => copy(TB.quick.shortcutPrefix(false), "copyStatus", "✓ Скопировано"));
  $("copyShortcut16").addEventListener("click", () => copy(TB.quick.shortcutPrefix(true), "copyStatus", "✓ Скопирован адрес для iOS 16"));
  $("wiz2Next").addEventListener("click", () => goStep(3));
  $("wizDone").addEventListener("click", async () => {
    await KV.set("quickBannerHidden", true);
    closeQuick();
  });
  $("wizAndroidDone").addEventListener("click", () => closeQuick());
  $("copyBookmarklet").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(TB.quick.bookmarklet()); setMsg($("quickMsg"), "✓ Код кнопки скопирован", "ok"); }
    catch { setMsg($("quickMsg"), "Не удалось скопировать — скопируйте код из поля вручную.", "err"); }
  });

  async function closeQuick() {
    clearInterval(safariTimer); safariTimer = null;
    if (lastScreen === "settings") $("openSettings").click();
    else if (lastScreen === "install") showInstall();
    else if (await paired()) showApp();
    else showSetup();
  }
  $("closeQuick").addEventListener("click", closeQuick);
  $("quickBannerGo").addEventListener("click", () => showQuick());
  $("quickBannerHide").addEventListener("click", () => { $("quickBanner").hidden = true; KV.set("quickBannerHidden", true); });

  // ---------- обновление, пока открыто ----------
  async function onResult(r) {
    if (!r) return;
    if (r.removedMe) {
      await TB.wipe(await swReady, false);
      return showSetup("Этот телефон удалили из списка на другом устройстве. Чтобы подключить снова — отсканируйте QR-код.");
    }
    if (r.clockSkew) setMsg($("state"), "Часы телефона или компьютера расходятся больше чем на 10 минут — проверьте дату и время.", "err small");
    if (r.fresh.length && navigator.vibrate && navigator.userActivation?.hasBeenActive) try { navigator.vibrate(60); } catch {}
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
  if (incoming.secret && isIOS && !isStandalone) {
    // Safari на iPhone открыли по QR-коду или кнопкой из приложения
    if (await pairSafariSender(incoming.secret, incoming.server)) {
      incoming.secret = ""; incoming.server = "";
      await showInstall();
      setTimeout(async () => { try { await core.poll(); } catch {} flushPendingSend(); }, 2500);
    } else await showSetup();
  } else if (await paired() && !incoming.secret) {
    await showApp();
    if (openId) { const id = openId; openId = ""; openById(id); }
    if (wantClip) { $("clipSend").classList.add("pulse"); $("clipSend").focus(); }
    refreshPush();
    maybeSendShared();
  } else {
    await showSetup();
  }
})();
