// Tab Bridge — уменьшение картинок перед отправкой (быстрее по мобильной сети).
// Скриншот iPhone 2–5 МБ → обычно 300–700 КБ, текст на нём остаётся чётким.
// Картинку не трогаем, если она и так небольшая или сжатие не помогло.
(function (g) {
  "use strict";
  const MAX_SIDE = 3000;            // длинная сторона, пикселей (скриншоты iPhone остаются в родном размере)
  const QUALITY = 0.86;             // качество JPEG
  const SMALL = 900 * 1024;         // меньше — отправляем как есть

  async function image(file, name) {
    const orig = { blob: file, name, changed: false };
    if (!/^image\/(png|jpeg|webp|heic|heif)$/i.test(file.type || "")) return orig;   // GIF и прочее — как есть
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { return orig; }
    const side = Math.max(bmp.width, bmp.height);
    if (file.size <= SMALL && side <= MAX_SIDE) { bmp.close?.(); return orig; }
    const k = Math.min(1, MAX_SIDE / side);
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";                     // у JPEG нет прозрачности — подложим белый фон
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    let out = null;
    try {
      out = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY })
        : await new Promise((r) => canvas.toBlob(r, "image/jpeg", QUALITY));
    } catch { out = null; }
    if (!out || out.size >= file.size) return orig;
    return { blob: out, name: String(name || "image").replace(/\.(png|jpe?g|webp|heic|heif)$/i, "") + ".jpg", changed: true, before: file.size, after: out.size };
  }

  g.TBShrink = Object.freeze({ image });
})(globalThis);
