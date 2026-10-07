// Tab Bridge — хранилище полученных файлов (скриншоты, длинный текст) на этом устройстве.
// IndexedDB; данные хранятся как ArrayBuffer + тип (так надёжнее в Safari, чем Blob).
(function (g) {
  "use strict";
  let dbp = null;
  function db() {
    dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open("tab-bridge-files", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const t = d.transaction("files", mode);
      const req = fn(t.objectStore("files"));
      t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    }));
  }
  g.TBBlobs = Object.freeze({
    async put(id, blob) {
      const data = await blob.arrayBuffer();
      await tx("readwrite", (s) => s.put({ type: blob.type || "application/octet-stream", data }, id));
    },
    async get(id) {
      const v = await tx("readonly", (s) => s.get(id));
      return v ? new Blob([v.data], { type: v.type }) : null;
    },
    del(id) { return tx("readwrite", (s) => s.delete(id)); },
    clear() { return tx("readwrite", (s) => s.clear()); }
  });
})(globalThis);
