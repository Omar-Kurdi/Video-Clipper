"""Video Clipper web app: REST API + the built frontend.

    uvicorn server.app:app --port 8000
"""
import json
import os
import shutil
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

import cv2
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from shorts.captions import PRESETS
from shorts.pipeline import ShortOptions, estimate, make_short
from shorts.transcribe import load_words, release_whisper, transcribe, words_path
from shorts.translate import LANGS, translate
from shorts.translate import edit as edit_translation
from shorts.translate import load as load_translation

from . import media, publish, store
from .jobs import Jobs

app = FastAPI(title="Video Clipper")

# leave CPU for the desktop: OpenCV would otherwise use every core
cv2.setNumThreads(max(2, (os.cpu_count() or 4) // 2))

MIN_FREE_GB = 4.0


def _free_gb() -> float:
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024 / 1024
    except OSError:
        pass
    return 1e9


@app.on_event("startup")
def _cleanup() -> None:
    """Tidy up after an interrupted run (crash, reboot, server stopped mid-job):
    render work files, preview clips, and transcriptions left marked running."""
    for d in store.DATA.glob("lectures/*/renders/shorts-*"):
        shutil.rmtree(d, ignore_errors=True)
    for f in [*store.DATA.glob("lectures/*/renders/*.part.mp4"), *store.DATA.glob("lectures/*/tmp/*")]:
        f.unlink(missing_ok=True)
    for meta in store.list_lectures():
        if meta.get("transcript") == "running":  # no job survives a restart
            done = words_path(store.lecture_dir(meta["id"]) / meta["source"]).exists()
            store.update_lecture(meta["id"], transcript="ready" if done else "none")
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
    style: str = "pill"
    style_data: dict | None = None
    min_gap: float = 0.40
    transition: str = "morph"
    transition_frames: int = 4
    zoom: float = 1.0
    grade: bool = False
    captions: bool = True
    speed: float = Field(1.0, ge=0.5, le=2.0)  # export speed, voice pitch kept
    harakat: str = "all"  # tashkeel in captions: all | quran | none
    caption_lang: str = "original"  # or the language of a saved translation ("en", "ar")
    quran_tag: bool = True  # surah and ayah on screen while a Quran verse is quoted
    follow: str = "main"  # framing: "main" speaker, or cut to whoever is "talking"
    post: dict | None = None  # {"title", "description", "hashtags"} to publish the short with


class PreviewIn(BaseModel):
    t: float
    style: str = "pill"
    style_data: dict | None = None
    title: str | None = None
    zoom: float = 1.0
    captions: bool = True
    harakat: str = "all"
    caption_lang: str = "original"
    quran_tag: bool = True


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
    return {"base": style if style in PRESETS else "pill"}


def _options(lecture: dict, s: dict) -> ShortOptions:
    return ShortOptions(
        ranges=[(float(a), float(b)) for a, b in s["ranges"]], title=s.get("title") or None,
        style_data=_style_data(s.get("style", "pill"), s.get("style_data")),
        min_gap=s["min_gap"], transition=s["transition"], transition_frames=s["transition_frames"],
        zoom=s["zoom"], grade=s["grade"], captions=s["captions"], language=lecture.get("language"),
        speed=float(s.get("speed", 1.0)), harakat=s.get("harakat", "all"),
        caption_lang=s.get("caption_lang", "original"), quran_tag=s.get("quran_tag", True),
        follow=s.get("follow", "main"))


def _analyze_job(lid: str) -> dict:
    store.update_lecture(lid, status="analyzing")

    def run(report):
        try:
            return media.analyze(lid, report)
        except Exception:
            store.update_lecture(lid, status="error")
            raise
    return jobs.submit("analyze", run, lecture_id=lid)


def _disk(lid: str) -> dict:
    """Bytes the lecture's folder holds, and the original file it links to (if any)."""
    d = store.lecture_dir(lid)
    size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file() and not f.is_symlink())
    src = d / (store.get_lecture(lid).get("source") or "")
    linked = src.resolve() if src.is_symlink() and src.resolve().is_file() else None
    return {"bytes": size, "linked": str(linked) if linked else None,
            "linked_bytes": linked.stat().st_size if linked else 0}


def _lecture_out(meta: dict) -> dict:
    lid = meta["id"]
    job = jobs.active(lecture_id=lid)
    return {**meta, "job": job, "shorts": len(store.list_shorts(lid)),
            "has_transcript": words_path(store.lecture_dir(lid) / meta["source"]).exists(),
            "disk": _disk(lid)}


# ---------- lectures ----------

@app.get("/api/lectures")
def lectures():
    return [_lecture_out(m) for m in store.list_lectures()]


@app.post("/api/lectures/url")
def import_url(body: UrlIn):
    meta = store.new_lecture(body.url, "source.mp4", body.language)
    store.update_lecture(meta["id"], url=body.url)  # kept so a failed download can be tried again
    _download_job(meta["id"], body.url)
    return _lecture_out(store.get_lecture(meta["id"]))


def _download_job(lid: str, url: str) -> None:
    store.update_lecture(lid, status="importing")

    def run(report):
        try:
            res = media.download(url, lid, report)
        except Exception:
            store.update_lecture(lid, status="error")
            raise
        _analyze_job(lid)
        return res
    jobs.submit("download", run, lane="io", lecture_id=lid)


@app.post("/api/lectures/{lid}/retry")
def retry_import(lid: str):
    """Try a failed import again: download a link again, or analyse the video again."""
    meta = store.get_lecture(lid)
    if meta.get("status") != "error":
        raise HTTPException(409, "this video didn't fail")
    url = meta.get("url") or (meta["title"] if meta["title"].startswith(("http://", "https://")) else None)
    if url:
        _download_job(lid, url)
    elif store.source_path(lid).is_file():
        _analyze_job(lid)
    else:
        raise HTTPException(400, "the video file is gone; delete it from the library and add it again")
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


# what the command-line tool caches next to a video (also removed when the original is deleted)
SIDECARS = (".words.json", ".transcript.txt", ".cameras.json", ".cameras.npz", ".speaker.json")


@app.delete("/api/lectures/{lid}")
def delete_lecture(lid: str, original: bool = False):
    """Delete the lecture: its folder (video, renders, transcript, analysis).
    original=true also deletes the video file it links to on this computer,
    with the files the command-line tool keeps next to it."""
    running = jobs.active(lecture_id=lid)
    if running:
        raise HTTPException(409, f"wait for the {running['kind']} job to finish before deleting")
    freed = _disk(lid)
    if original and freed["linked"]:
        target = Path(freed["linked"])
        for f in [target] + [target.with_suffix(s) for s in SIDECARS] + list(target.parent.glob(target.stem + ".translation.*.json")):
            f.unlink(missing_ok=True)
    shutil.rmtree(store.lecture_dir(lid), ignore_errors=True)
    return {"ok": True, "freed": freed["bytes"] + (freed["linked_bytes"] if original else 0)}


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


class SegmentEditIn(BaseModel):
    text: str | None = None  # null = revert to the recognised text


@app.put("/api/lectures/{lid}/transcript/segments/{k}")
def edit_transcript_segment(lid: str, k: int, body: SegmentEditIn):
    try:
        return media.edit_segment(lid, k, body.text)
    except IndexError:
        raise HTTPException(404, "no such sentence")
    except ValueError as e:
        raise HTTPException(400, str(e))


class WordEditIn(BaseModel):
    text: str | None = None  # null = keep the word as recognised (clears the doubt mark)


@app.put("/api/lectures/{lid}/transcript/words/{i}")
def edit_transcript_word(lid: str, i: int, body: WordEditIn):
    try:
        return media.edit_word(lid, i, body.text)
    except IndexError:
        raise HTTPException(404, "no such word")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/lectures/{lid}/transcribe")
def lecture_transcribe(lid: str, engine: str = "tashkeel"):
    meta = store.get_lecture(lid)
    running = jobs.active(lecture_id=lid, kind="transcribe")
    if running:
        return running
    store.update_lecture(lid, transcript="running")

    def run(report):
        report(stage="transcribing")
        try:
            transcribe(store.source_path(lid), language=meta.get("language"),
                       on_progress=lambda f: report(progress=f), engine=engine, title=meta.get("title"))
        except Exception:
            store.update_lecture(lid, transcript="none")
            raise
        store.update_lecture(lid, transcript="ready")
    return jobs.submit("transcribe", run, lecture_id=lid)


@app.get("/api/lectures/{lid}/translation/{lang}")
def lecture_translation(lid: str, lang: str):
    data = load_translation(store.source_path(lid), lang)
    if data is None:
        raise HTTPException(404, "no translation")
    return data


class TranslationEditIn(BaseModel):
    text: str


@app.put("/api/lectures/{lid}/translation/{lang}/segments/{k}")
def edit_translation_segment(lid: str, lang: str, k: int, body: TranslationEditIn):
    data = media.transcript(lid)
    if data is None or not 0 <= k < len(data["segments"]):
        raise HTTPException(404, "no such sentence")
    g = data["segments"][k]
    source = " ".join(w["w"] for w in data["words"][g["w0"]:g["w1"]])
    try:
        return edit_translation(store.source_path(lid), lang, k, body.text, source)
    except IndexError:
        raise HTTPException(404, "no such sentence")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/features")
def features():
    from shorts.proofread import api_key
    return {"gemini": bool(api_key())}


@app.post("/api/lectures/{lid}/proofread")
def lecture_proofread(lid: str):
    running = jobs.active(lecture_id=lid, kind="proofread")
    if running:
        return running
    if media.transcript(lid) is None:
        raise HTTPException(400, "transcribe the video first")

    def run(report):
        report(stage="proofreading")
        return media.proofread(lid, lambda f: report(progress=f))
    return jobs.submit("proofread", run, lane="io", lecture_id=lid)


def _gemini(fn):
    from shorts.proofread import ProofreadError
    try:
        return fn()
    except ProofreadError as e:
        raise HTTPException(400, str(e))


@app.post("/api/lectures/{lid}/shorts/{sid}/describe")
def short_describe(lid: str, sid: str):
    """Gemini writes a title, description and hashtags from what the short says."""
    from shorts.writer import describe

    s = store.get_short(lid, sid)
    data = media.transcript(lid)
    if data is None:
        raise HTTPException(400, "transcribe the video first")
    if not s["ranges"]:
        raise HTTPException(400, "add a clip to the short first")
    lang = s.get("caption_lang") if s.get("caption_lang") not in (None, "original") else (data.get("language") or "ar")
    post = _gemini(lambda: describe(data, s["ranges"], store.get_lecture(lid).get("title"), lang))
    s["post"] = post
    return _short_out(store.save_short(s))


# ---------- posting to YouTube ----------

def _yt_redirect(request: Request) -> str:
    return str(request.base_url) + "api/publish/youtube/callback"


@app.get("/api/publish/youtube")
def youtube_status():
    return publish.status()


@app.get("/api/publish/youtube/connect")
def youtube_connect(request: Request):
    try:
        return RedirectResponse(publish.connect_url(_yt_redirect(request)))
    except publish.PublishError as e:
        raise HTTPException(400, str(e))


@app.get("/api/publish/youtube/callback")
def youtube_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    try:
        if error:
            raise publish.PublishError(f"Google sign-in was cancelled ({error})")
        st = publish.finish_connect(code, state, _yt_redirect(request))
        msg = f"Connected to {st['channel'] or 'your YouTube channel'}."
    except publish.PublishError as e:
        msg = f"Not connected: {e}"
    import html
    return HTMLResponse(f"<!doctype html><meta charset=utf-8><title>YouTube</title>"
                        f"<body style='font-family:system-ui;padding:40px'><p>{html.escape(msg)}</p>"
                        f"<p>You can close this tab and go back to Video Clipper.</p></body>")


@app.post("/api/publish/youtube/disconnect")
def youtube_disconnect():
    return publish.disconnect()


class PublishIn(BaseModel):
    privacy: str = Field("private", pattern="^(private|unlisted|public)$")
    publish_at: float | None = None  # unix time: goes up private, YouTube publishes it then


@app.post("/api/lectures/{lid}/shorts/{sid}/publish/youtube")
def short_publish_youtube(lid: str, sid: str, body: PublishIn):
    s = store.get_short(lid, sid)
    video = store.render_path(lid, sid)
    if not video.exists():
        raise HTTPException(400, "render the short first")
    post = s.get("post") or {}
    title = (post.get("title") or s.get("name") or "Short").strip()
    tags = post.get("hashtags") or []
    desc = "\n\n".join(x for x in [post.get("description", "").strip(), " ".join(f"#{h}" for h in tags + ["Shorts"])] if x)

    def run(report):
        report(stage="uploading to YouTube")
        out = publish.upload(video, title, desc, tags, body.privacy, body.publish_at, lambda f: report(progress=f))
        s2 = store.get_short(lid, sid)
        s2.setdefault("published", {})["youtube"] = {**out, "privacy": body.privacy, "publish_at": body.publish_at,
                                                     "at": time.time()}
        store.save_short(s2)
        return out
    return jobs.submit("publish", run, lane="io", lecture_id=lid, short_id=sid)


def _moments_path(lid: str) -> Path:
    return store.lecture_dir(lid) / "moments.json"


@app.get("/api/lectures/{lid}/moments")
def lecture_moments(lid: str):
    p = _moments_path(lid)
    return json.loads(p.read_text()) if p.exists() else {"moments": None}


@app.post("/api/lectures/{lid}/moments")
def suggest_moments(lid: str):
    """Gemini reads the transcript and suggests moments that stand on their own."""
    from shorts.writer import moments

    data = media.transcript(lid)
    if data is None:
        raise HTTPException(400, "transcribe the video first")
    found = _gemini(lambda: moments(data, store.get_lecture(lid).get("title")))
    out = {"moments": found, "at": time.time()}
    _moments_path(lid).write_text(json.dumps(out, ensure_ascii=False))
    return out


@app.post("/api/lectures/{lid}/translate")
def lecture_translate(lid: str, lang: str = "en"):
    running = jobs.active(lecture_id=lid, kind="translate")
    if running:
        return running
    data = media.transcript(lid)
    if data is None:
        raise HTTPException(400, "transcribe the video first")
    if lang not in LANGS or lang == (data.get("language") or "ar"):
        raise HTTPException(400, f"can't translate into {lang}")

    def run(report):
        report(stage="translating")
        release_whisper()  # the translation model needs the GPU memory
        translate(store.source_path(lid), data, lang, on_progress=lambda f: report(progress=f))
    return jobs.submit("translate", run, lecture_id=lid)


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
                              body.title, body.zoom, body.captions, body.harakat, body.caption_lang,
                              body.quran_tag)
    return Response(jpg, media_type="image/jpeg")


