// Tab Bridge — общее ядро для расширения и телефона.
//
// Устройства одной группы общаются через сервер ntfy зашифрованными сообщениями:
//   общая «служебная» тема — привет (hello), удаление устройства (bye), отметки доставки (ack);
//   личная тема каждого устройства («входящие») — ссылки, отправленные именно ему.
// Телефон подписан на push только по своим «входящим», поэтому лишних уведомлений нет.
//
// Хранилище подключает хост: kv.getAll(keys) → объект, kv.setMany(obj).

(function (g) {
  "use strict";

  const C = g.TBCrypto;
  const HELLO_EVERY = 6 * 3600;   // устройства напоминают о себе раз в 6 часов
  const MAX_SEEN = 500;
  const MAX_HISTORY = 50;
  const MAX_SENT = 50;
  const RANK = { sent: 0, delivered: 1, opened: 2 };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function randId(n) {
    const abc = "abcdefghijkmnpqrstuvwxyz23456789";
    return Array.from(g.crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b & 31]).join("");
  }

  function create({ kv, kind, defaultServer = "https://ntfy.sh" }) {
    const FO = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
    const DEF = {
      secret: "", server: defaultServer, deviceId: "", deviceName: "",
      startTs: 0, sinceTs: 0, seen: [], nonces: [],
      devices: [], removed: [], history: [], sent: [],
      lastHello: 0, lastTargets: []
    };

    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

    async function load() {
      const o = (await kv.getAll(Object.keys(DEF))) || {};
      const s = {};
      for (const k of Object.keys(DEF)) s[k] = o[k] === undefined || o[k] === null ? clone(DEF[k]) : o[k];
      return s;
    }

    const serverOf = (s) => cleanUrl(s.server) || defaultServer;

    async function topicsOf(s) {
      const group = await C.deriveGroup(s.secret);
      return { group, control: group.topic, inbox: await C.topicFor(group, "inbox:" + s.deviceId) };
    }

    async function publish(s, topic, message) {
      const r = await fetch(serverOf(s), {
        ...FO, method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, message })
      });
      if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
    }

    async function control(s, obj) {
      const t = await topicsOf(s);
      await publish(s, t.control, await C.seal(t.group, Object.assign({}, obj, { d: s.deviceId })));
    }

    // ---------- подключение ----------

    // Подключить это устройство к группе (новый id, чистая история). Сообщает о себе остальным.
    async function pair(secret, server, name) {
      const now = nowSec();
      await kv.setMany({
        secret: C.normalizeSecret(secret), server: cleanUrl(server) || defaultServer,
        deviceId: randId(12), deviceName: String(name || "").slice(0, 40) || "Устройство",
        startTs: now, sinceTs: 0, seen: [], nonces: [], devices: [], removed: [],
        history: [], sent: [], lastHello: 0, lastTargets: []
      });
      try { await hello(false); } catch {}
    }

    async function hello(reply) {
      const s = await load();
      if (!s.secret || !s.deviceId) return;
      await control(s, { k: "hello", f: s.deviceName, kind, r: reply ? 1 : 0 });
      await kv.setMany({ lastHello: nowSec() });
    }

    async function maybeHello() {
      const s = await load();
      if (s.secret && s.deviceId && nowSec() - s.lastHello > HELLO_EVERY) await hello(false);
    }

    async function rename(name) {
      await kv.setMany({ deviceName: String(name || "").trim().slice(0, 40) || "Устройство" });
      try { await hello(false); } catch {}
    }

    // Удалить устройство из группы у всех. Если это устройство в сети, оно само отключится.
    async function removeDevice(id) {
      const s = await load();
      await control(s, { k: "bye", x: id });
      await serial(async () => {
        const cur = await load();
        await kv.setMany({
          devices: cur.devices.filter((d) => d.id !== id),
          removed: [...new Set([...cur.removed, id])].slice(-200),
          lastTargets: cur.lastTargets.filter((x) => x !== id)
        });
      });
    }

    // Отключить это устройство: сообщить остальным и забыть ключ (данные стирает хост).
    async function leave() {
      const s = await load();
      if (s.secret && s.deviceId) { try { await control(s, { k: "bye", x: s.deviceId }); } catch {} }
    }

    // ---------- отправка ----------

    async function sendLink(url, title, toIds) {
      if (!C.isSafeUrl(url)) throw new Error("Эту страницу передать нельзя — поддерживаются только http/https-ссылки.");
      const s = await load();
      const known = new Map(s.devices.map((d) => [d.id, d]));
      const targets = (toIds && toIds.length ? toIds : s.devices.map((d) => d.id)).filter((id) => known.has(id));
      if (!targets.length) throw new Error("Нет подключённых устройств. Сначала подключите телефон.");
      const t = await topicsOf(s);
      const i = randId(12);
      const msg = await C.seal(t.group, {
        k: "link", i, u: url, t: String(title || "").slice(0, 300), f: s.deviceName, d: s.deviceId, to: targets
      });
      await Promise.all(targets.map(async (id) => publish(s, await C.topicFor(t.group, "inbox:" + id), msg)));
      const entry = {
        i, url, title: String(title || "").slice(0, 300) || url, time: nowSec(),
        to: targets.map((id) => ({ id, name: known.get(id).name, s: "sent" }))
      };
      await serial(async () => {
        const cur = await load();
        await kv.setMany({ sent: [entry, ...cur.sent].slice(0, MAX_SENT), lastTargets: targets });
      });
      return entry;
    }

    async function ack(s, linkId, state) {
      try { await control(s, { k: "ack", i: linkId, s: state }); } catch {}
    }

    // Отметить полученную ссылку открытой (и сообщить отправителю).
    async function markOpened(linkId) {
      const s = await serial(async () => {
        const cur = await load();
        const h = cur.history.find((x) => x.id === linkId);
        if (!h || h.opened) return null;
        h.opened = true;
        await kv.setMany({ history: cur.history });
        return cur;
      });
      if (s) await ack(s, linkId, "opened");
    }

    // ---------- приём ----------

    const EMPTY = { fresh: [], devicesChanged: false, sentChanged: false, removedMe: false };

    function handle(msgs, { advance = false } = {}) {
      return serial(async () => {
        const s = await load();
        if (!s.secret || !s.deviceId) return EMPTY;
        const t = await topicsOf(s);
        const seen = new Set(s.seen);
        const nonces = new Set(s.nonces);
        const removed = new Set(s.removed);
        const devices = new Map(s.devices.map((d) => [d.id, d]));
        const sent = s.sent;
        const fresh = [];
        let needReply = false, devicesChanged = false, sentChanged = false, removedMe = false;
        let maxTime = s.sinceTs;

        const touch = (id, time) => {
          const d = devices.get(id);
          if (d && (d.lastSeen || 0) < time) { d.lastSeen = time; devicesChanged = true; }
        };

        for (const m of msgs) {
          if (!m || m.event !== "message" || !m.id || typeof m.time !== "number") continue;
          if (m.time > maxTime) maxTime = m.time;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          const r = await C.open(t.group, m.message);
          if (!r || nonces.has(r.nonce)) continue;             // чужое, подделка или повтор
          nonces.add(r.nonce);
          const o = r.obj;
          if (Math.abs(o.ts - m.time) > C.MAX_CLOCK_SKEW) continue;
          const from = String(o.d || "");
          if (!from || from === s.deviceId) continue;           // своё
          const k = o.k || (o.u ? "link" : "");

          if (k === "hello") {
            if (removed.has(from)) continue;
            const prev = devices.get(from);
            const name = String(o.f || "").slice(0, 60) || "Устройство";
            const dk = o.kind === "phone" || o.kind === "pc" ? o.kind : (prev && prev.kind) || "";
            if (!prev && !o.r) needReply = true;
            if (!prev || prev.name !== name || prev.kind !== dk) {
              devices.set(from, { id: from, name, kind: dk, added: prev ? prev.added : m.time, lastSeen: Math.max(m.time, (prev && prev.lastSeen) || 0) });
              devicesChanged = true;
            } else touch(from, m.time);
          } else if (k === "bye") {
            const x = String(o.x || "");
            if (x === s.deviceId) { removedMe = true; continue; }
            devices.delete(x);
            removed.add(x);
            devicesChanged = true;
          } else if (k === "ack") {
            touch(from, m.time);
            const e = sent.find((x) => x.i === o.i);
            const tg = e && e.to.find((x) => x.id === from);
            if (tg && (RANK[o.s] ?? -1) > (RANK[tg.s] ?? 0)) { tg.s = o.s; sentChanged = true; }
          } else if (k === "link") {
            if (removed.has(from) || m.time < s.startTs || !C.isSafeUrl(o.u)) continue;
            if (Array.isArray(o.to) && o.to.length && !o.to.includes(s.deviceId)) continue;
            if (!devices.has(from)) {
              devices.set(from, { id: from, name: String(o.f || "").slice(0, 60) || "Устройство", kind: "", added: m.time, lastSeen: m.time });
              devicesChanged = true;
              needReply = true;
            } else touch(from, m.time);
            fresh.push({
              id: String(o.i || m.id), url: o.u, title: String(o.t || "").slice(0, 300) || o.u,
              from: String(o.f || "").slice(0, 60), fromId: from, time: m.time, opened: false
            });
          }
        }

        const have = new Set(s.history.map((h) => h.id));
        const add = fresh.filter((h) => !have.has(h.id)).reverse();
        const patch = {
          seen: [...seen].slice(-MAX_SEEN), nonces: [...nonces].slice(-MAX_SEEN),
          devices: [...devices.values()], removed: [...removed].slice(-200), sent,
          history: [...add, ...s.history].slice(0, MAX_HISTORY)
        };
        if (advance) patch.sinceTs = maxTime;
        await kv.setMany(patch);
        return { fresh: add, devicesChanged, sentChanged, removedMe, needReply, s };
      }).then(async (res) => {
        if (!res.s) return res;
        if (!res.removedMe) {
          if (res.needReply) hello(true).catch(() => {});
          await Promise.all(res.fresh.map((h) => ack(res.s, h.id, "delivered")));
        }
        return { fresh: res.fresh, devicesChanged: res.devicesChanged, sentChanged: res.sentChanged, removedMe: res.removedMe };
      });
    }

    async function poll() {
      const s = await load();
      if (!s.secret || !s.deviceId) return EMPTY;
      const t = await topicsOf(s);
      const since = s.sinceTs ? String(Math.max(0, s.sinceTs - 1)) : "all";
      const r = await fetch(`${serverOf(s)}/${t.control},${t.inbox}/json?poll=1&since=${since}`, FO);
      if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
      const msgs = (await r.text()).split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return handle(msgs, { advance: true });
    }

    async function wsUrl() {
      const s = await load();
      if (!s.secret || !s.deviceId) return "";
      const t = await topicsOf(s);
      return `${serverOf(s).replace(/^http/i, "ws")}/${t.control},${t.inbox}/ws`;
    }

    async function inboxTopic() {
      const s = await load();
      return (await topicsOf(s)).inbox;
    }

    async function info() {
      const s = await load();
      return {
        paired: Boolean(s.secret && s.deviceId),
        me: { id: s.deviceId, name: s.deviceName, kind },
        devices: s.devices.slice().sort((a, b) => (a.added || 0) - (b.added || 0)),
        history: s.history, sent: s.sent, lastTargets: s.lastTargets,
        server: serverOf(s), secret: s.secret
      };
    }

    async function clearHistory() {
      await serial(() => kv.setMany({ history: [], sent: [] }));
    }

    return {
      pair, hello, maybeHello, rename, removeDevice, leave,
      sendLink, markOpened, handle, poll, wsUrl, inboxTopic, info, clearHistory, serial
    };
  }

  g.TBCore = { create, randId };
})(globalThis);
