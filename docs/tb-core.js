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
  const MAX_NONCES = 3000;
  const REPLAY_WINDOW = 13 * 3600; // сервер хранит сообщения 12 часов: всё старше — повтор, отбрасываем
  const MAX_HISTORY = 50;
  const MAX_SENT = 50;
  const RANK = { failed: -1, sent: 0, delivered: 1, opened: 2 };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const cleanUrl = (u) => String(u || "").trim().replace(/\/+$/, "");
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function randId(n) {
    const abc = "abcdefghijkmnpqrstuvwxyz23456789";
    return Array.from(g.crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b & 31]).join("");
  }

  // Какие типы файлов показываем как картинку/текст. Всё остальное — только «Скачать»
  // (никогда не открываем присланный HTML/SVG/скрипт как страницу).
  const SAFE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif", "text/plain"];
  const safeMime = (m) => { const t = String(m || "").split(";")[0].trim().toLowerCase(); return SAFE_MIME.includes(t) ? t : "application/octet-stream"; };
  // убираем и «невидимые» символы направления текста (photo\u202Egnp.exe выглядело бы как картинка)
  const safeName = (n) => String(n || "файл").replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "_").trim().slice(0, 120) || "файл";
  const preview = (x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const TEXT_INLINE = 1800;      // короче — уходит прямо в сообщении, длиннее — зашифрованным файлом
  const MAX_TEXT = 200000;
  const KEEP_INLINE_TEXT = 5000;  // длиннее — текст лежит только в хранилище файлов, в списке — начало
  const PAYLOAD_TTL = 3 * 3600;   // столько сервер хранит файлы; после — повторить отправку файла нельзя
  // ntfy.sh принимает вложения до 2 МБ (и до 20 МБ на одно подключение за 3 часа).
  // Большой зашифрованный файл уходит частями, получатель собирает их обратно.
  const PART = 1900000;
  const MAX_PARTS = 8;
  const RES_CAP = PART + 1024;    // больше одной части с сервера не скачиваем (защита от «бесконечного» ответа)

  // maxBytes — сколько места на этом устройстве могут занимать полученные файлы
  function create({ kv, kind, defaultServer = "https://ntfy.sh", blobs = null, maxBytes = 300 * 1024 * 1024, version = "" }) {
    const VERSION = String(version || "").slice(0, 20);
    const FO = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
    const DEF = {
      secret: "", server: defaultServer, deviceId: "", deviceName: "", kind: "",
      startTs: 0, sinceTs: 0, seen: [], nonces: [],
      devices: [], removed: [], history: [], sent: [],
      lastHello: 0, helloVersion: "", lastTargets: [], pendingBye: [],
      keepDays: 7,        // сколько дней хранить полученные файлы (0 — пока есть место)
      lastCleanup: 0
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
    // «sender» — устройство только для отправки (Safari на iPhone для быстрой кнопки):
    // ему ничего не присылают, и в списках получателей его нет.
    const KINDS = ["pc", "phone", "sender"];
    const kindOf = (s) => (KINDS.includes(s.kind) ? s.kind : kind);
    const receivers = (list) => list.filter((d) => d.kind !== "sender");
    // Куда отправляет это устройство. Safari на iPhone («sender») шлёт на компьютеры:
    // отправлять с iPhone на приложение того же iPhone незачем. Если компьютеров нет — на всех.
    function targetsOf(s, list) {
      const r = receivers(list);
      if (kindOf(s) !== "sender") return r;
      const pcs = r.filter((d) => d.kind !== "phone");
      return pcs.length ? pcs : r;
    }

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
    // opts.kind = "sender" — подключить только для отправки.
    async function pair(secret, server, name, opts = {}) {
      const now = nowSec();
      await kv.setMany({
        secret: C.normalizeSecret(secret), server: cleanUrl(server) || defaultServer,
        deviceId: randId(12), deviceName: String(name || "").slice(0, 40) || "Устройство",
        startTs: now, sinceTs: 0, seen: [], nonces: [], devices: [], removed: [],
        history: [], sent: [], lastHello: 0, lastTargets: [], pendingBye: [],
        kind: KINDS.includes(opts.kind) ? opts.kind : ""
      });
      if (blobs) await blobs.clear().catch(() => {});
      try { await hello(false); } catch {}
    }

    async function hello(reply) {
      const s = await load();
      if (!s.secret || !s.deviceId) return;
      await control(s, { k: "hello", f: s.deviceName, kind: kindOf(s), r: reply ? 1 : 0, av: VERSION });
      await kv.setMany({ lastHello: nowSec(), helloVersion: VERSION });
    }

    async function maybeHello() {
      const s = await load();
      // после обновления сразу сообщаем остальным свою новую версию
      if (s.secret && s.deviceId && (nowSec() - s.lastHello > HELLO_EVERY || s.helloVersion !== VERSION)) await hello(false);
      await flushPending();
    }

    async function rename(name) {
      await kv.setMany({ deviceName: String(name || "").trim().slice(0, 40) || "Устройство" });
      try { await hello(false); } catch {}
    }

    // Удалить устройство из группы у всех. Здесь — сразу; остальным сообщаем, как только будет связь
    // (если сейчас нет интернета, сообщение повторится при следующей проверке).
    async function removeDevice(id) {
      await serial(async () => {
        const cur = await load();
        await kv.setMany({
          devices: cur.devices.filter((d) => d.id !== id),
          removed: [...new Set([...cur.removed, id])].slice(-200),
          lastTargets: cur.lastTargets.filter((x) => x !== id),
          pendingBye: [...new Set([...cur.pendingBye, id])]
        });
      });
      await flushPending();
    }

    async function flushPending() {
      const s = await load();
      if (!s.secret || !s.deviceId || !s.pendingBye.length) return;
      const done = [];
      for (const id of s.pendingBye) {
        try { await control(s, { k: "bye", x: id }); done.push(id); } catch { break; }
      }
      if (done.length) {
        await serial(async () => {
          const cur = await load();
          await kv.setMany({ pendingBye: cur.pendingBye.filter((x) => !done.includes(x)) });
        });
      }
    }

    // Отключить это устройство: сообщить остальным и забыть ключ (данные стирает хост).
    async function leave() {
      const s = await load();
      if (s.secret && s.deviceId) { try { await control(s, { k: "bye", x: s.deviceId }); } catch {} }
    }

    // ---------- отправка ----------

    function resolveTargets(s, toIds) {
      const known = new Map(targetsOf(s, s.devices).map((d) => [d.id, d]));
      const targets = (toIds && toIds.length ? toIds : [...known.keys()]).filter((id) => known.has(id));
      if (!targets.length) throw new Error("Нет подключённых устройств. Сначала подключите телефон.");
      return { known, targets };
    }

    const netError = (err) => (err && err.name === "TypeError") ? new Error("Нет соединения с сервером — проверьте интернет.") : err;

    // Общая отправка: шифруем один раз и кладём во «входящие» каждому получателю.
    async function sendPayload(payload, entryBase, toIds) {
      const s = await load();
      const { known, targets } = resolveTargets(s, toIds);
      const t = await topicsOf(s);
      const i = randId(12);
      const msg = await C.seal(t.group, Object.assign({}, payload, { i, f: s.deviceName, d: s.deviceId, to: targets }));
      // Запись в «Отправлено» появляется ДО отправки: иначе быстрый ответ «доставлено»
      // мог прийти раньше, чем запись, и статус застрял бы на «отправлено».
      const entry = Object.assign({ i }, entryBase, {
        time: nowSec(), to: targets.map((id) => ({ id, name: known.get(id).name, s: "sent" }))
      });
      await serial(async () => {
        const cur = await load();
        await kv.setMany({ sent: [entry, ...cur.sent].slice(0, MAX_SENT), lastTargets: targets });
      });
      const results = await Promise.allSettled(targets.map(async (id) => publish(s, await C.topicFor(t.group, "inbox:" + id), msg)));
      const failed = targets.filter((_, n) => results[n].status === "rejected");
      if (failed.length) {
        await serial(async () => {
          const cur = await load();
          const e = cur.sent.find((x) => x.i === i);
          if (e) {
            for (const tg of e.to) if (failed.includes(tg.id) && tg.s === "sent") tg.s = "failed";
            e.pl = payload;   // чтобы «Повторить» могло отправить то же самое
          }
          await kv.setMany({ sent: cur.sent });
        });
        for (const tg of entry.to) if (failed.includes(tg.id)) tg.s = "failed";
        if (failed.length === targets.length) throw netError(results.find((r) => r.status === "rejected").reason);
      }
      return entry;
    }

    async function sendLink(url, title, toIds) {
      if (!C.isSafeUrl(url)) throw new Error("Эту страницу передать нельзя — поддерживаются только http/https-ссылки.");
      const t = String(title || "").slice(0, 300);
      return sendPayload({ k: "link", u: url, t }, { kind: "link", url, title: t || url }, toIds);
    }

    async function sendText(text, toIds) {
      const x = String(text || "").replace(/\r\n?/g, "\n");
      if (!x.trim()) throw new Error("Напишите или вставьте текст.");
      if (x.length > MAX_TEXT) throw new Error("Текст слишком длинный (больше 200 000 знаков).");
      if (new TextEncoder().encode(x).length <= TEXT_INLINE) {
        return sendPayload({ k: "text", x }, { kind: "text", title: preview(x) }, toIds);
      }
      return sendFile(new Blob([x], { type: "text/plain" }), "Текст.txt", toIds, { asText: true, preview: preview(x) });
    }

    // Файл (скриншот, фото, длинный текст): шифруем своим ключом, загружаем один раз,
    // а получателям отправляем зашифрованную «записку» с адресом и ключом.
    async function sendFile(blob, name, toIds, opts = {}) {
      const s = await load();
      resolveTargets(s, toIds);                     // ошибку «нет устройств» — до загрузки
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) throw new Error("Файл пустой.");
      const { data, key } = await C.sealFile(bytes);
      const t = await topicsOf(s);
      const filesTopic = await C.topicFor(t.group, "files");
      const count = Math.ceil(data.length / PART);
      if (count > MAX_PARTS) throw new Error("Файл слишком большой — такой не отправить.");
      const urls = [];
      let exp = 0;
      for (let p = 0; p < count; p++) {
        const part = data.subarray(p * PART, Math.min(data.length, (p + 1) * PART));
        const prog = opts.onProgress ? (x) => opts.onProgress((p * PART + x * part.length) / data.length) : null;
        let r;
        try { r = await upload(`${serverOf(s)}/${filesTopic}`, part, prog); }
        catch (e) { throw netError(e); }
        if (!r.ok) {
          throw new Error(r.status === 413 ? "Сервер не принял файл: он слишком большой или исчерпан лимит сервера (20 МБ файлов за 3 часа). Попробуйте позже или отправьте файл поменьше." :
            r.status === 429 ? "Сервер временно ограничил отправку — попробуйте через несколько минут." :
            `Сервер не принял файл (ошибка ${r.status}).`);
        }
        const att = ((await r.json().catch(() => ({}))) || {}).attachment;
        if (!att || !isOurFile(s, att.url)) throw new Error("Сервер не принял файл.");
        urls.push(att.url);
        exp = exp ? Math.min(exp, Number(att.expires) || 0) : Number(att.expires) || 0;
      }
      const mime = safeMime(blob.type);
      const n = safeName(name);
      return sendPayload(
        // одна часть — адрес строкой (как в прежних версиях), несколько — списком
        { k: "file", n, m: mime, z: bytes.length, a: urls.length === 1 ? urls[0] : urls, key, e: exp, tx: opts.asText ? 1 : 0 },
        { kind: opts.asText ? "text" : "file", title: opts.asText ? (opts.preview || "Текст") : n, name: n, mime, size: bytes.length },
        toIds
      );
    }

    // Загрузка на сервер. Если нужен процент выполнения и есть XMLHttpRequest (страница) — через него.
    function upload(url, data, onProgress) {
      if (!onProgress || typeof XMLHttpRequest === "undefined") {
        return fetch(url, { ...FO, method: "PUT", headers: { "X-Filename": "tb.bin" }, body: data });
      }
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open("PUT", url);
        x.setRequestHeader("X-Filename", "tb.bin");
        x.timeout = 180000;
        x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, json: async () => JSON.parse(x.responseText || "{}") });
        x.onerror = () => reject(new TypeError("Failed to fetch"));
        x.ontimeout = () => reject(new Error("Сервер слишком долго не отвечает — проверьте интернет и попробуйте ещё раз."));
        x.send(data);
      });
    }

    const isOurUrl = (s, url) => typeof url === "string" && url.startsWith(serverOf(s) + "/file/") && url.length < 300;
    const isOurFile = (s, a) => (Array.isArray(a) ? a.length >= 1 && a.length <= MAX_PARTS && a.every((u) => isOurUrl(s, u)) : isOurUrl(s, a));

    // Скачать ответ сервера, но не больше limit байт (сервер может быть враждебным)
    async function readCapped(r, limit) {
      const len = Number(r.headers?.get?.("content-length") || 0);
      if (len > limit) throw new Error("Файл повреждён.");
      if (!r.body || !r.body.getReader) {
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length > limit) throw new Error("Файл повреждён.");
        return b;
      }
      const rd = r.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        total += value.length;
        if (total > limit) { try { rd.cancel(); } catch {} throw new Error("Файл повреждён."); }
        chunks.push(value);
      }
      const out = new Uint8Array(total); let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }

    // Повторить неудавшуюся отправку
    async function resend(linkId) {
      const s = await load();
      const e = s.sent.find((x) => x.i === linkId);
      if (!e) throw new Error("Запись не найдена.");
      const failedIds = e.to.filter((x) => x.s === "failed").map((x) => x.id);
      const ids = failedIds.length ? failedIds : e.to.map((x) => x.id);
      if (e.pl && e.pl.k === "file" && (e.pl.e ? nowSec() > e.pl.e - 60 : nowSec() - e.time > PAYLOAD_TTL)) {
        throw new Error("Файл уже удалён с сервера (он хранит файлы 3 часа). Отправьте его заново.");
      }
      if (e.pl) {
        const base = { kind: e.kind, title: e.title, url: e.url, name: e.name, mime: e.mime, size: e.size };
        return sendPayload(e.pl, base, ids);
      }
      if (e.kind && e.kind !== "link") throw new Error("Это уже не повторить — отправьте заново.");
      return sendLink(e.url, e.title, ids);
    }

    async function patchHistory(id, fn) {
      await serial(async () => {
        const cur = (await kv.getAll(["history"])).history || [];
        const x = cur.find((h) => h.id === id);
        if (x) { fn(x); await kv.setMany({ history: cur }); }
      });
    }

    // Скачать и расшифровать присланный файл, сохранить на этом устройстве.
    async function fetchFile(id) {
      if (!blobs) return false;
      const s = await load();
      const h = s.history.find((x) => x.id === id);
      if (!h || !h.file || !h.file.url) return false;
      try {
        if (h.file.exp && nowSec() > h.file.exp) throw new Error("Файл устарел: сервер хранит файлы 3 часа.");
        if (!isOurFile(s, h.file.url)) throw new Error("Неверный адрес файла.");
        const parts = [];
        for (const u of [].concat(h.file.url)) {
          let r;
          try { r = await fetch(u, FO); } catch (e) { throw netError(e); }
          if (!r.ok) throw new Error(r.status === 404 ? "Файл устарел: сервер хранит файлы 3 часа." : `Не удалось скачать (ошибка ${r.status}).`);
          parts.push(await readCapped(r, RES_CAP));
        }
        const all = parts.length === 1 ? parts[0] : new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        if (parts.length > 1) { let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } }
        const bytes = await C.openFile(all, h.file.key);
        if (bytes.length !== h.file.size) throw new Error("Файл повреждён.");
        const text = h.kind === "text" ? new TextDecoder().decode(bytes) : null;
        // короткий текст — прямо в списке (файл не нужен); длинный — только файлом, в списке начало
        const inline = text != null && text.length <= KEEP_INLINE_TEXT;
        if (!inline) await blobs.put(id, new Blob([bytes], { type: h.file.mime }));
        await patchHistory(id, (x) => {
          x.status = "ok"; delete x.error;
          delete x.file.key; delete x.file.url;          // ключ больше не нужен
          if (text != null) { x.title = preview(text); if (inline) { x.text = text; x.file.inline = true; } }
        });
        await ack(s, id, "delivered");
        return true;
      } catch (e) {
        await patchHistory(id, (x) => { x.status = "error"; x.error = String(e?.message || e); });
        return false;
      }
    }

    const getFile = (id) => (blobs ? blobs.get(id) : Promise.resolve(null));

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

    const EMPTY = { fresh: [], devicesChanged: false, sentChanged: false, removedMe: false, clockSkew: 0 };

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
        let needReply = false, devicesChanged = false, sentChanged = false, removedMe = false, clockSkew = 0;
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
          if (Math.abs(o.ts - m.time) > C.MAX_CLOCK_SKEW) { clockSkew++; continue; }
          if (o.ts < nowSec() - REPLAY_WINDOW) continue;        // старое сообщение, подсунутое повторно
          const from = String(o.d || "");
          if (!from || from === s.deviceId) continue;           // своё
          const k = o.k || (o.u ? "link" : "");

          if (k === "hello") {
            if (removed.has(from)) continue;
            const prev = devices.get(from);
            const name = String(o.f || "").slice(0, 60) || "Устройство";
            const dk = KINDS.includes(o.kind) ? o.kind : (prev && prev.kind) || "";
            if (!prev && !o.r) needReply = true;
            const vr = String(o.av || "").replace(/[^0-9.]/g, "").slice(0, 20);
            if (!prev || prev.name !== name || prev.kind !== dk || (prev.vr || "") !== vr) {
              devices.set(from, { id: from, name, kind: dk, vr, added: prev ? prev.added : m.time, lastSeen: Math.max(m.time, (prev && prev.lastSeen) || 0) });
              devicesChanged = true;
            } else touch(from, m.time);
          } else if (k === "bye") {
            // удалять могут только известные участники группы (не удалённые ранее)
            if (removed.has(from) || !devices.has(from)) continue;
            const x = String(o.x || "");
            if (x === s.deviceId) { removedMe = true; continue; }
            devices.delete(x);
            removed.add(x);
            devicesChanged = true;
          } else if (k === "ack") {
            if (removed.has(from)) continue;
            touch(from, m.time);
            const e = sent.find((x) => x.i === o.i);
            const tg = e && e.to.find((x) => x.id === from);
            if (tg && (RANK[o.s] ?? -1) > (RANK[tg.s] ?? 0)) { tg.s = o.s; sentChanged = true; }
          } else if (k === "text" || k === "file") {
            if (removed.has(from) || m.time < s.startTs) continue;
            if (Array.isArray(o.to) && o.to.length && !o.to.includes(s.deviceId)) continue;
            if (k === "text" && (typeof o.x !== "string" || !o.x.trim())) continue;
            if (k === "file" && (!isOurFile(s, o.a) || typeof o.key !== "string" || !(o.z > 0) || o.z > C.MAX_FILE)) continue;
            if (!devices.has(from)) {
              devices.set(from, { id: from, name: String(o.f || "").slice(0, 60) || "Устройство", kind: "", added: m.time, lastSeen: m.time });
              devicesChanged = true;
              needReply = true;
            } else touch(from, m.time);
            const base = { id: String(o.i || m.id), from: String(o.f || "").slice(0, 60), fromId: from, time: m.time, opened: false };
            if (k === "text") fresh.push(Object.assign(base, { kind: "text", text: o.x.slice(0, KEEP_INLINE_TEXT), title: preview(o.x), status: "ok" }));
            else {
              const asText = o.tx === 1;
              fresh.push(Object.assign(base, {
                kind: asText ? "text" : "file", title: asText ? "Текст" : safeName(o.n), status: blobs ? "loading" : "ok",
                file: { name: safeName(o.n), mime: asText ? "text/plain" : safeMime(o.m), size: o.z, url: o.a, key: o.key, exp: Number(o.e) || 0 }
              }));
            }
          } else if (k === "link") {
            if (removed.has(from) || m.time < s.startTs || !C.isSafeUrl(o.u)) continue;
            if (Array.isArray(o.to) && o.to.length && !o.to.includes(s.deviceId)) continue;
            if (!devices.has(from)) {
              devices.set(from, { id: from, name: String(o.f || "").slice(0, 60) || "Устройство", kind: "", added: m.time, lastSeen: m.time });
              devicesChanged = true;
              needReply = true;
            } else touch(from, m.time);
            fresh.push({
              id: String(o.i || m.id), kind: "link", url: o.u, title: String(o.t || "").slice(0, 300) || o.u,
              from: String(o.f || "").slice(0, 60), fromId: from, time: m.time, opened: false
            });
          }
        }

        const have = new Set(s.history.map((h) => h.id));
        const add = fresh.filter((h) => !have.has(h.id)).reverse();
        // Сохраняем только то, что изменилось: на телефоне страница и фоновый обработчик
        // работают параллельно, и запись «всего сразу» могла бы затереть чужие свежие изменения.
        const patch = { seen: [...seen].slice(-MAX_SEEN), nonces: [...nonces].slice(-MAX_NONCES) };
        if (devicesChanged) { patch.devices = [...devices.values()]; patch.removed = [...removed].slice(-200); }
        if (sentChanged) {
          // статусы накладываем на свежую версию списка, а не на прочитанную в начале
          const cur = (await kv.getAll(["sent"])).sent || [];
          for (const e of cur) {
            const mine = sent.find((x) => x.i === e.i);
            if (mine) for (const tg of e.to) {
              const m2 = mine.to.find((x) => x.id === tg.id);
              if (m2 && (RANK[m2.s] ?? 0) > (RANK[tg.s] ?? 0)) tg.s = m2.s;
            }
          }
          patch.sent = cur;
        }
        let dropped = [];
        if (add.length) {
          const curH = (await kv.getAll(["history"])).history || [];
          const ids = new Set(curH.map((h) => h.id));
          const all = [...add.filter((h) => !ids.has(h.id)), ...curH];
          patch.history = all.slice(0, MAX_HISTORY);
          dropped = all.slice(MAX_HISTORY).filter((h) => h.file).map((h) => h.id);
        }
        if (advance) patch.sinceTs = maxTime;
        await kv.setMany(patch);
        if (blobs) for (const id of dropped) blobs.del(id).catch(() => {});
        return { fresh: add, devicesChanged, sentChanged, removedMe, needReply, clockSkew, s };
      }).then(async (res) => {
        if (!res.s) return res;
        let fresh = res.fresh;
        if (!res.removedMe) {
          if (res.needReply) hello(true).catch(() => {});
          await Promise.all(fresh.filter((h) => !h.file || !blobs).map((h) => ack(res.s, h.id, "delivered")));
          // файлы: скачать и расшифровать; «доставлено» — только когда файл уже на устройстве
          const files = fresh.filter((h) => h.file && blobs);
          if (files.length) {
            for (const h of files) await fetchFile(h.id);
            await cleanup().catch(() => {});
            const hist = (await load()).history;
            fresh = fresh.map((h) => hist.find((x) => x.id === h.id) || h);
          }
        }
        return { fresh, devicesChanged: res.devicesChanged, sentChanged: res.sentChanged, removedMe: res.removedMe, clockSkew: res.clockSkew };
      });
    }

    async function poll() {
      const s = await load();
      if (!s.secret || !s.deviceId) return EMPTY;
      const t = await topicsOf(s);
      const since = s.sinceTs ? String(Math.max(0, s.sinceTs - 1)) : "all";
      const r = await fetch(`${serverOf(s)}/${t.control},${t.inbox}/json?poll=1&since=${since}`, FO);
      if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
      const msgs = new TextDecoder().decode(await readCapped(r, 16 * 1024 * 1024)).split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const res = await handle(msgs, { advance: true });
      flushPending().catch(() => {});
      return res;
    }

    async function wsUrl() {
      const s = await load();
      if (!s.secret || !s.deviceId) return "";
      const t = await topicsOf(s);
      return `${serverOf(s).replace(/^http/i, "ws")}/${t.control},${t.inbox}/ws`;
    }

    // Узнать, какие устройства уже есть в группе с этим ключом, НЕ подключаясь к ней
    // (чтобы перед подключением по чужой ссылке показать: «вы подключаетесь к …»).
    async function peek(secret, server) {
      const srv = cleanUrl(server) || defaultServer;
      const group = await C.deriveGroup(C.normalizeSecret(secret));
      const r = await fetch(`${srv}/${group.topic}/json?poll=1&since=all`, FO);
      if (!r.ok) throw new Error(`Сервер ответил ошибкой ${r.status}`);
      const msgs = new TextDecoder().decode(await readCapped(r, 16 * 1024 * 1024)).split("\n")
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((m) => m && m.event === "message" && typeof m.message === "string")
        .sort((a, b) => a.time - b.time);
      const devs = new Map();
      for (const m of msgs) {
        const x = await C.open(group, m.message);
        const o = x && x.obj;
        if (!o || !o.d) continue;
        if (o.k === "hello") devs.set(String(o.d), { name: String(o.f || "").slice(0, 60) || "Устройство", kind: KINDS.includes(o.kind) ? o.kind : "" });
        else if (o.k === "bye") devs.delete(String(o.x || ""));
      }
      return [...devs.values()];
    }

    async function inboxTopic() {
      const s = await load();
      return (await topicsOf(s)).inbox;
    }

    async function info() {
      const s = await load();
      const devices = s.devices.slice().sort((a, b) => (a.added || 0) - (b.added || 0));
      return {
        paired: Boolean(s.secret && s.deviceId),
        me: { id: s.deviceId, name: s.deviceName, kind: kindOf(s), version: VERSION },
        devices,                     // все устройства группы (для списка «Мои устройства»)
        targets: targetsOf(s, devices), // куда можно отправлять
        history: s.history, sent: s.sent, lastTargets: s.lastTargets,
        server: serverOf(s), secret: s.secret
      };
    }

    // Сколько полученных за сутки ссылок ещё не открыто (для значка расширения)
    async function unreadCount() {
      const s = await load();
      const since = nowSec() - 86400;
      return s.history.filter((h) => !h.opened && !h.read && h.time >= since).length;
    }

    // «Прочитано» — только для счётчика; статус «открыто» отправителю не меняет
    async function markAllRead() {
      await serial(async () => {
        const cur = await load();
        cur.history.forEach((h) => { h.read = true; });
        await kv.setMany({ history: cur.history });
      });
    }

    // ---------- память ----------
    // Удаляет полученные файлы старше keepDays и самые старые, если файлы занимают больше maxBytes;
    // убирает «осиротевшие» файлы и устаревшие данные для повторной отправки.
    async function cleanup() {
      const s = await load();
      const now = nowSec();
      const keep = Number(s.keepDays) || 0;
      const drop = new Map();                      // id → причина
      // «хранится файлом»: текст, который уже есть в списке, файлом хранить не нужно (его копия удалится как лишняя)
      const stored = (h) => h.file && h.status === "ok" && !h.file.gone && !h.file.inline && !(h.kind === "text" && typeof h.text === "string");
      for (const h of s.history) if (stored(h) && keep > 0 && now - h.time > keep * 86400) drop.set(h.id, "age");
      let sum = 0;
      for (const h of s.history) {                 // история — от новых к старым
        if (!stored(h) || drop.has(h.id)) continue;
        sum += h.file.size;
        if (maxBytes && sum > maxBytes) drop.set(h.id, "space");
      }
      if (blobs) {
        for (const id of drop.keys()) await blobs.del(id).catch(() => {});
        if (blobs.keys) {
          const live = new Set(s.history.filter((h) => stored(h) && !drop.has(h.id)).map((h) => h.id));
          for (const key of await blobs.keys().catch(() => [])) {
            const k = String(key);
            if (k.startsWith("share:")) {                          // картинки из «Поделиться» (Android)
              const ts = Number(k.split(":")[1]) || 0;
              if (Date.now() - ts > 3600 * 1000) await blobs.del(k).catch(() => {});
            } else if (!live.has(k)) await blobs.del(k).catch(() => {});
          }
        }
      }
      await serial(async () => {
        const cur = await load();
        for (const h of cur.history) {
          const why = drop.get(h.id);
          if (why) { h.status = "gone"; h.gone = why; h.file.gone = true; delete h.file.key; delete h.file.url; }
        }
        // у файлов в данных для повтора лежит ключ файла — через 3 часа (файла на сервере уже нет) удаляем
        for (const e of cur.sent) if (e.pl && e.pl.k === "file" && now - e.time > PAYLOAD_TTL) delete e.pl;
        await kv.setMany({ history: cur.history, sent: cur.sent, lastCleanup: now });
      });
      return drop.size;
    }

    async function maybeCleanup() {
      const s = await load();
      if (nowSec() - (s.lastCleanup || 0) > 3600) await cleanup();
    }

    async function setKeepDays(days) {
      await kv.setMany({ keepDays: Math.max(0, Math.min(365, Number(days) || 0)) });
      await cleanup();
    }

    async function storageStats() {
      const s = await load();
      let files = 0, bytes = 0;
      for (const h of s.history) {
        if (h.file && h.status === "ok" && !h.file.gone && !h.file.inline && !(h.kind === "text" && typeof h.text === "string")) { files++; bytes += h.file.size; }
      }
      return { files, bytes, history: s.history.length, sent: s.sent.length, keepDays: Number(s.keepDays) || 0, maxBytes };
    }

    // Удалить все полученные файлы (записи в истории остаются, с пометкой «удалён»)
    async function deleteFiles() {
      if (blobs) await blobs.clear().catch(() => {});
      await serial(async () => {
        const cur = await load();
        for (const h of cur.history) if (h.file && !h.file.inline && !h.file.gone && !(h.kind === "text" && typeof h.text === "string")) {
          h.status = "gone"; h.gone = "manual"; h.file.gone = true; delete h.file.key; delete h.file.url;
        }
        await kv.setMany({ history: cur.history });
      });
    }

    // Текст присланной записи (короткий — из списка, длинный — из хранилища файлов)
    async function getText(id) {
      const s = await load();
      const h = s.history.find((x) => x.id === id);
      if (!h) return null;
      if (typeof h.text === "string") return h.text;
      const b = blobs ? await blobs.get(id) : null;
      return b ? new TextDecoder().decode(new Uint8Array(await b.arrayBuffer())) : null;
    }

    async function clearHistory() {
      await serial(() => kv.setMany({ history: [], sent: [] }));
      if (blobs) await blobs.clear().catch(() => {});
    }

    return {
      pair, peek, hello, maybeHello, rename, removeDevice, leave,
      sendLink, sendText, sendFile, fetchFile, getFile, getText, resend, markOpened,
      cleanup, maybeCleanup, setKeepDays, storageStats, deleteFiles, markAllRead, unreadCount, handle, poll, wsUrl, inboxTopic, info, clearHistory, serial
    };
  }

  // Сравнить версии «3.5.0» и «3.10» (по числам)
  function cmpVersion(a, b) {
    const x = String(a || "").split(".").map(Number), y = String(b || "").split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  // Расширение на компьютере старше 3.5 (тогда версия не передаётся вовсе) —
  // текст и картинки могут не доходить или идти долго: стоит обновить.
  const MIN_PC_VERSION = "3.5.0";
  const pcOutdated = (d) => Boolean(d) && d.kind === "pc" && (!d.vr || cmpVersion(d.vr, MIN_PC_VERSION) < 0);

  g.TBCore = { create, randId, cmpVersion, pcOutdated, MIN_PC_VERSION };
})(globalThis);