class FramingIn(BaseModel):
    manual: dict | None = None  # {"x": 0..1, "y": 0..1} crop centre / face height, or null for auto
    zoom: float | None = None   # this camera's own zoom, or null to use the short's


def _cameras_ready(lid: str) -> bool:
    p = media.cameras_path(lid)
    if not p.exists() or not p.with_suffix(".npz").exists():
        return False
    return json.loads(p.read_text()).get("version") == 2  # older analyses are redone


@app.get("/api/lectures/{lid}/cameras")
def lecture_cameras(lid: str, retry: bool = False):
    if not _cameras_ready(lid):
        job = jobs.active(lecture_id=lid, kind="cameras")
        if not job:
            last = next(iter(jobs.list(lecture_id=lid, kind="cameras")), None)
            if last and last["status"] == "error" and not retry:
                return {"status": "error", "message": last["message"], "cameras": []}
            job = jobs.submit("cameras", lambda report: (media.cameras(lid, report), None)[1], lecture_id=lid)
        return {"status": "analyzing", "job": job, "cameras": []}
    data = json.loads(media.cameras_path(lid).read_text())
    cams = [{k: v for k, v in c.items() if k not in ("sig", "sigs")} for c in data["cameras"]]
    return {"status": "ready", "has_lecturer": data.get("reference") is not None, "cameras": cams}


