"""Lecture Shorts web app: REST API + the built frontend.

    uvicorn server.app:app --port 8000
"""
import json
import shutil
import time
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from shorts.captions import PRESETS
from shorts.pipeline import ShortOptions, estimate, make_short
from shorts.transcribe import load_words, transcribe, words_path

from . import media, store
from .jobs import Jobs

app = FastAPI(title="Lecture Shorts")
jobs = Jobs()
WEB = Path(__file__).resolve().parent.parent / "web" / "dist"


@app.exception_handler(KeyError)
async def _missing(_, exc):
    return JSONResponse({"detail": f"not found: {exc}"}, status_code=404)


# ---------- models ----------

class UrlIn(BaseModel):
    url: str
    language: str | None = "ar"


class LocalIn(BaseModel):
    path: str
    language: str | None = "ar"


class ShortIn(BaseModel):
    name: str = "Untitled short"
    ranges: list[list[float]] = Field(default_factory=list)
    title: str | None = None
    style: str = "box"
    style_data: dict | None = None
    min_gap: float = 0.40
    transition: str = "morph"
    transition_frames: int = 4
    zoom: float = 1.0
    grade: bool = False
    captions: bool = True


class PreviewIn(BaseModel):
    t: float
    style: str = "box"
    style_data: dict | None = None
    title: str | None = None
    zoom: float = 1.0
    captions: bool = True


class CutPreviewIn(ShortIn):
    pause: list[float]  # [start, end] of the removed pause, source seconds


class StyleIn(BaseModel):
    name: str
    data: dict


# ---------- helpers ----------

def _style_data(style: str, style_data: dict | None) -> dict:
    if style_data:
        return style_data
    custom = store.list_styles()
    if style in custom:
        return custom[style]
    return {"base": style if style in PRESETS else "box"}


def _options(lecture: dict, s: dict) -> ShortOptions:
    return ShortOptions(
        ranges=[(float(a), float(b)) for a, b in s["ranges"]], title=s.get("title") or None,
        style_data=_style_data(s.get("style", "box"), s.get("style_data")),
        min_gap=s["min_gap"], transition=s["transition"], transition_frames=s["transition_frames"],
        zoom=s["zoom"], grade=s["grade"], captions=s["captions"], language=lecture.get("language"))


def _analyze_job(lid: str) -> dict:
    store.update_lecture(lid, status="analyzing")

    def run(report):
        try:
            return media.analyze(lid, report)
        except Exception:
            store.update_lecture(lid, status="error")
            raise
    return jobs.submit("analyze", run, lecture_id=lid)


def _lecture_out(meta: dict) -> dict:
    lid = meta["id"]
    job = jobs.active(lecture_id=lid)
    return {**meta, "job": job, "shorts": len(store.list_shorts(lid)),
            "has_transcript": words_path(store.lecture_dir(lid) / meta["source"]).exists()}


# ---------- lectures ----------

@app.get("/api/lectures")
def lectures():
    return [_lecture_out(m) for m in store.list_lectures()]


@app.post("/api/lectures/url")
def import_url(body: UrlIn):
    meta = store.new_lecture(body.url, "source.mp4", body.language)
    lid = meta["id"]

    def run(report):
        try:
            res = media.download(body.url, lid, report)
        except Exception:
            store.update_lecture(lid, status="error")
            raise
        _analyze_job(lid)
        return res
    jobs.submit("download", run, lane="io", lecture_id=lid)
    return _lecture_out(store.get_lecture(lid))


@app.post("/api/lectures/upload")
def import_upload(file: UploadFile = File(...), language: str = Form("ar")):
    ext = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    meta = store.new_lecture(Path(file.filename or "Lecture").stem, f"source{ext}", language or None)
    with open(store.lecture_dir(meta["id"]) / meta["source"], "wb") as f:
        shutil.copyfileobj(file.file, f, length=8 << 20)
    _analyze_job(meta["id"])
    return _lecture_out(store.get_lecture(meta["id"]))


