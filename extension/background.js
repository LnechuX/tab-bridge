// Tab Bridge v2 — фоновый скрипт.
// Chrome/Edge/Яндекс: service worker (MV3). Firefox (ПК и Android): event page.
// Все ссылки шифруются на устройстве (см. tb-crypto.js). Сервер ntfy видит
// только шифротекст и случайное имя темы.

if (typeof importScripts === "function" && !globalThis.TBCrypto) importScripts("config.js", "tb-crypto.js");

const api = globalThis.browser ?? globalThis.chrome;
const C = globalThis.TBCrypto;

const ALARM = "tb-poll";
const MAX_SEEN = 400;
const MAX_HISTORY = 30;
const FETCH_OPTS = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };

const DEFAULTS = {
  server: (globalThis.TB_CONFIG && globalThis.TB_CONFIG.server) || "https://ntfy.sh",
  secret: "",
  deviceId: "",
  deviceName: "",
  autoOpen: false,    // безопаснее: пришедшие вкладки не открываются сами
  focusOpened: false,
  notify: true,
  phoneUrl: "",       // адрес страницы для телефона (для QR-кода)
  since: "",
  startTs: 0,
  seen: [],           // id сообщений ntfy
  nonces: [],         // защита от повторной отправки перехваченного сообщения
  history: [],
  lastPoll: 0,
  lastError: ""
};

const nowSec = () => Math.floor(Date.now() / 1000);

function randId(n) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => abc[b & 31]).join("");
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad/i.test(ua) ? "iPhone"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac OS/i.test(ua) ? "Mac"
    : /Linux|CrOS/i.test(ua) ? "Linux" : "Устройство";
  const br = /YaBrowser/i.test(ua) ? "Яндекс"
    : /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox/i.test(ua) ? "Firefox"
    : /Chrome/i.test(ua) ? "Chrome" : "Браузер";
  return `${br} · ${os}`;
}

const base = (s) => String(s.server || DEFAULTS.server).trim().replace(/\/+$/, "");

let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// ---------- настройки ----------

let initPromise = null;
function init() {
  initPromise ??= (async () => {
    const s = { ...DEFAULTS, ...(await api.storage.local.get(Object.keys(DEFAULTS))) };
    const patch = {};
    if (!s.deviceId) patch.deviceId = randId(12);
    if (!s.deviceName) patch.deviceName = guessDeviceName();
    if (!s.secret || C.checkSecret(s.secret)) {
      // первый запуск или переход с версии 1 (без шифрования): начинаем с чистого листа
      const now = nowSec();
      Object.assign(patch, { secret: C.generateSecret(), startTs: now, since: String(now), seen: [], nonces: [], history: [] });
      try { await api.storage.local.remove(["topic"]); } catch {}
    }
    if (!s.startTs && !patch.startTs) patch.startTs = nowSec();
    if (!s.since && !patch.since) patch.since = String(patch.startTs || s.startTs);
    if (Object.keys(patch).length) await api.storage.local.set(patch);
  })();
  return initPromise;
}

async function getSettings() {
  await init();
  return { ...DEFAULTS, ...(await api.storage.local.get(Object.keys(DEFAULTS))) };
}

// ---------- отправка ----------

async function sendLink(url, title) {
  if (!C.isSafeUrl(url)) throw new Error("Эту страницу передать нельзя — поддерживаются только http/https-ссылки.");
  const s = await getSettings();
  const group = await C.deriveGroup(s.secret);
  const message = await C.sealLink(group, { url, title, from: s.deviceName, device: s.deviceId });
  const r = await fetch(base(s), {
    ...FETCH_OPTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: group.topic, message })
  });
  if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
  return { sent: true };
}

// Право activeTab даёт адрес только активной вкладки и только после вашего действия
// (клик по кнопке, горячая клавиша, пункт меню). Доступа ко всем вкладкам нет.
async function getActiveTab() {
  const ok = (t) => C.isSafeUrl(t?.url || "");
  let tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  let t = tabs.find(ok);
  if (!t) {
    tabs = await api.tabs.query({ active: true });
    t = tabs.find(ok);
  }
  return t;
}

async function sendActiveTab(tab) {
  const t = tab && C.isSafeUrl(tab.url || "") ? tab : await getActiveTab();
  if (!t) throw new Error("Не нашёл открытую веб-страницу для отправки.");
  await sendLink(t.url, t.title);
  return { sent: true, title: t.title || t.url };
}

function flashBadge(ok) {
  try {
    api.action.setBadgeBackgroundColor?.({ color: ok ? "#16a34a" : "#dc2626" });
    api.action.setBadgeText({ text: ok ? "✓" : "!" });
    setTimeout(() => { try { api.action.setBadgeText({ text: "" }); } catch {} }, 2500);
  } catch {}
}

// ---------- получение ----------

async function openTab(url, active) {
  if (!C.isSafeUrl(url)) return null;
  const t = await api.tabs.create({ url, active });
  if (active && api.windows && t?.windowId != null) {
    try { await api.windows.update(t.windowId, { focused: true }); } catch {}
  }
  return t;
}

