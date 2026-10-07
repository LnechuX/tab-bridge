// Tab Bridge — быстрая отправка в одно касание.
// Сюда ведут закладка «📤 На ПК» в Safari и Быстрая команда «На ПК» из меню «Поделиться».
// Ссылка приходит во фрагменте адреса (#u=...) — он не уходит в сеть. Шифруется прямо здесь.
(async function () {
  "use strict";

  if (window.top !== window.self) { document.documentElement.textContent = ""; return; }

  const C = window.TBCrypto;
  const core = TB.core;
  const $ = (id) => document.getElementById(id);

  // Новая ссылка в уже открытую страницу (меняется только часть после #) — начинаем заново
  window.addEventListener("hashchange", () => { if (location.hash.length > 1) location.reload(); });

  const req = TB.quick.parse(location.hash);
  // Убираем ссылку из адресной строки (возврат «назад» на исходную страницу это не ломает)
  if (location.hash) history.replaceState(null, "", location.pathname);
  const cameFromPage = req.back && history.length > 1;

  const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : "🔹");
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function view(state, title, sub) {
    $("box").className = "send-box " + state;
    $("icon").textContent = { busy: "⏳", ok: "✓", err: "!", ask: "📤", info: "🔒" }[state] || "";
    $("title").textContent = title;
    $("sub").textContent = sub || "";
    $("targets").textContent = "";
    $("actions").textContent = "";
    $("rememberRow").hidden = true;
  }
  function action(label, fn, primary) {
    const b = el("button", primary ? "primary" : "", label);
    b.addEventListener("click", fn);
    $("actions").append(b);
    return b;
  }
  function copyButton() {
    action("Скопировать ссылку", async (e) => {
      try { await navigator.clipboard.writeText(req.url || req.text); e.target.textContent = "✓ Скопировано"; }
      catch { e.target.textContent = "Не удалось скопировать"; }
    });
  }
  function goBack() {
    if (cameFromPage) history.back();
  }

  if (req.url) $("link").textContent = (req.title ? req.title + " · " : "") + host(req.url);
  else if (req.text) $("link").textContent = "✏️ " + req.text.replace(/\s+/g, " ").slice(0, 80);

  // ---------- нет ссылки ----------
  if (!req.url && !req.text) {
    view("info", "Это страница быстрой отправки",
      "Сюда открывается кнопка «📤 На ПК» и Быстрая команда. Сама по себе она ничего не делает.");
    action("Открыть Tab Bridge", () => { location.href = "./"; }, true);
    return;
  }

  // ---------- браузер ещё не подключён ----------
  const paired = Boolean(await KV.get("secret", "")) && Boolean(await KV.get("deviceId", ""));
  if (!paired) {
    // запомним ссылку — она уйдёт сама сразу после подключения
    await KV.set("pendingSend", { u: req.url, x: req.text, t: req.title, ts: Date.now() });
    view("info", "Этот браузер ещё не подключён",
      TB.IS_IOS
        ? "Наведите камеру iPhone на QR-код в настройках Tab Bridge на компьютере и откройте ссылку в Safari — " +
          "Safari подключится сам, а эта ссылка отправится автоматически."
        : "Откройте Tab Bridge и подключите его по QR-коду с компьютера — ссылка отправится автоматически.");
    action("Открыть Tab Bridge", () => { location.href = "./"; }, true);
    copyButton();
    return;
  }

  // ---------- отправка ----------
  let busy = false;
  async function send(ids) {
    if (busy) return;
    busy = true;
    view("busy", "Отправляю…");
    try {
      const e = req.url ? await core.sendLink(req.url, req.title, ids) : await core.sendText(req.text, ids);
      if ($("remember").checked) await KV.set("quickTarget", ids.length ? ids[0] : "all");
      const names = e.to.filter((t) => t.s !== "failed").map((t) => `«${t.name}»`).join(", ");
      view("ok", "Отправлено", "на " + names);
      if (navigator.vibrate && navigator.userActivation?.hasBeenActive) try { navigator.vibrate(40); } catch {}
      core.poll().catch(() => {});   // заодно обновим список устройств на будущее
      if (cameFromPage) setTimeout(goBack, 900);
      else {
        $("sub").textContent += ". Вернуться можно кнопкой «◀» в левом верхнем углу.";
        setTimeout(() => { try { window.close(); } catch {} }, 1200);
      }
    } catch (err) {
      view("err", "Не отправлено", String(err?.message || err));
      action("Повторить", () => start(), true);
      copyButton();
      if (cameFromPage) action("Назад", goBack);
    } finally {
      busy = false;
    }
  }

  async function start() {
    let info = await core.info();
    if (!info.targets.length) {
      view("busy", "Ищу ваш компьютер…");
      try { const r = await core.poll(); if (r.removedMe) { await TB.wipe(null, false); location.reload(); return; } } catch {}
      info = await core.info();
    }
    const targets = info.targets;
    if (!targets.length) {
      view("err", "Компьютер не найден",
        "Откройте на компьютере браузер с Tab Bridge и нажмите «Повторить».");
      action("Повторить", () => start(), true);
      copyButton();
      return;
    }
    if (targets.length === 1) return send([targets[0].id]);

    const qt = await KV.get("quickTarget", "ask");
    if (qt === "all") return send([]);
    if (targets.some((d) => d.id === qt)) return send([qt]);

    // несколько устройств — спрашиваем куда
    view("ask", "Куда отправить?");
    for (const d of targets) {
      const b = el("button", "");
      b.append(el("span", "ic", icon(d.kind)), el("span", "nm", d.name));
      b.addEventListener("click", () => send([d.id]));
      $("targets").append(b);
    }
    const all = el("button", "primary all", `На все устройства (${targets.length})`);
    all.addEventListener("click", () => send([]));
    $("targets").append(all);
    $("rememberRow").hidden = false;
    if (cameFromPage) action("Отмена", goBack);
  }

  start();
})();
