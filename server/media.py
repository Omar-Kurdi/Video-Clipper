"""Media work for the web app: import, analysis for the timeline, live previews."""
import json
import re
import subprocess
import threading
from functools import lru_cache
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

from shorts.captions import Overlay, chunk, style_from_dict
from shorts.reframe import DETECT_WIDTH, _detector, crop_size
from shorts.render import compose
from shorts.transcribe import load_words, words_path
from shorts.util import encode_args

from . import store

PEAKS_PER_SEC = 20
BROWSER_CODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_FORMATS = ("mp4", "mov", "webm", "matroska")  # ffprobe format_name fragments


def ffprobe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration,format_name",
         "-of", "json", str(path)], check=True, capture_output=True, text=True).stdout
    d = json.loads(out)
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    num, den = (int(x) for x in v["avg_frame_rate"].split("/"))
    return {"duration": float(d["format"]["duration"]), "width": v["width"], "height": v["height"],
            "fps": round(num / den, 3) if den else 0, "codec": v["codec_name"],
            "format": d["format"]["format_name"],
            "has_audio": any(s["codec_type"] == "audio" for s in d["streams"])}


# ---------- import ----------

def download(url: str, lid: str, report) -> dict:
    d = store.lecture_dir(lid)
    title = subprocess.run(["yt-dlp", "--no-playlist", "--print", "%(title)s", "--skip-download", url],
                           capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
    store.update_lecture(lid, title=title)
    proc = subprocess.Popen(
        ["yt-dlp", "--no-playlist", "--newline", "-f",
         "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=1080]+ba/b",
         "--merge-output-format", "mp4", "-o", str(d / "source.%(ext)s"), url],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    pct = re.compile(r"\[download\]\s+([\d.]+)%")
    for line in proc.stdout:
        m = pct.search(line)
        if m:
            report(progress=float(m.group(1)) / 100, stage="downloading")
    if proc.wait() != 0:
        raise RuntimeError("yt-dlp failed")
    src = next(p for p in d.glob("source.*") if p.suffix not in (".part", ".ytdl", ".json"))
    store.update_lecture(lid, source=src.name)
    return {"title": title}


# ---------- analysis ----------

def _waveform(src: Path, duration: float) -> list[int]:
    sr = 8000
    hop = sr // PEAKS_PER_SEC
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(src), "-ac", "1", "-ar", str(sr),
                             "-f", "s16le", "-"], stdout=subprocess.PIPE)
    peaks, rest = [], np.zeros(0, dtype=np.int16)
    while True:
        buf = proc.stdout.read(hop * 2 * 2000)
        if not buf:
            break
        x = np.concatenate([rest, np.frombuffer(buf, dtype=np.int16)])
        n = len(x) // hop
        if n:
            peaks.append(np.abs(x[:n * hop].reshape(n, hop).astype(np.int32)).max(axis=1))
        rest = x[n * hop:]
    proc.wait()
    p = np.concatenate(peaks) if peaks else np.zeros(1)
    ref = max(1.0, float(np.percentile(p, 99)))
    return [int(v) for v in np.clip(p / ref * 100, 0, 100).round()]


def _speech(src: Path) -> list[list[float]]:
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio = decode_audio(str(src), sampling_rate=16000)
    spans = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=150, speech_pad_ms=0,
                                                    min_speech_duration_ms=120))
    return [[round(s["start"] / 16000, 3), round(s["end"] / 16000, 3)] for s in spans]


def analyze(lid: str, report) -> dict:
    src = store.source_path(lid)
    d = store.lecture_dir(lid)
    report(progress=0.02, stage="probing")
    info = ffprobe(src)
    store.update_lecture(lid, **info)

    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{info['duration'] * 0.1:.2f}", "-i", str(src),
                    "-frames:v", "1", "-vf", "scale=480:-2", str(d / "thumb.jpg")], check=True)

    playable = info["codec"] in BROWSER_CODECS and any(f in info["format"] for f in BROWSER_FORMATS)
    if not playable:
        report(progress=0.1, stage="making a browser preview")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", "scale=-2:720",
                        *encode_args(28), "-c:a", "aac", "-b:a", "128k",
                        "-movflags", "+faststart", str(d / "proxy.mp4")], check=True)

    report(progress=0.4, stage="reading the audio")
    (d / "waveform.json").write_text(json.dumps({"rate": PEAKS_PER_SEC,
                                                 "peaks": _waveform(src, info["duration"])}))
    report(progress=0.7, stage="finding pauses")
    (d / "speech.json").write_text(json.dumps(_speech(src)))
    report(progress=0.85, stage="finding the lecturer and cameras")
    cameras(lid)
    store.update_lecture(lid, status="ready")
    return info