@app.post("/api/lectures/local")
def import_local(body: LocalIn):
    src = Path(body.path).expanduser().resolve()
    if not src.is_file():
        raise HTTPException(400, f"no such file: {src}")
    meta = store.new_lecture(src.stem, f"source{src.suffix.lower()}", body.language)
    (store.lecture_dir(meta["id"]) / meta["source"]).symlink_to(src)
    # reuse a transcript made with the CLI next to the original file
    if words_path(src).exists():
        shutil.copy(words_path(src), words_path(store.source_path(meta["id"])))
        store.update_lecture(meta["id"], transcript="ready")
    _analyze_job(meta["id"])
    return _lecture_out(store.get_lecture(meta["id"]))


@app.get("/api/lectures/{lid}")
def lecture(lid: str):
    return _lecture_out(store.get_lecture(lid))


@app.delete("/api/lectures/{lid}")
def delete_lecture(lid: str):
    shutil.rmtree(store.lecture_dir(lid), ignore_errors=True)
    return {"ok": True}


@app.get("/api/lectures/{lid}/video")
def lecture_video(lid: str):
    return FileResponse(media.playback_path(lid))


@app.get("/api/lectures/{lid}/thumb")
def lecture_thumb(lid: str):
    p = store.lecture_dir(lid) / "thumb.jpg"
    if not p.exists():
        raise HTTPException(404, "no thumbnail yet")
    return FileResponse(p)


@app.get("/api/lectures/{lid}/waveform")
def lecture_waveform(lid: str):
    p = store.lecture_dir(lid) / "waveform.json"
    if not p.exists():
        raise HTTPException(404, "not analyzed yet")
    return FileResponse(p, media_type="application/json")


@app.get("/api/lectures/{lid}/speech")
def lecture_speech(lid: str):
    p = store.lecture_dir(lid) / "speech.json"
    if not p.exists():
        raise HTTPException(404, "not analyzed yet")
    return FileResponse(p, media_type="application/json")


@app.get("/api/lectures/{lid}/transcript")
def lecture_transcript(lid: str):
    data = media.transcript(lid)
    if data is None:
        raise HTTPException(404, "no transcript")
    return data


@app.post("/api/lectures/{lid}/transcribe")
def lecture_transcribe(lid: str):
    meta = store.get_lecture(lid)
    running = jobs.active(lecture_id=lid, kind="transcribe")
    if running:
        return running
    store.update_lecture(lid, transcript="running")

    def run(report):
        report(stage="transcribing")
        try:
            transcribe(store.source_path(lid), language=meta.get("language"),
                       on_progress=lambda f: report(progress=f))
        except Exception:
            store.update_lecture(lid, transcript="none")
            raise
        store.update_lecture(lid, transcript="ready")
    return jobs.submit("transcribe", run, lecture_id=lid)


@app.post("/api/lectures/{lid}/estimate")
def lecture_estimate(lid: str, body: ShortIn):
    if not body.ranges:
        return {"selected": 0, "duration": 0, "cuts": 0, "segments": []}
    meta = store.get_lecture(lid)
    src = store.source_path(lid)
    words = load_words(src) if words_path(src).exists() else []
    return estimate(src, _options(meta, body.model_dump()), words)


@app.post("/api/lectures/{lid}/preview")
def lecture_preview(lid: str, body: PreviewIn):
    jpg = media.preview_frame(lid, body.t, _style_data(body.style, body.style_data),
                              body.title, body.zoom, body.captions)
    return Response(jpg, media_type="image/jpeg")


@app.get("/api/lectures/{lid}/speaker")
def lecture_speaker(lid: str):
    return media.speaker_track(lid)


