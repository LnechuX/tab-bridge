const api = globalThis.browser ?? globalThis.chrome;
const C = globalThis.TBCrypto;
const CFG = globalThis.TB_CONFIG || {};
const $ = (id) => document.getElementById(id);
const NTFY = "https://ntfy.sh"; // сервер по умолчанию на странице для телефона

const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
const DEFAULT_SERVER = cleanUrl(CFG.server) || NTFY;
const DEFAULT_PHONE = cleanUrl(CFG.phoneUrl);

function say(el, text, cls = "muted") { el.textContent = text; el.className = cls; }

async function call(msg) {
  try { return (await api.runtime.sendMessage(msg)) ?? { ok: false, error: "Нет ответа от фона" }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : "🔹");
function ago(sec) {
  if (!sec) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 120) return "был в сети только что";
  if (d < 3600) return `был в сети ${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `был в сети ${Math.floor(d / 3600)} ч назад`;
  return "был в сети " + new Date(sec * 1000).toLocaleDateString();
}

// ---------- устройства ----------
async function renderDevices() {
  const r = await call({ type: "info" });
  if (!r.ok) return;
  const box = $("devices");
  box.textContent = "";
  const row = (d, isMe) => {
    const div = document.createElement("div");
    div.className = "dev";
    const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = icon(d.kind);
    const g = document.createElement("div"); g.className = "grow";
    const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = d.name;
    if (isMe) { const y = document.createElement("span"); y.className = "you"; y.textContent = "этот компьютер"; nm.append(y); }
    const m = document.createElement("div"); m.className = "muted"; m.textContent = isMe ? "" : ago(d.lastSeen);
    g.append(nm, m);
    div.append(ic, g);
    if (!isMe) {
      const b = document.createElement("button");
      b.textContent = "Удалить";
      b.addEventListener("click", async () => {
        if (!confirm(`Удалить «${d.name}»? На это устройство больше нельзя будет отправлять, а оно само отключится, как только выйдет в сеть.\n\nЕсли устройство потеряно — лучше дополнительно «Сменить ключ».`)) return;
        b.disabled = true;
        const res = await call({ type: "remove-device", id: d.id });
        if (!res.ok) { b.disabled = false; alert(res.error); }
        renderDevices();
      });
      div.append(b);
    }
    box.append(div);
  };
  row({ ...r.me, kind: "pc" }, true);
  r.devices.forEach((d) => row(d, false));
  $("noDevices").hidden = r.devices.length > 0;
}

// ---------- этот компьютер ----------
async function load() {
  for (let i = 0; i < 30; i++) {
    const s = await api.storage.local.get(["deviceName", "secret", "server", "phoneUrl", "autoOpen", "focusOpened", "notify"]);
    if (s.secret || i === 29) {
      $("deviceName").value = s.deviceName || "";
      $("secret").value = C.formatSecret(s.secret || "");
      $("server").value = s.server || DEFAULT_SERVER;
      $("phoneUrl").value = s.phoneUrl || "";
      $("phoneUrl").placeholder = DEFAULT_PHONE || "https://ваш-логин.github.io/tab-bridge/";
      $("autoOpen").checked = s.autoOpen ?? false;
      $("focusOpened").checked = s.focusOpened ?? false;
      $("notify").checked = s.notify ?? true;
      $("noPhone").hidden = Boolean(cleanUrl(s.phoneUrl) || DEFAULT_PHONE);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

let nameTimer = null;
$("deviceName").addEventListener("input", () => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(async () => {
    await call({ type: "rename", name: $("deviceName").value });
    say($("basicMsg"), "Сохранено ✓ — новое имя увидят ваши устройства", "ok");
  }, 700);
});
for (const id of ["autoOpen", "focusOpened", "notify"]) {
  $(id).addEventListener("change", () => api.storage.local.set({ [id]: $(id).checked }).then(() => say($("basicMsg"), "Сохранено ✓", "ok")));
}
$("clearHistory").addEventListener("click", async () => {
  await call({ type: "clear-history" });
  say($("basicMsg"), "История очищена ✓", "ok");
});

// ---------- QR-код ----------
async function renderQr() {
  const s = await api.storage.local.get(["secret", "server", "phoneUrl"]);
  const page = cleanUrl(s.phoneUrl) || DEFAULT_PHONE;
  if (!/^https:\/\//i.test(page)) { $("noPhone").hidden = false; $("advanced").open = true; return false; }
  const server = cleanUrl(s.server) || DEFAULT_SERVER;
  // ключ — во фрагменте (#...): браузер не отправляет его на сервер, где лежит страница
  const text = `${page}/#k=${C.normalizeSecret(s.secret)}` + (server !== NTFY ? `&s=${encodeURIComponent(server)}` : "");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return true;
}

