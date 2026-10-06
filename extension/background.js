// Tab Bridge v3 — фоновый скрипт расширения.
// Chrome/Edge/Яндекс: service worker (MV3). Firefox (ПК и Android): event page.
// Логика устройств и сообщений — в tb-core.js (общая с телефоном), шифрование — в tb-crypto.js.

if (typeof importScripts === "function" && !globalThis.TBCore) importScripts("config.js", "tb-crypto.js", "tb-core.js");

const api = globalThis.browser ?? globalThis.chrome;
const C = globalThis.TBCrypto;
const CFG = globalThis.TB_CONFIG || {};
const DEFAULT_SERVER = String(CFG.server || "https://ntfy.sh").replace(/\/+$/, "");
const ALARM = "tb-poll";

const kv = {
  getAll: (keys) => api.storage.local.get(keys),
  setMany: (o) => api.storage.local.set(o)
};
const core = TBCore.create({ kv, kind: "pc", defaultServer: DEFAULT_SERVER });

function guessDeviceName() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac"
    : /Linux|CrOS/i.test(ua) ? "Linux" : "ПК";
  const br = /YaBrowser/i.test(ua) ? "Яндекс" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera"
    : /Firefox/i.test(ua) ? "Firefox" : /Chrome/i.test(ua) ? "Chrome" : "Браузер";
  return `${br} · ${os}`;
}

// ---------- первый запуск и переход со старых версий ----------
let initPromise = null;
function init() {
  initPromise ??= (async () => {
    const s = await api.storage.local.get(["secret", "deviceId", "deviceName", "server"]);
    if (!s.secret || C.checkSecret(s.secret)) {
      await core.pair(C.generateSecret(), DEFAULT_SERVER, s.deviceName || guessDeviceName());
    } else if (!s.deviceId) {
      // версия 2.x: ключ был, устройства — нет. Сохраняем ключ, телефон переподключать не нужно.
      await api.storage.local.set({ deviceId: TBCore.randId(12), deviceName: s.deviceName || guessDeviceName() });
    }
    await api.storage.local.remove(["topic", "since", "phoneTopic"]).catch(() => {});
  })();
  return initPromise;
}

// ---------- отправка ----------
async function getActiveTab() {
  const ok = (t) => C.isSafeUrl(t?.url || "");
  let tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  let t = tabs.find(ok);
  if (!t) { tabs = await api.tabs.query({ active: true }); t = tabs.find(ok); }
  return t;
}

async function sendActive(toIds, tab) {
  await init();
  const t = tab && C.isSafeUrl(tab.url || "") ? tab : await getActiveTab();
  if (!t) throw new Error("Эту страницу отправить нельзя — откройте обычный сайт (http/https).");
  const entry = await core.sendLink(t.url, t.title, toIds);
  return { entry };
}

// Значок: число непрочитанных полученных вкладок; после отправки на 2.5 с — ✓ или !
let flashUntil = 0;
async function updateBadge() {
  if (Date.now() < flashUntil) return;
  try {
    const n = await core.unreadCount();
    api.action.setBadgeBackgroundColor?.({ color: "#2563eb" });
    api.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : "" });
  } catch {}
}
function flashBadge(ok) {
  try {
    flashUntil = Date.now() + 2500;
    api.action.setBadgeBackgroundColor?.({ color: ok ? "#16a34a" : "#dc2626" });
    api.action.setBadgeText({ text: ok ? "✓" : "!" });
    setTimeout(() => { flashUntil = 0; updateBadge(); }, 2600);
  } catch {}
}

function notifyError(e) {
  try {
    api.notifications?.create("tb-err", {
      type: "basic", iconUrl: api.runtime.getURL("icons/icon128.png"),
      title: "Не удалось отправить", message: String(e?.message || e)
    });
  } catch {}
}

let sending = false;
function sendWithFeedback(job) {
  if (sending) return;
  sending = true;
  Promise.resolve().then(job)
    .then(() => flashBadge(true), (e) => { flashBadge(false); notifyError(e); })
    .finally(() => { sending = false; });
}

// ---------- режим кнопки: окно с «Отправить» или отправка сразу по клику ----------
async function applyClickMode() {
  try {
    const { clickMode } = await api.storage.local.get("clickMode");
    await api.action.setPopup({ popup: clickMode === "instant" ? "" : "popup.html" });
    await api.action.setTitle({ title: clickMode === "instant" ? "Tab Bridge — отправить эту вкладку" : "Tab Bridge" });
  } catch {}
}