def cameras_path(lid: str) -> Path:
    return store.lecture_dir(lid) / "source.cameras.json"


def cameras(lid: str, report=None) -> dict:
    """Camera positions + lecturer identity (analysed once, cached)."""
    from shorts.cameras import load_or_analyze

    return load_or_analyze(store.source_path(lid), cameras_path(lid),
                           (lambda f: report(progress=f)) if report else None,
                           thumbs=store.lecture_dir(lid) / "cameras")


def save_cameras(lid: str, data: dict) -> None:
    cameras_path(lid).write_text(json.dumps(data))


def framing_track(lid: str) -> list[list[float]] | None:
    """[time, x, y] of the intended framing (manual > lecturer > camera > centre)
    for every analysed sample: what the in-browser preview should show."""
    p = cameras_path(lid)
    if not p.exists():
        return None
    data = json.loads(p.read_text())
    by_id = {c["id"]: c for c in data["cameras"]}
    out = []
    for t, cid, x, y in data["samples"]:
        cam = by_id.get(cid, {})
        if cam.get("manual"):
            fx, fy = cam["manual"]["x"], cam["manual"].get("y", 0.36)
        elif x is not None:
            fx, fy = x, y
        elif cam.get("auto"):
            fx, fy = cam["auto"]["x"], cam["auto"]["y"]
        else:
            fx, fy = 0.5, 0.4
        out.append([t, fx, fy, cid, cam.get("zoom")])
    return out


def speaker_track(lid: str) -> list[list[float]]:
    """Coarse speaker position for in-browser previews: the main face on every
    keyframe, as [time, x, y] with x/y normalised to the frame. Cached."""
    track = framing_track(lid)
    if track is not None:
        return track
    cache = store.lecture_dir(lid) / "speaker.json"
    if cache.exists():
        return json.loads(cache.read_text())
    meta = store.get_lecture(lid)
    src = store.source_path(lid)
    w = DETECT_WIDTH
    h = round(meta["height"] * w / meta["width"]) // 2 * 2
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "info", "-skip_frame", "nokey", "-i", str(src), "-an",
         "-vf", f"scale={w}:{h},showinfo", "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    times: list[float] = []

    def read_err():
        for line in proc.stderr:
            m = re.search(rb"pts_time:([\d.]+)", line)
            if m:
                times.append(float(m.group(1)))
    t_err = threading.Thread(target=read_err, daemon=True)
    t_err.start()
    det = _detector(w, h)
    out, prev, k = [], None, 0
    size = w * h * 3
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
        _, faces = det.detect(frame)
        if faces is not None and len(faces):
            if prev is None:
                f = max(faces, key=lambda f: f[2] * f[3] * f[14])
            else:
                f = min(faces, key=lambda f: abs(f[0] + f[2] / 2 - prev) - f[2])
            prev = f[0] + f[2] / 2
            out.append((k, round(float(prev / w), 4), round(float((f[1] + f[3] / 2) / h), 4)))
        k += 1
    proc.wait()
    t_err.join(timeout=5)
    track = [[round(times[i], 3), x, y] for i, x, y in out if i < len(times)]
    cache.write_text(json.dumps(track))
    return track


def playback_path(lid: str) -> Path:
    proxy = store.lecture_dir(lid) / "proxy.mp4"
    return proxy if proxy.exists() else store.source_path(lid)