@app.post("/api/lectures/{lid}/preview-cut")
def lecture_preview_cut(lid: str, body: CutPreviewIn):
    """Exact render of ~2.5 s around one pause cut, to judge the transition."""
    meta = store.get_lecture(lid)
    a, b = body.pause
    settings = body.model_dump()
    settings["ranges"] = [[max(0.0, a - 1.2), b + 1.2]]
    out = store.lecture_dir(lid) / "tmp" / f"cut-{store.new_id()}.mp4"
    try:
        make_short(store.source_path(lid), out, _options(meta, settings), log=lambda m: None)
        data = out.read_bytes()
    finally:
        out.unlink(missing_ok=True)
    return Response(data, media_type="video/mp4")


# ---------- shorts ----------

@app.get("/api/lectures/{lid}/shorts")
def shorts(lid: str):
    return [_short_out(s) for s in store.list_shorts(lid)]


def _short_out(s: dict) -> dict:
    job = jobs.active(short_id=s["id"])
    rendered = store.render_path(s["lecture_id"], s["id"]).exists()
    return {**s, "job": job, "rendered": rendered}


@app.post("/api/lectures/{lid}/shorts")
def create_short(lid: str, body: ShortIn):
    store.get_lecture(lid)
    s = {"id": store.new_id(), "lecture_id": lid, "created": time.time(), **body.model_dump()}
    return _short_out(store.save_short(s))


@app.get("/api/lectures/{lid}/shorts/{sid}")
def get_short(lid: str, sid: str):
    return _short_out(store.get_short(lid, sid))


@app.put("/api/lectures/{lid}/shorts/{sid}")
def update_short(lid: str, sid: str, body: ShortIn):
    s = store.get_short(lid, sid)
    s.update(body.model_dump(), updated=time.time())
    return _short_out(store.save_short(s))


@app.delete("/api/lectures/{lid}/shorts/{sid}")
def delete_short(lid: str, sid: str):
    store.delete_short(lid, sid)
    return {"ok": True}


@app.post("/api/lectures/{lid}/shorts/{sid}/render")
def render_short(lid: str, sid: str):
    meta = store.get_lecture(lid)
    s = store.get_short(lid, sid)
    if not s["ranges"]:
        raise HTTPException(400, "this short has no ranges yet")
    running = jobs.active(short_id=sid)
    if running:
        return running
    opts = _options(meta, s)
    out = store.render_path(lid, sid)

    def run(report):
        tmp = out.with_suffix(".part.mp4")
        res = make_short(store.source_path(lid), tmp, opts,
                         progress=lambda stage, f: report(progress=f, stage=stage),
                         log=lambda m: report(message=m))
        tmp.replace(out)
        s2 = store.get_short(lid, sid)
        s2["last_render"] = {**res, "at": time.time()}
        store.save_short(s2)
        return res
    return jobs.submit("render", run, lecture_id=lid, short_id=sid, name=s["name"])


@app.get("/api/lectures/{lid}/shorts/{sid}/video")
def short_video(lid: str, sid: str, download: bool = False):
    p = store.render_path(lid, sid)
    if not p.exists():
        raise HTTPException(404, "not rendered yet")
    name = store.get_short(lid, sid)["name"]
    return FileResponse(p, media_type="video/mp4",
                        filename=f"{name}.mp4" if download else None)


# ---------- jobs & styles ----------

@app.get("/api/jobs")
def list_jobs(lecture_id: str | None = None):
    return jobs.list(**({"lecture_id": lecture_id} if lecture_id else {}))[:50]


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    return jobs.get(jid)


@app.get("/api/styles")
def styles():
    return {"presets": {k: asdict(v) for k, v in PRESETS.items()}, "custom": store.list_styles()}


@app.post("/api/styles")
def save_style(body: StyleIn):
    try:
        store.save_style(body.name, body.data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ---------- frontend ----------

if WEB.exists():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = WEB / path
        if path and f.is_file() and WEB in f.resolve().parents:
            return FileResponse(f)
        # never cache the page itself, so a rebuilt frontend shows up on reload
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