// Куда отправлять без выбора: настройка quickTarget = "last" | "all" | id устройства
async function quickTargets() {
  const i = await core.info();
  const ids = new Set(i.devices.map((d) => d.id));
  const { quickTarget = "last" } = await api.storage.local.get("quickTarget");
  if (quickTarget === "all") return [];
  if (quickTarget !== "last" && ids.has(quickTarget)) return [quickTarget];
  return i.lastTargets.filter((id) => ids.has(id));
}

// В режиме «сразу» клик по значку приходит сюда (в режиме окна браузер открывает окно сам)
api.action.onClicked.addListener(async (tab) => {
  const i = await core.info().catch(() => null);
  if (i && !i.devices.length) return api.runtime.openOptionsPage();
  sendWithFeedback(async () => sendActive(await quickTargets(), tab));
});

// ---------- приём ----------
async function openTab(url, active) {
  if (!C.isSafeUrl(url)) return null;
  const t = await api.tabs.create({ url, active });
  if (active && api.windows && t?.windowId != null) { try { await api.windows.update(t.windowId, { focused: true }); } catch {} }
  return t;
}

async function afterHandle(res) {
  if (!res) return res;
  if (res.removedMe) {
    // это устройство удалили с другого устройства — отключаемся и создаём новую группу
    initPromise = null;
    await api.storage.local.set({ secret: "" });
    await init();
    await setupMenus();
    reconnect();
    try {
      api.notifications?.create("tb-removed", {
        type: "basic", iconUrl: api.runtime.getURL("icons/icon128.png"),
        title: "Tab Bridge: компьютер отключён",
        message: "Этот компьютер удалили из списка на другом устройстве. Чтобы подключить снова — вставьте ключ группы в настройках."
      });
    } catch {}
    return res;
  }
  if (res.clockSkew) {
    await api.storage.local.set({ lastWarning: "Часы этого или другого устройства расходятся больше чем на 10 минут — сообщения отбрасываются. Проверьте дату и время." });
  }
  if (res.devicesChanged) setupMenus();
  const s = await api.storage.local.get(["autoOpen", "focusOpened", "notify", "tabIds"]);
  const tabIds = s.tabIds || {};
  for (const h of res.fresh) {
    if (s.autoOpen) {
      try {
        const t = await openTab(h.url, !!s.focusOpened);
        if (t) { tabIds[h.id] = t.id; core.markOpened(h.id); }
      } catch {}
    }
    if ((s.notify ?? true) && api.notifications) {
      try {
        await api.notifications.create("tb:" + h.id, {
          type: "basic", iconUrl: api.runtime.getURL("icons/icon128.png"),
          title: (h.from ? `Вкладка с «${h.from}»` : "Новая вкладка") + (s.autoOpen ? "" : " — нажмите, чтобы открыть"),
          message: h.title
        });
      } catch {}
    }
  }
  if (res.fresh.length) await api.storage.local.set({ tabIds: Object.fromEntries(Object.entries(tabIds).slice(-50)) });
  if (res.fresh.length || res.devicesChanged) updateBadge();
  return res;
}

async function poll() {
  await init();
  try {
    const res = await afterHandle(await core.poll());
    await api.storage.local.set({ lastPoll: Date.now(), lastError: "" });
    return res;
  } catch (e) {
    const text = e?.name === "TypeError" ? "нет соединения с сервером (проверьте интернет)" : String(e?.message || e);
    await api.storage.local.set({ lastError: text, lastPoll: Date.now() });
    throw e;
  }
}

let ws = null;
let wsKey = "";
async function connectLive() {
  await init();
  const url = await core.wsUrl();
  if (!url) return;
  if (ws && wsKey === url && ws.readyState <= 1) return;
  try { ws?.close(); } catch {}
  ws = null;
  try {
    const sock = new WebSocket(url);
    ws = sock;
    wsKey = url;
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === "message") core.handle([m]).then(afterHandle).catch(() => {});
    };
    sock.onclose = sock.onerror = () => { if (ws === sock) ws = null; };
  } catch { ws = null; }
}

function reconnect() {
  try { ws?.close(); } catch {}
  ws = null;
  wake();
}

async function wake() {
  try { if (!(await api.alarms.get(ALARM))) await api.alarms.create(ALARM, { periodInMinutes: 0.5 }); } catch {}
  try { await init(); } catch {}
  connectLive().catch(() => {});
  poll().catch(() => {});
  core.maybeHello().catch(() => {});
}

