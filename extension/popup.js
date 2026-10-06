const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function send(msg) {
  try {
    return (await api.runtime.sendMessage(msg)) ?? { ok: false, error: "Нет ответа от фона" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function status(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

function ago(sec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return "только что";
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return new Date(sec * 1000).toLocaleDateString();
}

const isWeb = (u) => /^https?:\/\//i.test(u || "");

async function render() {
  const s = await api.storage.local.get(["deviceName", "history", "lastPoll", "lastError"]);
  $("device").textContent = s.deviceName || "";
  const list = $("list");
  list.textContent = "";
  const items = (s.history || []).filter((h) => isWeb(h.url)).slice(0, 10);
  $("empty").hidden = items.length > 0;
  $("clear").hidden = items.length === 0;
  for (const h of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = h.url;
    a.title = h.url;
    a.rel = "noopener noreferrer";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = h.title || h.url;
    const m = document.createElement("span");
    m.className = "muted";
    m.textContent = [h.from, ago(h.time)].filter(Boolean).join(" · ");
    a.append(t, m);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      api.tabs.create({ url: h.url, active: true });
    });
    li.append(a);
    list.append(li);
  }
  if (s.lastError) {
    $("last").className = "err";
    $("last").textContent = "Ошибка связи: " + s.lastError;
  } else if (s.lastPoll) {
    $("last").className = "muted";
    $("last").textContent = "Последняя проверка: " + new Date(s.lastPoll).toLocaleTimeString();
  }
}

$("check").addEventListener("click", async () => {
  $("check").disabled = true;
  const r = await send({ type: "check" });
  $("check").disabled = false;
  if (r.ok) status(r.received ? `Получено новых: ${r.received}` : "Новых вкладок нет", "muted");
  else status(r.error || "Ошибка проверки", "err");
  render();
});

$("clear").addEventListener("click", async () => {
  await send({ type: "clear-history" });
  status("История очищена.", "muted");
  render();
});

$("settings").addEventListener("click", () => {
  api.runtime.openOptionsPage();
});

api.storage.onChanged.addListener(render);
render();
send({ type: "check" }).then(render);
