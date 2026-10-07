// Просмотр присланного текста или файла (на компьютере).
// Картинки показываем только безопасных типов; всё остальное — только «Скачать».
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const id = decodeURIComponent(location.hash.slice(1));
const IMAGE = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function say(text, cls = "muted") { $("msg").textContent = text; $("msg").className = cls; }
function button(label, fn, primary) {
  const b = document.createElement("button");
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", fn);
  $("actions").append(b);
  return b;
}
function sizeText(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ"; }

async function toPng(blob) {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function render() {
  const { history = [] } = await api.storage.local.get("history");
  const h = history.find((x) => x.id === id);
  $("actions").textContent = "";
  $("stage").textContent = "";
  if (!h) { $("title").textContent = "Не найдено"; say("Этой записи уже нет в истории."); return; }

  const when = new Date(h.time * 1000).toLocaleString();
  $("meta").textContent = [h.from ? `От «${h.from}»` : "", when, h.file ? sizeText(h.file.size) : ""].filter(Boolean).join(", ");
  document.title = (h.kind === "text" ? "Текст" : h.title) + " — Tab Bridge";

  if (h.status === "loading") { $("title").textContent = "Скачиваю…"; setTimeout(render, 800); return; }
  if (h.status === "gone") {
    $("title").textContent = h.kind === "text" ? "Текст" : h.title;
    say(h.gone === "age" ? "Файл удалён автоматически: истёк срок хранения (настройка в «Устройства и настройки» → «Память»)."
      : h.gone === "space" ? "Файл удалён автоматически, чтобы освободить место для новых."
      : "Файл удалён с этого компьютера.", "muted");
    return;
  }
  if (h.status === "error") {
    $("title").textContent = h.kind === "text" ? "Текст не скачан" : h.title;
    say(h.error || "Не удалось скачать.", "err");
    button("Повторить", async () => { say("Скачиваю…"); await api.runtime.sendMessage({ type: "retry-file", id }); render(); }, true);
    return;
  }

  api.runtime.sendMessage({ type: "mark-opened", id }).catch(() => {});

  if (h.kind === "text") {
    $("title").textContent = "Текст";
    // короткий текст — в истории, длинный — в хранилище файлов
    if (typeof h.text !== "string") {
      const b = await TBBlobs.get(id);
      h.text = b ? new TextDecoder().decode(new Uint8Array(await b.arrayBuffer())) : "";
    }
    const pre = document.createElement("pre");
    pre.textContent = h.text || "";
    $("stage").append(pre);
    $("stage").hidden = false;
    button("Скопировать текст", async () => {
      try { await navigator.clipboard.writeText(h.text || ""); say("✓ Скопировано", "ok"); }
      catch { say("Не удалось скопировать — выделите текст и нажмите Ctrl+C.", "err"); }
    }, true);
    button("Сохранить как файл", () => download(new Blob([h.text || ""], { type: "text/plain" }), "Текст.txt"));
    return;
  }

  $("title").textContent = h.title;
  const blob = await TBBlobs.get(id);
  if (!blob) { say("Файл не найден на этом компьютере (возможно, история была очищена).", "err"); return; }
  if (IMAGE.includes(h.file.mime)) {
    const img = document.createElement("img");
    img.alt = h.title;
    img.src = URL.createObjectURL(blob);
    $("stage").append(img);
    $("stage").hidden = false;
    button("Скопировать картинку", async () => {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": await toPng(blob) })]); say("✓ Скопировано — можно вставить через Ctrl+V", "ok"); }
      catch { say("Не удалось скопировать. Нажмите «Скачать».", "err"); }
    }, true);
  }
  button("Скачать", () => download(blob, h.file.name), !IMAGE.includes(h.file.mime));
}

render();
