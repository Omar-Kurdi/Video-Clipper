"""Lecture-level camera analysis: which fixed camera positions the lecture
cuts between, who the lecturer is, and where to frame him in each camera.

Lectures are usually filmed with a few fixed cameras. Framing per *camera*
(instead of chasing the face frame by frame) keeps the lecturer in the same
spot every time a camera comes back. The lecturer is identified by face
recognition: the person whose face dominates the lecture (big, often) is the
reference, and in wide shots we pick the face that matches him, not the
biggest face (often someone in the audience).

Result (cameras.json):
  {"reference": [128 floats],
   "cameras": [{"id", "sig", "count", "share", "has_speaker",
                "auto": {"x","y","w"} | null,          # normalised face centre/width
                "manual": {"x","y"} | null}],          # user override, crop centre
   "samples": [[t, camera_id, x|null, y|null]]}
"""
import re
import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from .reframe import MODEL_PATH as DETECT_MODEL, _detector

SFACE_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_recognition_sface/face_recognition_sface_2021dec.onnx")
SFACE_PATH = DETECT_MODEL.parent / "face_recognition_sface_2021dec.onnx"

SIG_W, SIG_H = 32, 18
CAMERA_DIST = 20.0      # mean abs diff of blurred 32x18 thumbnails within one camera
SPEAKER_COS = 0.45      # SFace cosine similarity to count as the lecturer
MIN_GAP = 2.0           # seconds between analysed samples