// ---------- меню ----------
async function setupMenus() {
  if (!api.contextMenus) return;
  try {
    await api.contextMenus.removeAll();
    const { devices } = await core.info();
    for (const [ctx, what] of [["page", "вкладку"], ["link", "ссылку"]]) {
      if (!devices.length) {
        api.contextMenus.create({ id: `tb-${ctx}|none`, title: `Отправить ${what} — сначала подключите телефон`, contexts: [ctx] });
      } else if (devices.length === 1) {
        api.contextMenus.create({ id: `tb-${ctx}|${devices[0].id}`, title: `Отправить ${what} на «${devices[0].name}»`, contexts: [ctx] });
      } else {
        const parent = `tb-${ctx}|parent`;
        api.contextMenus.create({ id: parent, title: `Отправить ${what} на…`, contexts: [ctx] });
        for (const d of devices) api.contextMenus.create({ id: `tb-${ctx}|${d.id}`, parentId: parent, title: d.name, contexts: [ctx] });
        api.contextMenus.create({ id: `tb-${ctx}|all`, parentId: parent, title: "Все устройства", contexts: [ctx] });
      }
    }
  } catch {}
}

api.contextMenus?.onClicked.addListener((info, tab) => {
  const [kind, target] = String(info.menuItemId).split("|");
  if (target === "none") return api.runtime.openOptionsPage();
  const to = target === "all" ? [] : [target];
  if (kind === "tb-link") sendWithFeedback(() => core.sendLink(info.linkUrl, info.linkText || info.selectionText || info.linkUrl, to));
  else if (kind === "tb-page") sendWithFeedback(() => sendActive(to, tab));
});

// Alt+Shift+S — туда же, куда быстрая отправка (настройка «Куда отправлять без выбора»)
api.commands?.onCommand.addListener((cmd, tab) => {
  if (cmd !== "send-current-tab") return;
  sendWithFeedback(async () => sendActive(await quickTargets(), tab));
});

api.notifications?.onClicked.addListener(async (nid) => {
  if (!nid.startsWith("tb:")) return;
  try { api.notifications.clear(nid); } catch {}
  const id = nid.slice(3);
  const { history } = await core.info();
  const h = history.find((x) => x.id === id);
  if (!h) return;
  const { tabIds = {} } = await api.storage.local.get("tabIds");
  if (tabIds[id] != null) {
    try {
      const t = await api.tabs.update(tabIds[id], { active: true });
      if (api.windows && t?.windowId != null) await api.windows.update(t.windowId, { focused: true });
      return;
    } catch {}
  }
  await openTab(h.url, true);
  await core.markOpened(id);
  updateBadge();
});

// ---------- связь с окном расширения и настройками ----------
async function handle(msg, sender) {
  if (sender?.id && sender.id !== api.runtime.id) return {};
  await init();
  switch (msg?.type) {
    case "info": {
      const i = await core.info();
      const t = await getActiveTab().catch(() => null);
      const s = await api.storage.local.get(["lastPoll", "lastError", "lastWarning", "clickMode"]);
      delete i.secret;
      return { ...i, tab: t ? { title: t.title, url: t.url } : null, ...s };
    }
    case "send": return sendActive(msg.to || []);
    case "check": await connectLive(); await poll(); return {};
    case "open-received": {
      const { history } = await core.info();
      const h = history.find((x) => x.id === msg.id);
      if (h) { await openTab(h.url, true); await core.markOpened(h.id); updateBadge(); }
      return {};
    }
    case "mark-read": await core.markAllRead(); updateBadge(); return {};
    case "resend": return { entry: await core.resend(msg.id) };
    case "click-mode": await applyClickMode(); return {};
    case "dismiss-warning": await api.storage.local.set({ lastWarning: "" }); return {};
    case "remove-device": await core.removeDevice(msg.id); await setupMenus(); return {};
    case "rename": await core.rename(msg.name); return {};
    case "clear-history": await core.clearHistory(); updateBadge(); return {};
    case "set-key": {
      // новый ключ (свой или вставленный с другого ПК): подключаемся заново
      const bad = C.checkSecret(msg.secret);
      if (bad) throw new Error(bad);
      await core.leave();
      const { deviceName } = await api.storage.local.get("deviceName");
      await core.pair(msg.secret, msg.server || DEFAULT_SERVER, deviceName || guessDeviceName());
      await setupMenus();
      reconnect();
      return {};
    }
    case "settings-changed": reconnect(); return {};
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

api.runtime.onInstalled.addListener(async (details) => {
  await init().catch(() => {});
  setupMenus();
  applyClickMode();
  wake();
  if (details?.reason === "install") {
    api.tabs.create({ url: api.runtime.getURL("options.html#welcome") }).catch(() => {});
  } else {
    core.hello(false).catch(() => {}); // после обновления — сразу напомнить о себе
  }
});
api.runtime.onStartup.addListener(() => { setupMenus(); applyClickMode(); wake(); });
api.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) wake(); });

applyClickMode();
updateBadge();
wake();
