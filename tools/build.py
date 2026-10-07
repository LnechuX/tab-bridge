#!/usr/bin/env python3
"""Сборка архивов расширения для каталогов.

    python3 tools/build.py

Создаёт в dist/:
  tab-bridge-chromium-<версия>.zip — Opera add-ons, Chrome Web Store, Яндекс Браузер, Edge
  tab-bridge-firefox-<версия>.zip  — addons.mozilla.org (Firefox на ПК и Android)

Код не минифицируется и не меняется — только manifest.json подгоняется под браузер.
"""
import json, pathlib, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DIST = ROOT / "dist"
SKIP = {".DS_Store"}


def build(kind: str, manifest: dict) -> pathlib.Path:
    m = json.loads(json.dumps(manifest))
    if kind == "chromium":
        m.pop("browser_specific_settings", None)
        m["background"].pop("scripts", None)
    else:
        m["background"].pop("service_worker", None)
    out = DIST / f"tab-bridge-{kind}-{m['version']}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(SRC.rglob("*")):
            if f.is_dir() or f.name in SKIP or f.name.startswith("."):
                continue
            rel = f.relative_to(SRC).as_posix()
            if rel == "manifest.json":
                z.writestr(rel, json.dumps(m, ensure_ascii=False, indent=2) + "\n")
            else:
                z.write(f, rel)
    return out


if __name__ == "__main__":
    DIST.mkdir(exist_ok=True)
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    for kind in ("chromium", "firefox"):
        print(build(kind, manifest).relative_to(ROOT))
