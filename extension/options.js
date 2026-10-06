const api = globalThis.browser ?? globalThis.chrome;
const C = globalThis.TBCrypto;
const CFG = globalThis.TB_CONFIG || {};
const $ = (id) => document.getElementById(id);
const KEYS = ["deviceName", "secret", "server", "phoneUrl", "autoOpen", "focusOpened", "notify"];
const NTFY = "https://ntfy.sh"; // сервер по умолчанию на странице для телефона

const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
const DEFAULT_SERVER = cleanUrl(CFG.server) || NTFY;
const DEFAULT_PHONE = cleanUrl(CFG.phoneUrl);

function say(el, text, cls = "muted") {
  el.textContent = text;
  el.className = cls;
}

async function load() {
  // при первом запуске фон может ещё создавать ключ — подождём
  for (let i = 0; i < 30; i++) {
    const s = await api.storage.local.get(KEYS);
    if (s.secret || i === 29) {
      $("deviceName").value = s.deviceName || "";
      $("secret").value = C.formatSecret(s.secret || "");
      $("server").value = s.server || DEFAULT_SERVER;
      $("phoneUrl").value = s.phoneUrl || "";
      $("phoneUrl").placeholder = DEFAULT_PHONE || "https://ваш-логин.github.io/tab-bridge/";
      $("autoOpen").checked = s.autoOpen ?? false;
      $("focusOpened").checked = s.focusOpened ?? false;
      $("notify").checked = s.notify ?? true;
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------- основные настройки: сохраняются сразу ----------
let nameTimer = null;
function saveBasic(patch) {
  api.storage.local.set(patch).then(() => say($("basicMsg"), "Сохранено ✓", "ok"));
}
$("deviceName").addEventListener("input", () => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => saveBasic({ deviceName: $("deviceName").value.trim().slice(0, 40) || "Без названия" }), 500);
});
for (const id of ["autoOpen", "focusOpened", "notify"]) {
  $(id).addEventListener("change", () => saveBasic({ [id]: $(id).checked }));
}
$("clearHistory").addEventListener("click", async () => {
  try { await api.runtime.sendMessage({ type: "clear-history" }); } catch {}
  say($("basicMsg"), "История очищена ✓", "ok");
});

// ---------- QR-код для телефона ----------
function hideQr() {
  $("qrBox").hidden = true;
  $("qr").textContent = "";
  $("qrBtn").textContent = "Показать QR-код";
}

async function renderQr() {
  const s = await api.storage.local.get(["secret", "server", "phoneUrl"]);
  const page = cleanUrl(s.phoneUrl) || DEFAULT_PHONE;
  if (!/^https:\/\//i.test(page)) {
    $("noPhone").hidden = false;
    $("advanced").open = true;
    return false;
  }
  $("noPhone").hidden = true;
  const server = cleanUrl(s.server) || DEFAULT_SERVER;
  // ключ кладём во фрагмент (#...) — браузер не отправляет его на сервер, где лежит страница
  const text = `${page}/#k=${C.normalizeSecret(s.secret)}` + (server !== NTFY ? `&s=${encodeURIComponent(server)}` : "");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return true;
}

$("qrBtn").addEventListener("click", async () => {
  if (!$("qrBox").hidden) return hideQr();
  if (await renderQr()) {
    $("qrBox").hidden = false;
    $("qrBtn").textContent = "Скрыть QR-код";
  }
});

// ---------- дополнительно ----------
$("show").addEventListener("click", () => {
  const hidden = $("secret").type === "password";
  $("secret").type = hidden ? "text" : "password";
  $("show").textContent = hidden ? "Скрыть" : "Показать";
});

$("gen").addEventListener("click", () => {
  if (!confirm("Создать новый ключ? Телефон и другие компьютеры придётся подключить заново.")) return;
  $("secret").value = C.formatSecret(C.generateSecret());
  hideQr();
  say($("msg"), "Новый ключ создан. Нажмите «Сохранить».");
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(C.formatSecret($("secret").value));
    say($("msg"), "Скопировано. Очистите буфер обмена после вставки.", "ok");
  } catch {
    $("secret").type = "text";
    $("secret").select();
    say($("msg"), "Выделил ключ — скопируйте вручную.");
  }
});

$("save").addEventListener("click", async () => {
  const secret = C.normalizeSecret($("secret").value);
  const server = cleanUrl($("server").value) || DEFAULT_SERVER;
  const phoneUrl = cleanUrl($("phoneUrl").value);

  const bad = C.checkSecret(secret);
  if (bad) return say($("msg"), bad, "err");
  if (!/^https:\/\/[^/\s]+/i.test(server)) return say($("msg"), "Сервер должен быть на https://", "err");
  if (phoneUrl && !/^https:\/\/[^/\s]+/i.test(phoneUrl)) return say($("msg"), "Адрес страницы должен начинаться с https://", "err");

  if (server !== NTFY && api.permissions?.request) {
    try {
      const granted = await api.permissions.request({ origins: [new URL(server).origin + "/*"] });
      if (!granted) return say($("msg"), "Без разрешения расширение не сможет связаться с этим сервером.", "err");
    } catch {}
  }

  const old = await api.storage.local.get(["secret", "server"]);
  const patch = { secret, server, phoneUrl };
  if (C.normalizeSecret(old.secret) !== secret || (cleanUrl(old.server) || DEFAULT_SERVER) !== server) {
    const now = Math.floor(Date.now() / 1000);
    Object.assign(patch, { since: String(now), startTs: now, seen: [], nonces: [], history: [] });
  }
  await api.storage.local.set(patch);
  try { await api.runtime.sendMessage({ type: "settings-changed" }); } catch {}
  $("secret").value = C.formatSecret(secret);
  if (!$("qrBox").hidden) await renderQr();
  say($("msg"), "Сохранено ✓", "ok");
});

// ---------- запуск ----------
if (location.hash === "#welcome") {
  $("welcome").hidden = false;
  history.replaceState(null, "", location.pathname);
}
load().then(async () => {
  const s = await api.storage.local.get("phoneUrl");
  $("noPhone").hidden = Boolean(cleanUrl(s.phoneUrl) || DEFAULT_PHONE);
});
