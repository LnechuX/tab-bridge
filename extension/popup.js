const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FULL = new URLSearchParams(location.search).has("tab");
if (FULL) { document.body.classList.add("full"); $("sendBox").hidden = true; $("full").hidden = true; }

let info = null;
let view = "sent";
let busy = false;

async function call(msg) {
  try { return (await api.runtime.sendMessage(msg)) ?? { ok: false, error: "Нет ответа от фона" }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

function status(text, cls = "") { $("status").textContent = text; $("status").className = cls; }

const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : "🔹");
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function ago(sec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return "только что";
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return new Date(sec * 1000).toLocaleDateString();
}

const STATE = {
  failed: ["не отправлено", "err"], sent: ["отправлено", ""],
  delivered: ["доставлено ✓", "st-delivered"], opened: ["открыто ✓✓", "st-opened"]
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderTargets() {
  const box = $("targets");
  box.textContent = "";
  if (!info.tab) {
    $("page").hidden = true;
    box.append(el("div", "muted", "Откройте обычный сайт — его можно будет отправить на телефон."));
    return;
  }
  $("page").hidden = false;
  $("pageTitle").textContent = info.tab.title || info.tab.url;
  $("pageHost").textContent = host(info.tab.url);

  if (!info.devices.length) {
    const d = el("div", "empty-box");
    d.append(el("p", "muted", "Телефон ещё не подключён."));
    const b = el("button", "primary", "Подключить телефон");
    b.addEventListener("click", () => { api.runtime.openOptionsPage(); window.close(); });
    d.append(b);
    box.append(d);
    return;
  }

  const mk = (label, ic, ids, primary) => {
    const b = el("button", primary ? "primary" : "");
    b.append(el("span", "ic", ic), el("span", "nm", label));
    b.addEventListener("click", () => send(ids, b));
    return b;
  };
  if (info.devices.length === 1) {
    const d = info.devices[0];
    box.append(mk(`Отправить на «${d.name}»`, icon(d.kind), [d.id], true));
  } else {
    for (const d of info.devices) box.append(mk(d.name, icon(d.kind), [d.id], false));
    const all = el("button", "primary all", `Отправить на все устройства (${info.devices.length})`);
    all.addEventListener("click", () => send([], all));
    box.append(all);
  }
}

async function send(ids, btn) {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  status("Шифрую и отправляю…", "muted");
  const r = await call({ type: "send", to: ids });
  btn.disabled = false;
  busy = false;
  if (r.ok) {
    status("✓ Отправлено на " + r.entry.to.map((x) => `«${x.name}»`).join(", "), "ok");
    view = "sent";
    await refresh();
  } else status(r.error || "Не получилось отправить", "err");
}

function renderList() {
  $("tabSent").classList.toggle("on", view === "sent");
  $("tabRecv").classList.toggle("on", view === "recv");
  const list = $("list");
  list.textContent = "";
  const limit = FULL ? 50 : 5;
  const items = (view === "sent" ? info.sent : info.history).slice(0, limit);
  $("none").hidden = items.length > 0;
  $("none").textContent = view === "sent" ? "Вы ещё ничего не отправляли." : "Пока ничего не приходило.";
  for (const it of items) {
    const li = el("li");
    if (view === "sent") {
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
          const r = await call({ type: "resend", id: it.i });
          status(r.ok ? "✓ Отправлено повторно" : (r.error || "Не получилось"), r.ok ? "ok" : "err");
          refresh();
        });
        li.append(b);
      }
    } else {
      const a = el("a");
      a.href = it.url;
      a.title = it.url;
      a.append(el("span", "t", it.title || it.url),
        el("span", "m", [it.from ? `от «${it.from}»` : "", ago(it.time), it.opened ? "открыто" : ""].filter(Boolean).join(" · ")));
      a.addEventListener("click", (e) => { e.preventDefault(); call({ type: "open-received", id: it.id }); });
      li.append(a);
    }
    list.append(li);
  }
}

async function refresh() {
  const r = await call({ type: "info" });
  if (!r.ok) return status(r.error || "Ошибка", "err");
  info = r;
  $("me").textContent = info.me.name || "";
  if (!FULL) renderTargets();
  renderList();
  if (info.lastError) { $("last").className = "err"; $("last").textContent = "Связь: " + info.lastError; }
  else $("last").textContent = "";
  $("warn").hidden = !info.lastWarning;
  $("warnText").textContent = info.lastWarning || "";
  $("hint").hidden = FULL || info.clickMode === "instant" || !info.devices.length;
}

$("tabSent").addEventListener("click", () => { view = "sent"; renderList(); });
$("tabRecv").addEventListener("click", () => { view = "recv"; renderList(); call({ type: "mark-read" }); });
$("settings").addEventListener("click", () => { api.runtime.openOptionsPage(); if (!FULL) window.close(); });
$("full").addEventListener("click", () => { api.tabs.create({ url: api.runtime.getURL("popup.html?tab=1") }); window.close(); });

let t = null;
api.storage.onChanged.addListener((ch) => {
  if (!info) return;
  if (ch.sent || ch.history || ch.devices) { clearTimeout(t); t = setTimeout(refresh, 150); }
});

$("warnClose").addEventListener("click", async () => { await call({ type: "dismiss-warning" }); $("warn").hidden = true; });
$("hintLink").addEventListener("click", () => { api.tabs.create({ url: api.runtime.getURL("options.html#button") }); window.close(); });

// если есть непрочитанные — сразу показываем «Получено» и снимаем счётчик
refresh().then(async () => {
  if (info && info.history.some((h) => !h.opened && !h.read)) {
    view = "recv";
    renderList();
    call({ type: "mark-read" });
  }
  call({ type: "check" });
});