def signature(frame: np.ndarray) -> np.ndarray:
    """Blurred thumbnail of the upper part of the frame (walls/background), which
    stays the same for a fixed camera while the audience below moves."""
    g = cv2.cvtColor(frame[: int(frame.shape[0] * 0.55)], cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(cv2.resize(g, (SIG_W * 4, SIG_H * 4), interpolation=cv2.INTER_AREA), (0, 0), 3)
    return cv2.resize(g, (SIG_W, SIG_H), interpolation=cv2.INTER_AREA).astype(np.float32)


def sig_dist(a, b) -> float:
    return float(np.mean(np.abs(np.asarray(a, np.float32) - np.asarray(b, np.float32))))


def _recognizer():
    if not SFACE_PATH.exists():
        SFACE_PATH.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(SFACE_URL, SFACE_PATH)
    return cv2.FaceRecognizerSF.create(str(SFACE_PATH), "")


def _keyframes(video: Path, w: int, h: int):
    """Yield (time, full-res frame) for keyframes only: fast even for AV1."""
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "info", "-skip_frame", "nokey", "-i", str(video), "-an",
         "-vf", "showinfo", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    times: list[float] = []
    ready = threading.Condition()

    def read_err():
        for line in proc.stderr:
            m = re.search(rb"pts_time:([\d.]+)", line)
            if m:
                with ready:
                    times.append(float(m.group(1)))
                    ready.notify_all()
        with ready:
            times.append(-1.0)  # end marker
            ready.notify_all()
    threading.Thread(target=read_err, daemon=True).start()
    size = w * h * 3
    k = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            with ready:
                ready.wait_for(lambda: len(times) > k, timeout=10)
                t = times[k] if len(times) > k else -1.0
            k += 1
            if t >= 0:
                yield t, np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
    finally:
        proc.kill()
        proc.wait()


def analyze(video: Path, width: int, height: int, duration: float,
            on_progress: Callable[[float], None] | None = None, thumbs: Path | None = None) -> dict:
    det = _detector(width, height)
    rec = _recognizer()
    samples = []  # (t, sig, faces[(x, y, w, score, feat)])
    frames_small = []  # downscaled frames, to pick a thumbnail per camera
    last = -1e9
    for t, frame in _keyframes(video, width, height):
        if t - last < MIN_GAP:
            continue
        last = t
        _, faces = det.detect(frame)
        found = []
        if faces is not None:
            # the biggest, most confident faces are enough to find the lecturer
            for f in sorted(faces, key=lambda f: -f[2] * f[14])[:12]:
                if f[2] < 16 or f[14] < 0.6:
                    continue
                feat = rec.feature(rec.alignCrop(frame, f)).flatten()
                feat /= np.linalg.norm(feat) + 1e-9
                found.append(((f[0] + f[2] / 2) / width, (f[1] + f[3] / 2) / height, f[2] / width,
                              float(f[14]), feat))
        samples.append((t, signature(frame), found))
        if thumbs is not None:
            frames_small.append(cv2.resize(frame, (480, round(480 * height / width)), interpolation=cv2.INTER_AREA))
        if on_progress and duration:
            on_progress(min(0.99, t / duration))

    # --- who is the lecturer: the identity with the most face area over time ---
    clusters: list[dict] = []
    for _, _, faces in samples:
        for x, y, w, score, feat in faces:
            best = max(clusters, key=lambda c: float(c["mean"] @ feat), default=None)
            if best is not None and float(best["mean"] @ feat) > 0.5:
                best["sum"] += feat
                best["mean"] = best["sum"] / np.linalg.norm(best["sum"])
                best["weight"] += w * w * score
            else:
                clusters.append({"sum": feat.copy(), "mean": feat.copy(), "weight": w * w * score})
    ref = max(clusters, key=lambda c: c["weight"])["mean"] if clusters else None

    # --- group samples into cameras by background signature ---
    cams: list[dict] = []
    assign = []
    for t, sig, faces in samples:
        best = min(cams, key=lambda c: sig_dist(c["sig"], sig), default=None)
        if best is not None and sig_dist(best["sig"], sig) < CAMERA_DIST:
            best["sig"] = best["sig"] * 0.9 + sig * 0.1
            best["members"].append(len(assign))
            cid = best["id"]
        else:
            cid = len(cams)
            cams.append({"id": cid, "sig": sig.copy(), "members": [len(assign)]})
        speaker = None
        if ref is not None and faces:
            x, y, w, _, feat = max(faces, key=lambda f: float(f[4] @ ref))
            if float(feat @ ref) >= SPEAKER_COS:
                speaker = (x, y, w)
        assign.append((t, cid, speaker))

    if thumbs is not None:
        thumbs.mkdir(parents=True, exist_ok=True)
        for c in cams:
            # prefer a frame where the lecturer was found
            pick = next((i for i in c["members"] if assign[i][2] is not None), c["members"][len(c["members"]) // 2])
            cv2.imwrite(str(thumbs / f"cam{c['id']}.jpg"), frames_small[pick], [cv2.IMWRITE_JPEG_QUALITY, 82])
    out_cams = []
    for c in cams:
        hits = [assign[i][2] for i in c["members"] if assign[i][2] is not None]
        has = len(hits) >= max(1, 0.3 * len(c["members"]))
        auto = None
        if has:
            xs, ys, ws = zip(*hits)
            auto = {"x": round(float(np.median(xs)), 4), "y": round(float(np.median(ys)), 4),
                    "w": round(float(np.median(ws)), 4)}
        out_cams.append({"id": c["id"], "sig": [int(v) for v in c["sig"].round().flatten()],
                         "count": len(c["members"]), "share": round(len(c["members"]) / max(1, len(samples)), 4),
                         "has_speaker": has, "auto": auto, "manual": None})
    if on_progress:
        on_progress(1.0)
    return {"reference": [round(float(v), 5) for v in ref] if ref is not None else None,
            "cameras": out_cams,
            "samples": [[round(float(t), 2), cid, *((round(float(sp[0]), 4), round(float(sp[1]), 4)) if sp else (None, None))]
                        for t, cid, sp in assign]}


def match_camera(cams: dict, sig: np.ndarray, max_dist: float = CAMERA_DIST * 1.5) -> dict | None:
    best = min(cams["cameras"], key=lambda c: sig_dist(np.array(c["sig"]).reshape(SIG_H, SIG_W), sig), default=None)
    if best is None or sig_dist(np.array(best["sig"]).reshape(SIG_H, SIG_W), sig) > max_dist:
        return None
    return best


def identify(frame: np.ndarray, det, rec, ref: np.ndarray) -> tuple[float, float, float] | None:
    """Normalised (x, y, sim) of the lecturer's face in a full-res frame, if present."""
    h, w = frame.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(frame)
    if faces is None:
        return None
    best = None
    for f in sorted(faces, key=lambda f: -f[2] * f[14])[:12]:
        if f[2] < 16 or f[14] < 0.6:
            continue
        feat = rec.feature(rec.alignCrop(frame, f)).flatten()
        sim = float(feat @ ref) / (np.linalg.norm(feat) + 1e-9)
        if sim >= SPEAKER_COS and (best is None or sim > best[2]):
            best = ((f[0] + f[2] / 2) / w, (f[1] + f[3] / 2) / h, sim)
    return best


def framing(cam: dict | None) -> tuple[float, float] | None:
    """Where this camera should be framed (crop centre x, face y), if known."""
    if cam is None:
        return None
    if cam.get("manual"):
        return cam["manual"]["x"], cam["manual"].get("y", (cam.get("auto") or {}).get("y", 0.36))
    if cam.get("auto"):
        return cam["auto"]["x"], cam["auto"]["y"]
    return None


def load_or_analyze(video: Path, cache: Path, on_progress: Callable[[float], None] | None = None,
                    thumbs: Path | None = None) -> dict:
    """Cached camera analysis."""
    import json

    if cache.exists():
        return json.loads(cache.read_text())
    from .util import probe

    info = probe(video)
    data = analyze(video, info.width, info.height, info.duration, on_progress, thumbs)
    cache.write_text(json.dumps(data))
    return data