@app.put("/api/lectures/{lid}/cameras/{cid}")
def set_camera_framing(lid: str, cid: int, body: FramingIn):
    data = json.loads(media.cameras_path(lid).read_text())
    cam = next((c for c in data["cameras"] if c["id"] == cid), None)
    if cam is None:
        raise HTTPException(404, "no such camera")
    # only change what was sent
    if "manual" in body.model_fields_set:
        cam["manual"] = body.manual
    if "zoom" in body.model_fields_set:
        cam["zoom"] = None if body.zoom is None else max(0.6, min(1.6, float(body.zoom)))
    media.save_cameras(lid, data)
    return {k: v for k, v in cam.items() if k not in ("sig", "sigs")}


class FramingAtIn(BaseModel):
    t: float
    x: float  # crop centre in that frame, 0..1


@app.get("/api/lectures/{lid}/framing-at")
def get_framing_at(lid: str, t: float):
    """Which camera angle is on screen at t and how the render will frame it."""
    return media.framing_at(lid, t)


@app.put("/api/lectures/{lid}/framing-at")
def put_framing_at(lid: str, body: FramingAtIn):
    """Set the framing of the angle on screen at t (from the frame on the video)."""
    try:
        return media.set_framing_at(lid, body.t, body.x)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/lectures/{lid}/cameras/{cid}/thumb")
