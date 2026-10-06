// Tab Bridge — сквозное шифрование. Один и тот же файл используется
// в расширении и на веб-странице для телефона.
//
// Схема:
//   секрет группы (130 бит, генерируется случайно, хранится только на ваших устройствах)
//     └─ HKDF-SHA256 ─┬─ ключ AES-256-GCM  (шифрует содержимое)
//                     └─ имя темы ntfy     (по нему нельзя восстановить ключ)
//   Сообщение = "tb2:" + base64( iv[12] | AES-GCM(дополненный JSON) ),
//   имя темы — дополнительные аутентифицированные данные (AAD).
//   Сервер видит только шифротекст одинаковой «блочной» длины.
//   Подделать или изменить сообщение без секрета нельзя — GCM его отбросит.

(function (g) {
  "use strict";

  const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 символа → 5 бит на символ
  const SECRET_LEN = 26;      // 130 бит
  const MIN_SECRET_LEN = 20;  // для введённого вручную
  const PREFIX = "tb2:";
  const PAD_BLOCK = 256;      // длина открытого текста округляется до 256 байт
  const MAX_BODY = 2600;      // чтобы сообщение влезло в лимит ntfy (4096 байт)
  const MAX_URL = 2400;
  const SALT = "tab-bridge/v2";

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = g.crypto && g.crypto.subtle;

  function toB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function generateSecret() {
    const b = g.crypto.getRandomValues(new Uint8Array(SECRET_LEN));
    return Array.from(b, (x) => ALPHABET[x & 31]).join("");
  }

  function normalizeSecret(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // Возвращает текст ошибки или "" если секрет годится.
  function checkSecret(s) {
    const n = normalizeSecret(s);
    if (n.length < MIN_SECRET_LEN) return `Ключ слишком короткий: нужно не меньше ${MIN_SECRET_LEN} букв и цифр.`;
    if (new Set(n).size < 8) return "Ключ слишком простой. Нажмите «Новый», чтобы создать случайный.";
    return "";
  }

  function formatSecret(s) {
    const n = normalizeSecret(s);
    return (n.match(/.{1,4}/g) || []).join("-");
  }

  function isSafeUrl(u) {
    if (typeof u !== "string" || u.length > MAX_URL) return false;
    try {
      const x = new URL(u);
      return x.protocol === "https:" || x.protocol === "http:";
    } catch {
      return false;
    }
  }

  const groupCache = new Map();
  function deriveGroup(secret) {
    const n = normalizeSecret(secret);
    if (checkSecret(n)) return Promise.reject(new Error(checkSecret(n)));
    if (!subtle) return Promise.reject(new Error("Браузер не поддерживает шифрование (нужен HTTPS)."));
    if (!groupCache.has(n)) {
      groupCache.set(n, (async () => {
        const ikm = await subtle.importKey("raw", enc.encode(n), "HKDF", false, ["deriveKey", "deriveBits"]);
        const salt = enc.encode(SALT);
        const key = await subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("aes-gcm-key") },
          ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
        const bits = new Uint8Array(await subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("ntfy-topic") }, ikm, 128
        ));
        const topic = "tb2-" + Array.from(bits, (b) => b.toString(16).padStart(2, "0")).join("");
        return { topic, key, ikm };
      })());
    }
    return groupCache.get(n);
  }

  async function encrypt(group, obj) {
    const body = enc.encode(JSON.stringify(obj));
    if (body.length > MAX_BODY) throw new Error("Сообщение слишком длинное.");
    const total = Math.ceil((body.length + 2) / PAD_BLOCK) * PAD_BLOCK;
    const pt = new Uint8Array(total); // хвост — нули
    pt[0] = body.length >> 8;
    pt[1] = body.length & 255;
    pt.set(body, 2);
    const iv = g.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(group.topic) }, group.key, pt
    ));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return PREFIX + toB64(out);
  }

  async function decrypt(group, text) {
    if (typeof text !== "string" || !text.startsWith(PREFIX) || text.length > 6000) return null;
    try {
      const raw = fromB64(text.slice(PREFIX.length));
      if (raw.length < 12 + 16 + 2) return null;
      const iv = raw.subarray(0, 12);
      const pt = new Uint8Array(await subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(group.topic) }, group.key, raw.subarray(12)
      ));
      const len = (pt[0] << 8) | pt[1];
      if (len > pt.length - 2) return null;
      return { obj: JSON.parse(dec.decode(pt.subarray(2, 2 + len))), nonce: toB64(iv) };
    } catch {
      return null; // чужой ключ, подделка или повреждение — молча отбрасываем
    }
  }

  // Упаковать ссылку для отправки.
  async function sealLink(group, { url, title, from, device }) {
    if (!isSafeUrl(url)) throw new Error("Передавать можно только http/https-ссылки (не длиннее 2400 символов).");
    const obj = {
      v: 2,
      u: url,
      t: String(title || "").slice(0, 300),
      f: String(from || "").slice(0, 60),
      d: String(device || ""),
      ts: Math.floor(Date.now() / 1000)
    };
    if (enc.encode(JSON.stringify(obj)).length > MAX_BODY) {
      obj.t = "";
      if (enc.encode(JSON.stringify(obj)).length > MAX_BODY) throw new Error("Ссылка слишком длинная для передачи.");
    }
    return encrypt(group, obj);
  }

  // Распаковать и проверить пришедшее сообщение. null — отбросить.
  async function openLink(group, text) {
    const r = await decrypt(group, text);
    if (!r) return null;
    const o = r.obj;
    if (!o || o.v !== 2 || !isSafeUrl(o.u) || typeof o.ts !== "number") return null;
    return {
      url: o.u,
      title: String(o.t || "").slice(0, 300) || o.u,
      from: String(o.f || "").slice(0, 60),
      device: String(o.d || ""),
      ts: o.ts,
      nonce: r.nonce
    };
  }

  // Личная тема устройства (например "inbox:<id>"). По ней нельзя восстановить ни ключ, ни id.
  const topicCache = new Map();
  function topicFor(group, label) {
    const k = group.topic + "|" + label;
    if (!topicCache.has(k)) {
      topicCache.set(k, (async () => {
        const bits = new Uint8Array(await subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: enc.encode(SALT), info: enc.encode("topic:" + label) }, group.ikm, 128
        ));
        return "tb2-" + Array.from(bits, (b) => b.toString(16).padStart(2, "0")).join("");
      })());
    }
    return topicCache.get(k);
  }

  // Универсальные сообщения протокола (ссылка, «привет», «удалить», «доставлено»).
  async function seal(group, obj) {
    const o = Object.assign({}, obj, { v: 2, ts: Math.floor(Date.now() / 1000) });
    if (typeof o.t === "string" && enc.encode(JSON.stringify(o)).length > MAX_BODY) o.t = "";
    return encrypt(group, o);
  }

  async function open(group, text) {
    const r = await decrypt(group, text);
    if (!r || !r.obj || typeof r.obj !== "object" || r.obj.v !== 2 || typeof r.obj.ts !== "number") return null;
    return r;
  }

  // Найти ссылку в произвольном тексте (для «Поделиться» на телефоне).
  function extractUrl(text) {
    const m = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
    const u = m ? m[0].replace(/[),.;!?]+$/, "") : "";
    return isSafeUrl(u) ? u : "";
  }

  g.TBCrypto = Object.freeze({
    generateSecret, normalizeSecret, checkSecret, formatSecret,
    deriveGroup, sealLink, openLink, isSafeUrl, extractUrl, topicFor, seal, open,
    MAX_CLOCK_SKEW: 600 // сек: допустимое расхождение времени отправителя и сервера
  });
})(globalThis);