$("qrBtn").addEventListener("click", async () => {
  if (!$("qr").hidden) {
    $("qr").hidden = true; $("qrWarn").hidden = true; $("qr").textContent = "";
    $("qrBtn").textContent = "Показать QR-код";
    return;
  }
  if (await renderQr()) {
    $("qr").hidden = false; $("qrWarn").hidden = false;
    $("qrBtn").textContent = "Скрыть QR-код";
  }
});

// ---------- дополнительно ----------
$("show").addEventListener("click", () => {
  const hidden = $("secret").type === "password";
  $("secret").type = hidden ? "text" : "password";
  $("show").textContent = hidden ? "Скрыть" : "Показать";
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("secret").value);
    say($("msg"), "Скопировано. Очистите буфер обмена после вставки.", "ok");
  } catch {
    $("secret").type = "text"; $("secret").select();
    say($("msg"), "Выделил ключ — скопируйте вручную.");
  }
});

async function setKey(secret, okText) {
  const server = cleanUrl($("server").value) || DEFAULT_SERVER;
  const r = await call({ type: "set-key", secret, server });
  if (!r.ok) return say($("msg"), r.error, "err");
  await load();
  await renderDevices();
  if (!$("qr").hidden) await renderQr();
  say($("msg"), okText, "ok");
}

$("newKey").addEventListener("click", () => {
  if (!confirm("Сменить ключ? Все устройства будут отключены, их нужно будет подключить заново по QR-коду.")) return;
  setKey(C.generateSecret(), "Ключ сменён ✓ Подключите устройства заново.");
});

$("join").addEventListener("click", () => {
  const k = C.normalizeSecret($("joinKey").value);
  const bad = C.checkSecret(k);
  if (bad) return say($("msg"), bad, "err");
  if (!confirm("Подключить этот компьютер к группе с этим ключом? Текущий список устройств будет заменён.")) return;
  $("joinKey").value = "";
  setKey(k, "Подключено ✓ Устройства группы появятся в списке через несколько секунд.");
});

$("save").addEventListener("click", async () => {
  const server = cleanUrl($("server").value) || DEFAULT_SERVER;
  const phoneUrl = cleanUrl($("phoneUrl").value);
  if (!/^https:\/\/[^/\s]+/i.test(server)) return say($("msg"), "Сервер должен быть на https://", "err");
  if (phoneUrl && !/^https:\/\/[^/\s]+/i.test(phoneUrl)) return say($("msg"), "Адрес страницы должен начинаться с https://", "err");
  if (server !== NTFY && api.permissions?.request) {
    try {
      const granted = await api.permissions.request({ origins: [new URL(server).origin + "/*"] });
      if (!granted) return say($("msg"), "Без разрешения расширение не сможет связаться с этим сервером.", "err");
    } catch {}
  }
  const old = await api.storage.local.get(["server", "secret"]);
  await api.storage.local.set({ phoneUrl });
  if ((cleanUrl(old.server) || DEFAULT_SERVER) !== server) {
    await setKey(old.secret, "Сервер изменён ✓ Подключите устройства заново.");
  } else {
    await call({ type: "settings-changed" });
    say($("msg"), "Сохранено ✓", "ok");
  }
  $("noPhone").hidden = Boolean(phoneUrl || DEFAULT_PHONE);
  if (!$("qr").hidden) await renderQr();
});

// ---------- запуск ----------
if (location.hash === "#welcome") {
  $("welcome").hidden = false;
  history.replaceState(null, "", location.pathname);
}
load().then(renderDevices);
api.storage.onChanged.addListener((ch) => { if (ch.devices) renderDevices(); });