def camera_thumb(lid: str, cid: int):
    p = store.lecture_dir(lid) / "cameras" / f"cam{cid}.jpg"
    if not p.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(p)


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
    opts = _options(meta, settings)
    opts.identity = media.cameras(lid)
    try:
        make_short(store.source_path(lid), out, opts, log=lambda m: None)
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
    if _free_gb() < MIN_FREE_GB:
        raise HTTPException(503, f"Only {_free_gb():.1f} GB of memory is free; close some apps and try again "
                                 f"(rendering needs about {MIN_FREE_GB:.0f} GB).")
    opts = _options(meta, s)
    out = store.render_path(lid, sid)

    def run(report):
        if words_path(store.source_path(lid)).exists():
            media.transcript(lid)  # brings the Quran/hadith marks up to date before they're burned in
        report(stage="finding the speaker")
        opts.identity = media.cameras(lid)
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


@app.get("/api/lectures/{lid}/shorts/{sid}/thumb")
def short_thumb(lid: str, sid: str):
    """A frame of the rendered short (made once per render, kept next to it)."""
    p = store.render_path(lid, sid)
    if not p.exists():
        raise HTTPException(404, "not rendered yet")
    jpg = p.with_suffix(".jpg")
    if not jpg.exists() or jpg.stat().st_mtime < p.stat().st_mtime:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(p), "-frames:v", "1",
                        "-vf", "scale=180:-2", str(jpg)], check=True)
    return FileResponse(jpg)


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
