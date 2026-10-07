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

const icon = (k) => (k === "phone" ? "📱" : k === "pc" ? "💻" : k === "sender" ? "📤" : "🔹");
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
    const m = document.createElement("div"); m.className = "muted";
    const ver = d.vr || d.version ? "версия " + (d.vr || d.version) : "";
    m.textContent = isMe ? ver : [d.kind === "sender" ? "только отправка (быстрая кнопка)" : "", ago(d.lastSeen), ver].filter(Boolean).join(" · ");
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
  $("noDevices").hidden = r.targets.length > 0;
  renderButtonSettings(r.targets);
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
// ---------- память ----------
const mb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1).replace(".0", "") + " МБ" : Math.max(0, Math.round(n / 1024)) + " КБ";
async function renderMemory() {
  const r = await call({ type: "storage-stats" });
  if (!r.ok) return;
  const st = r.stats;
  $("memStats").textContent =
    `Полученных файлов: ${st.files} (${mb(st.bytes)} из ${mb(st.maxBytes)}). Записей в истории: ${st.history} получено, ${st.sent} отправлено.` +
    (r.usage ? ` Всего расширение занимает ${mb(r.usage)}.` : "");
  $("keepDays").value = String(st.keepDays);
}
$("keepDays").addEventListener("change", async () => {
  await call({ type: "set-keep-days", days: Number($("keepDays").value) });
  say($("memMsg"), "Сохранено ✓", "ok");
  renderMemory();
});
$("deleteFiles").addEventListener("click", async () => {
  if (!confirm("Удалить все полученные картинки и файлы с этого компьютера? Записи в истории останутся.")) return;
  await call({ type: "delete-files" });
  say($("memMsg"), "Файлы удалены ✓", "ok");
  renderMemory();
});
$("clearAll").addEventListener("click", async () => {
  if (!confirm("Очистить всю историю (отправленное и полученное) и удалить полученные файлы с этого компьютера?")) return;
  await call({ type: "clear-history" });
  say($("memMsg"), "История и файлы удалены ✓", "ok");
  renderMemory();
});

// ---------- кнопка Tab Bridge ----------
async function renderButtonSettings(devices) {
  const s = await api.storage.local.get(["clickMode", "quickTarget"]);
  const mode = s.clickMode === "instant" ? "instant" : "popup";
  document.querySelectorAll('input[name="clickMode"]').forEach((r) => { r.checked = r.value === mode; });
  const sel = $("quickTarget");
  sel.textContent = "";
  const add = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.append(o); };
  add("last", "Туда же, куда в прошлый раз");
  add("all", "На все устройства");
  for (const d of devices) add(d.id, `Только на «${d.name}»`);
  const q = s.quickTarget || "last";
  sel.value = [...sel.options].some((o) => o.value === q) ? q : "last";
}
document.querySelectorAll('input[name="clickMode"]').forEach((r) => r.addEventListener("change", async () => {
  await api.storage.local.set({ clickMode: r.value });
  await call({ type: "click-mode" });
  say($("btnMsg"), r.value === "instant"
    ? "Сохранено ✓ Теперь клик по значку сразу отправляет вкладку."
    : "Сохранено ✓ Клик по значку открывает окно с кнопкой «Отправить».", "ok");
}));
$("quickTarget").addEventListener("change", async () => {
  await api.storage.local.set({ quickTarget: $("quickTarget").value });
  say($("btnMsg"), "Сохранено ✓", "ok");
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
  // SVG разбираем как XML-документ (без innerHTML): в нём только квадратики QR-кода
  const svg = new DOMParser().parseFromString(qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }), "image/svg+xml").documentElement;
  $("qr").replaceChildren(document.importNode(svg, true));
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
  if (!confirm("Подключить этот компьютер к группе с этим ключом? Текущий список устройств и история этого компьютера будут заменены.")) return;
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
} else if (location.hash === "#button") {
  setTimeout(() => $("button").scrollIntoView({ behavior: "smooth" }), 300);
}
load().then(renderDevices).then(renderMemory);
api.storage.onChanged.addListener((ch) => { if (ch.devices) renderDevices(); });

// ---------- документы и версия ----------
{
  const base = (cleanUrl(CFG.phoneUrl) || "https://lnechux.github.io/tab-bridge").replace(/\/?$/, "/");
  $("privacyLink").href = base + "privacy.html";
  $("termsLink").href = base + "terms.html";
  $("extVersion").textContent = api.runtime.getManifest().version;
}
