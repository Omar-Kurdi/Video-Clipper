"""JSON-on-disk storage for lectures and shorts.

data/
  lectures/<id>/meta.json, source.<ext>, source.words.json, waveform.json,
                speech.json, thumb.jpg, proxy.mp4 (only if the browser can't play the source)
  lectures/<id>/shorts/<sid>.json
  lectures/<id>/renders/<sid>.mp4
  styles/<name>.json
"""
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

DATA = Path(os.environ.get("SHORTS_DATA", Path(__file__).resolve().parent.parent / "data"))
_ID = re.compile(r"^[a-f0-9]{12}$")
_STYLE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_lock = threading.Lock()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def check_id(i: str) -> str:
    if not _ID.match(i):
        raise KeyError(i)
    return i


def _read(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _write(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


# ---------- lectures ----------

def lecture_dir(lid: str) -> Path:
    return DATA / "lectures" / check_id(lid)


def list_lectures() -> list[dict]:
    root = DATA / "lectures"
    if not root.exists():
        return []
    out = [_read(m) for m in root.glob("*/meta.json")]
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


def get_lecture(lid: str) -> dict:
    p = lecture_dir(lid) / "meta.json"
    if not p.exists():
        raise KeyError(lid)
    return _read(p)


def save_lecture(meta: dict) -> dict:
    with _lock:
        _write(lecture_dir(meta["id"]) / "meta.json", meta)
    return meta


def update_lecture(lid: str, **fields) -> dict:
    with _lock:
        p = lecture_dir(lid) / "meta.json"
        meta = _read(p)
        meta.update(fields)
        _write(p, meta)
    return meta


def source_path(lid: str) -> Path:
    meta = get_lecture(lid)
    return lecture_dir(lid) / meta["source"]


def new_lecture(title: str, source_name: str, language: str | None) -> dict:
    lid = new_id()
    meta = {"id": lid, "title": title, "source": source_name, "language": language,
            "created": time.time(), "status": "importing", "transcript": "none"}
    lecture_dir(lid).mkdir(parents=True, exist_ok=True)
    return save_lecture(meta)


# ---------- shorts ----------

def _short_path(lid: str, sid: str) -> Path:
    return lecture_dir(lid) / "shorts" / f"{check_id(sid)}.json"


def list_shorts(lid: str) -> list[dict]:
    d = lecture_dir(lid) / "shorts"
    if not d.exists():
        return []
    return sorted((_read(p) for p in d.glob("*.json")), key=lambda s: s.get("created", 0))


def get_short(lid: str, sid: str) -> dict:
    p = _short_path(lid, sid)
    if not p.exists():
        raise KeyError(sid)
    return _read(p)


def save_short(short: dict) -> dict:
    with _lock:
        _write(_short_path(short["lecture_id"], short["id"]), short)
    return short


def delete_short(lid: str, sid: str) -> None:
    _short_path(lid, sid).unlink(missing_ok=True)
    render_path(lid, sid).unlink(missing_ok=True)


def render_path(lid: str, sid: str) -> Path:
    return lecture_dir(lid) / "renders" / f"{check_id(sid)}.mp4"


# ---------- custom styles ----------

def list_styles() -> dict[str, dict]:
    d = DATA / "styles"
    return {p.stem: _read(p) for p in sorted(d.glob("*.json"))} if d.exists() else {}


def save_style(name: str, data: dict) -> None:
    if not _STYLE.match(name):
        raise ValueError("style names may use letters, digits, - and _")
    _write(DATA / "styles" / f"{name}.json", data)