def edit_segment(lid: str, k: int, text: str | None) -> dict:
    """Replace the text of sentence k (None = revert to what was recognised).

    Timings are kept: with the same number of words each keeps its own; if the
    edit adds or removes words, the sentence's time span is shared out by
    word length. The recognised words are kept so the edit can be undone.
    """
    data = transcript(lid)
    if data is None:
        raise KeyError("transcript")
    segs, words = data["segments"], data["words"]
    seg = segs[k]
    old = words[seg["w0"]:seg["w1"]]
    if text is None:
        new = seg.pop("orig", old)
        seg.pop("edited", None)
    else:
        tokens = text.split()
        if not tokens:
            raise ValueError("a sentence can't be empty")
        seg.setdefault("orig", old)
        if len(tokens) == len(old):
            new = [{**w, "w": t} for w, t in zip(old, tokens)]
        else:
            s0, s1 = seg["s"], seg["e"]
            total = sum(len(t) + 1 for t in tokens)
            new, t = [], s0
            for tok in tokens:
                dur = (s1 - s0) * (len(tok) + 1) / total
                new.append({"w": tok, "s": round(t, 3), "e": round(t + dur * 0.92, 3)})
                t += dur
        seg["edited"] = True
    delta = len(new) - len(old)
    words[seg["w0"]:seg["w1"]] = new
    seg["w1"] += delta
    for later in segs[k + 1:]:
        later["w0"] += delta
        later["w1"] += delta
    words_path(store.source_path(lid)).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def transcript(lid: str) -> dict | None:
    src = store.source_path(lid)
    if not words_path(src).exists():
        return None
    data = json.loads(words_path(src).read_text(encoding="utf-8"))
    if "segments" not in data:  # older transcripts: rebuild sentences from gaps
        segs, start = [], 0
        ws = data["words"]
        for i in range(1, len(ws) + 1):
            if i == len(ws) or ws[i]["s"] - ws[i - 1]["e"] > 0.6 or i - start >= 14:
                segs.append({"s": ws[start]["s"], "e": ws[i - 1]["e"], "w0": start, "w1": i})
                start = i
        data["segments"] = segs
    return data


# ---------- live preview of one frame as a short ----------

def _frame_at(src: Path, t: float, w: int, h: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.uint8)[: w * h * 3].reshape(h, w, 3).copy()


@lru_cache(maxsize=1)
def _sface():
    from shorts.cameras import _recognizer
    return _recognizer()


def _framing_at(lid: str, frame: np.ndarray, W: int, H: int) -> tuple[float, float, float | None]:
    """Same choice as the render: the camera's manual framing, else the
    recognised lecturer, else the camera's usual framing, else the centre."""
    p = cameras_path(lid)
    if p.exists():
        from shorts.cameras import framing, identify, match_camera, signature

        data = json.loads(p.read_text())
        cam = match_camera(data, signature(frame))
        z = cam.get("zoom") if cam else None
        if cam and cam.get("manual"):
            return cam["manual"]["x"] * W, cam["manual"].get("y", 0.36) * H, z
        if data.get("reference"):
            hit = identify(frame, _detector(W, H), _sface(), np.array(data["reference"], dtype=np.float32))
            if hit:
                return hit[0] * W, hit[1] * H, z
        fr = framing(cam)
        return (fr[0] * W, fr[1] * H, z) if fr else (W / 2, H * 0.4, z)
    scale = DETECT_WIDTH / W
    _, faces = _detector(DETECT_WIDTH, round(H * scale)).detect(
        cv2.resize(frame, (DETECT_WIDTH, round(H * scale)), interpolation=cv2.INTER_AREA))
    if faces is not None and len(faces):
        f = max(faces, key=lambda f: f[2] * f[3] * f[14])
        return (f[0] + f[2] / 2) / scale, (f[1] + f[3] / 2) / scale, None
    return W / 2, H / 2, None


def preview_frame(lid: str, t: float, style_data: dict, title: str | None, zoom: float,
                  captions: bool) -> bytes:
    meta = store.get_lecture(lid)
    src = store.source_path(lid)
    W, H = meta["width"], meta["height"]
    frame = _frame_at(src, t, W, H)

    cx, cy, cam_zoom = _framing_at(lid, frame, W, H)
    ch, cw = crop_size(W, H, cam_zoom or zoom)
    x = int(np.clip(cx - cw / 2, 0, W - cw))
    y = int(np.clip(cy - 0.36 * ch, 0, H - ch))
    img = compose(frame[y:y + ch, x:x + cw])

    style = style_from_dict(style_data or {})
    chunks = []
    if captions:
        words = load_words(src) if words_path(src).exists() else []
        near = [(w["w"], w["s"], w["e"]) for w in words if t - 2 <= w["s"] <= t + 4]
        if not near:
            near = [("سولت", t, t + 0.4), ("لكم", t + 0.4, t + 0.7), ("انفسكم.", t + 0.7, t + 1.2)]
        chunks = chunk(near, style.captions)
        # show the chunk being spoken at t (or the first one)
        cur = next((c for c in chunks if c[0][1] <= t <= c[-1][2] + 0.3), chunks[0])
        t = max(t, cur[0][1] + 0.2)
        chunks = [cur]
    ov = Overlay(chunks, replace(style, captions=replace(style.captions, fade_ms=0)), title)
    ov.apply(img, t)
    ok, jpg = cv2.imencode(".jpg", cv2.resize(img, (540, 960), interpolation=cv2.INTER_AREA),
                           [cv2.IMWRITE_JPEG_QUALITY, 85])
    return jpg.tobytes()