// Вызывать только внутри serial()
async function processMessages(msgs) {
  const s = await getSettings();
  const group = await C.deriveGroup(s.secret);
  const seen = new Set(s.seen);
  const nonces = new Set(s.nonces);
  const fresh = [];

  for (const m of msgs) {
    if (!m || m.event !== "message" || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    if (typeof m.time !== "number" || m.time < s.startTs) continue;
    const link = await C.openLink(group, m.message);
    if (!link) continue;                                        // не расшифровалось — чужое или подделка
    if (nonces.has(link.nonce)) continue;                       // повтор старого сообщения
    nonces.add(link.nonce);
    if (Math.abs(link.ts - m.time) > C.MAX_CLOCK_SKEW) continue; // устаревшее/переотправленное
    if (link.device === s.deviceId) continue;                   // это мы сами отправили
    fresh.push({ id: m.id, url: link.url, title: link.title, from: link.from, time: m.time, tabId: null });
  }

  for (const h of fresh) {
    if (s.autoOpen) {
      try { h.tabId = (await openTab(h.url, !!s.focusOpened))?.id ?? null; } catch {}
    }
    if (s.notify && api.notifications) {
      try {
        await api.notifications.create("tb:" + h.id, {
          type: "basic",
          iconUrl: api.runtime.getURL("icons/icon128.png"),
          title: (h.from ? `Вкладка с «${h.from}»` : "Новая вкладка") + (s.autoOpen ? "" : " — нажмите, чтобы открыть"),
          message: h.title
        });
      } catch {}
    }
  }

  await api.storage.local.set({
    seen: [...seen].slice(-MAX_SEEN),
    nonces: [...nonces].slice(-MAX_SEEN),
    history: [...fresh.reverse(), ...s.history].slice(0, MAX_HISTORY)
  });
  return fresh.length;
}

async function poll() {
  return serial(async () => {
    try {
      const s = await getSettings();
      const group = await C.deriveGroup(s.secret);
      const url = `${base(s)}/${group.topic}/json?poll=1&since=${encodeURIComponent(s.since)}`;
      const r = await fetch(url, FETCH_OPTS);
      if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
      const msgs = (await r.text())
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const received = await processMessages(msgs);
      const last = msgs.filter((m) => m.event === "message" && m.id).at(-1);
      await api.storage.local.set({ ...(last ? { since: last.id } : {}), lastPoll: Date.now(), lastError: "" });
      return { received };
    } catch (e) {
      const text = e instanceof TypeError ? "нет соединения с сервером (проверьте интернет)" : String(e?.message || e);
      await api.storage.local.set({ lastError: text, lastPoll: Date.now() });
      throw e;
    }
  });
}

let ws = null;
let wsKey = "";
async function connectLive() {
  const s = await getSettings();
  const group = await C.deriveGroup(s.secret);
  const key = base(s) + "|" + group.topic;
  if (ws && wsKey === key && ws.readyState <= 1) return;
  try { ws?.close(); } catch {}
  ws = null;
  try {
    const sock = new WebSocket(`${base(s).replace(/^http/i, "ws")}/${group.topic}/ws`);
    ws = sock;
    wsKey = key;
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === "message") serial(() => processMessages([m])).catch(() => {});
    };
    sock.onclose = sock.onerror = () => { if (ws === sock) ws = null; };
  } catch {
    ws = null;
  }
}

async function ensureAlarm() {
  const a = await api.alarms.get(ALARM);
  if (!a) await api.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

async function wake() {
  try { await ensureAlarm(); } catch {}
  connectLive().catch(() => {});
  poll().catch(() => {});
}

// ---------- меню, горячая клавиша, уведомления ----------

async function setupMenus() {
  if (!api.contextMenus) return; // нет на Firefox для Android
  try {
    await api.contextMenus.removeAll();
    api.contextMenus.create({ id: "tb-page", title: "Отправить вкладку на свои устройства", contexts: ["page"] });
    api.contextMenus.create({ id: "tb-link", title: "Отправить ссылку на свои устройства", contexts: ["link"] });
  } catch {}
}

api.contextMenus?.onClicked.addListener((info, tab) => {
  const job = info.menuItemId === "tb-link"
    ? sendLink(info.linkUrl, info.linkText || info.selectionText || info.linkUrl)
    : info.menuItemId === "tb-page"
      ? sendActiveTab(tab)
      : null;
  job?.then(() => flashBadge(true), () => flashBadge(false));
});

api.commands?.onCommand.addListener((cmd, tab) => {
  if (cmd === "send-current-tab") sendActiveTab(tab).then(() => flashBadge(true), () => flashBadge(false));
});

api.notifications?.onClicked.addListener(async (nid) => {
  if (!nid.startsWith("tb:")) return;
  try { api.notifications.clear(nid); } catch {}
  const { history = [] } = await api.storage.local.get("history");
  const h = history.find((x) => "tb:" + x.id === nid);
  if (!h) return;
  if (h.tabId != null) {
    try {
      const t = await api.tabs.update(h.tabId, { active: true });
      if (api.windows && t?.windowId != null) await api.windows.update(t.windowId, { focused: true });
      return;
    } catch {}
  }
  openTab(h.url, true).catch(() => {});
});

// ---------- связь с popup и настройками ----------

async function handle(msg, sender) {
  // принимаем команды только от страниц самого расширения
  if (sender?.id && sender.id !== api.runtime.id) return {};
  switch (msg?.type) {
    case "send-active": return sendActiveTab();
    case "check": await connectLive(); return poll();
    case "clear-history":
      await serial(() => api.storage.local.set({ history: [] }));
      return {};
    case "settings-changed":
      initPromise = null;
      try { ws?.close(); } catch {}
      ws = null;
      await wake();
      return {};
    default: return {};
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (r) => sendResponse({ ok: true, ...(r || {}) }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) })
  );
  return true;
});

api.runtime.onInstalled.addListener((details) => {
  setupMenus();
  wake();
  if (details?.reason === "install") {
    // сразу показываем, как подключить телефон
    api.tabs.create({ url: api.runtime.getURL("options.html#welcome") }).catch(() => {});
  }
});
api.runtime.onStartup.addListener(() => { setupMenus(); wake(); });
api.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) wake(); });

wake();
