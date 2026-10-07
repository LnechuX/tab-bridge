// Tab Bridge — уменьшение картинок перед отправкой (быстрее по мобильной сети).
// Скриншот iPhone 2–5 МБ → обычно 300–700 КБ, текст на нём остаётся чётким.
// Картинку не трогаем, если она и так небольшая или сжатие не помогло.
// Стараемся уложиться в одну часть (сервер ntfy.sh принимает вложения до 2 МБ).
(function (g) {
  "use strict";
  const MAX_SIDE = 3000;            // длинная сторона, пикселей (скриншоты iPhone остаются в родном размере)
  const QUALITY = 0.86;             // качество JPEG
  const SMALL = 900 * 1024;         // меньше — отправляем как есть
  const TARGET = 1800 * 1024;       // желательный размер после сжатия
  const MAX_PIXELS = 60e6;          // защита от «картинок-бомб» (огромное разрешение при малом размере файла)

  async function encode(bmp, side, quality) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";                     // у JPEG нет прозрачности — подложим белый фон
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    try {
      return canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/jpeg", quality })
        : await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    } catch { return null; }
  }

  async function image(file, name) {
    const orig = { blob: file, name, changed: false };
    if (!/^image\/(png|jpeg|webp|heic|heif)$/i.test(file.type || "")) return orig;   // GIF и прочее — как есть
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { return orig; }
    try {
      const side = Math.max(bmp.width, bmp.height);
      if (file.size <= SMALL && side <= MAX_SIDE) return orig;
      if (bmp.width * bmp.height > MAX_PIXELS) return orig;
      // сначала бережно; если файл всё ещё большой — сильнее
      let out = null;
      for (const [s, q] of [[MAX_SIDE, QUALITY], [MAX_SIDE, 0.75], [2400, 0.75], [1920, 0.7]]) {
        const b = await encode(bmp, s, q);
        if (b && (!out || b.size < out.size)) out = b;
        if (out && out.size <= TARGET) break;
      }
      if (!out || out.size >= file.size) return orig;
      return { blob: out, name: String(name || "image").replace(/\.(png|jpe?g|webp|heic|heif)$/i, "") + ".jpg", changed: true, before: file.size, after: out.size };
    } finally { bmp.close?.(); }
  }

  g.TBShrink = Object.freeze({ image });
})(globalThis);
