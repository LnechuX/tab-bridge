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

function setStatus(text, cls = "") { $("status").textContent = text; $("status").className = cls; }

const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : k === "sender" ? "📤" : "🔹");
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

  if (!info.targets.length) {
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
  if (info.targets.length === 1) {
    const d = info.targets[0];
    box.append(mk(`Отправить на «${d.name}»`, icon(d.kind), [d.id], true));
  } else {
    for (const d of info.targets) box.append(mk(d.name, icon(d.kind), [d.id], false));
    const all = el("button", "primary all", `Отправить на все устройства (${info.targets.length})`);
    all.addEventListener("click", () => send([], all));
    box.append(all);
  }
}

async function send(ids, btn) {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  setStatus("Шифрую и отправляю…", "muted");
  const r = await call({ type: "send", to: ids });
  btn.disabled = false;
  busy = false;
  if (r.ok) {
    setStatus("✓ Отправлено на " + r.entry.to.map((x) => `«${x.name}»`).join(", "), "ok");
    view = "sent";
    await refresh();
  } else setStatus(r.error || "Не получилось отправить", "err");
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
      const ki = it.kind === "text" ? "✏️ " : it.kind === "file" ? (/^image\//.test(it.mime || "") ? "🖼 " : "📎 ") : "";
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
          const r = await call({ type: "resend", id: it.i });
          setStatus(r.ok ? "✓ Отправлено повторно" : (r.error || "Не получилось"), r.ok ? "ok" : "err");
          refresh();
        });
        li.append(b);
      }
    } else {
      const a = el("a");
      const kindIcon = it.kind === "text" ? "✏️ " : it.kind === "file" ? (/^image\//.test(it.file?.mime || "") ? "🖼 " : "📎 ") : "";
      a.href = it.url || "#";
      a.title = it.url || it.title || "";
      const state = it.status === "error" ? "не скачан" : it.status === "loading" ? "скачивается…" : it.status === "gone" ? "файл удалён" : it.opened ? "открыто" : "";
      a.append(el("span", "t", kindIcon + (it.title || it.url)),
        el("span", "m", [it.from ? `от «${it.from}»` : "", ago(it.time), state].filter(Boolean).join(" · ")));
      a.addEventListener("click", (e) => { e.preventDefault(); call({ type: "open-received", id: it.id }); });
      li.append(a);
    }
    list.append(li);
  }
}

async function refresh() {
  const r = await call({ type: "info" });
  if (!r.ok) return setStatus(r.error || "Ошибка", "err");
  info = r;
  $("me").textContent = info.me.name || "";
  if (!FULL) { renderTargets(); renderCompose(); }
  renderList();
  if (info.lastError) { $("last").className = "err"; $("last").textContent = "Связь: " + info.lastError; }
  else $("last").textContent = "";
  $("warn").hidden = !info.lastWarning;
  $("warnText").textContent = info.lastWarning || "";
  $("hint").hidden = FULL || info.clickMode === "instant" || !info.targets.length;
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
// ---------- текст или картинка на телефон ----------
let attached = null;                         // { blob, name }
function renderCompose() {
  if (!info) return;
  const t = info.targets;
  $("composeTo").hidden = t.length < 2;
  if (t.length >= 2 && !$("composeTo").options.length) {
    for (const d of t) { const o = el("option", "", d.name); o.value = d.id; $("composeTo").append(o); }
    const all = el("option", "", "Все устройства"); all.value = ""; $("composeTo").append(all);
  }
  $("composeSend").textContent = t.length === 1 ? `Отправить на «${t[0].name}»` : "Отправить";
  $("composeSend").disabled = !t.length || (!attached && !$("composeText").value.trim());
  $("attachInfo").hidden = !attached;
  $("fullRow").hidden = !attached || !/^image\//.test(attached.blob.type || "");
  if (attached) $("attachName").textContent = `${attached.name} (${mb(attached.blob.size)})`;
}
function attach(blob, name) {
  if (blob.size > 14 * 1024 * 1024) return setStatus("Файл больше 14 МБ — такой не отправить.", "err");
  attached = { blob, name };
  renderCompose();
}
$("composeText").addEventListener("input", renderCompose);
$("composeText").addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) { e.preventDefault(); attach(f, f.name && f.name !== "image.png" ? f.name : `Скриншот ${new Date().toLocaleString()}.png`); }
});
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => { const f = $("fileInput").files[0]; if (f) attach(f, f.name); $("fileInput").value = ""; });
$("attachClear").addEventListener("click", () => { attached = null; renderCompose(); });
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ");
function toBase64(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
$("composeSend").addEventListener("click", async () => {
  const to = info.targets.length >= 2 && $("composeTo").value ? [$("composeTo").value] : [];
  $("composeSend").disabled = true;
  let file = attached, note = "";
  if (file && !$("fullQuality").checked && globalThis.TBShrink) {
    setStatus("Уменьшаю картинку…", "muted");
    const sh = await TBShrink.image(file.blob, file.name);       // большие скриншоты уходят в разы быстрее
    if (sh.changed) { file = { blob: sh.blob, name: sh.name }; note = ` (${mb(sh.before)} → ${mb(sh.after)})`; }
  }
  setStatus(file ? "Шифрую и отправляю файл" + note + "…" : "Шифрую и отправляю…", "muted");
  const r = file
    ? await call({ type: "send-file", data: toBase64(await file.blob.arrayBuffer()), mime: file.blob.type, name: file.name, to })
    : await call({ type: "send-text", text: $("composeText").value, to });
  if (r.ok) {
    setStatus("✓ Отправлено на " + r.entry.to.map((x) => `«${x.name}»`).join(", ") + note, "ok");
    attached = null; $("composeText").value = "";
    view = "sent"; await refresh();
  } else setStatus(r.error || "Не получилось отправить", "err");
  renderCompose();
});

refresh().then(async () => {
  if (info && info.history.some((h) => !h.opened && !h.read)) {
    view = "recv";
    renderList();
    call({ type: "mark-read" });
  }
  call({ type: "check" });
});
