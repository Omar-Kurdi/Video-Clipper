"""Lecture-level camera analysis: which camera angles the lecture cuts
between, who the lecturer is, and where to frame him in each angle.

Framing per *camera angle* (instead of chasing the face frame by frame) keeps
the lecturer in the same spot every time an angle comes back. Two ideas make
that robust:

* Angles are recognised by matching the architecture in the picture (ORB
  features + a homography), not by comparing thumbnails, so a moving
  audience, a slight pan or a small zoom doesn't split one angle into many.
  Every frame gets a homography to its angle's reference frame, so a framing
  set on the reference (by dragging) lands on the same spot of the scene in
  every shot from that angle.
* The lecturer is identified by face recognition: the face that dominates the
  lecture is the reference, and in wide shots we pick the face that matches
  him, not the biggest face (often someone in the audience).

Result (<video>.cameras.json, plus feature arrays in <video>.cameras.npz):
  {"version": 2, "reference": [128 floats], "geo": [480, 270],
   "cameras": [{"id", "sigs", "count", "share", "has_speaker",
                "auto": {"x","y","w"} | null,   # lecturer, normalised, reference-frame coords
                "manual": {"x","y"} | null,     # user framing (crop centre), reference-frame coords
                "zoom": float | null}],
   "samples": [[t, camera_id, x|null, y|null, H|null]]}   # x,y in the sample's own frame
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
VERSION = 2
GEO_W = 480             # feature matching works on frames scaled to this width
MERGE_INLIERS = 40      # same angle: at least this many consistent feature matches
LOCATE_INLIERS = 25
MERGE_SCALE = (0.8, 1.25)   # clearly different zoom levels stay separate angles
LOCATE_SCALE = (0.5, 2.0)


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


_orb = None
_bf = None


def _features(gray: np.ndarray):
    global _orb, _bf
    if _orb is None:
        _orb = cv2.ORB_create(nfeatures=1200)
        _bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    return _orb.detectAndCompute(gray, None)


def _geo_gray(frame: np.ndarray, gw: int, gh: int) -> np.ndarray:
    return cv2.cvtColor(cv2.resize(frame, (gw, gh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)


def _homography(fa, fb, scale=LOCATE_SCALE):
    """Homography taking points of image a to image b, and its inlier count."""
    (ka, da), (kb, db) = fa, fb
    if da is None or db is None or len(ka) < 20 or len(kb) < 20:
        return None, 0
    if _bf is None:
        _features(np.zeros((8, 8), np.uint8))
    pairs = _bf.knnMatch(da, db, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < 15:
        return None, 0
    A = np.float32([ka[m.queryIdx].pt for m in good])
    B = np.float32([kb[m.trainIdx].pt for m in good])
    H, mask = cv2.findHomography(A, B, cv2.RANSAC, 4.0)
    if H is None:
        return None, 0
    sc = float(np.sqrt(abs(np.linalg.det(H[:2, :2]))))
    if not (scale[0] < sc < scale[1]) or abs(H[2, 0]) > 2e-3 or abs(H[2, 1]) > 2e-3:
        return None, 0
    return H, int(mask.sum())


def _apply(H, x: float, y: float, gw: int, gh: int) -> tuple[float, float]:
    """Map a normalised point through H (pixel homography in the gw x gh space)."""
    p = H @ np.array([x * gw, y * gh, 1.0])
    return float(p[0] / p[2] / gw), float(p[1] / p[2] / gh)


def to_frame(H, x: float, y: float, geo) -> tuple[float, float]:
    """Reference-frame point -> this frame (H maps this frame to the reference)."""
    return _apply(np.linalg.inv(np.asarray(H, float).reshape(3, 3)), x, y, *geo)


def to_reference(H, x: float, y: float, geo) -> tuple[float, float]:
    return _apply(np.asarray(H, float).reshape(3, 3), x, y, *geo)


def analyze(video: Path, width: int, height: int, duration: float,
            on_progress: Callable[[float], None] | None = None, thumbs: Path | None = None,
            features: Path | None = None) -> dict:
    det = _detector(width, height)
    rec = _recognizer()
    gw, gh = GEO_W, round(GEO_W * height / width)
    samples = []  # (t, sig, faces[(x, y, w, score, feat)])
    feats, smalls = [], []
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
        small = cv2.resize(frame, (gw, gh), interpolation=cv2.INTER_AREA)
        smalls.append(small)
        feats.append(_features(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)))
        if on_progress and duration:
            on_progress(min(0.95, 0.9 * t / duration))

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
    speakers = []
    for _, _, faces in samples:
        sp = None
        if ref is not None and faces:
            x, y, w, _, feat = max(faces, key=lambda f: float(f[4] @ ref))
            if float(feat @ ref) >= SPEAKER_COS:
                sp = (x, y, w)
        speakers.append(sp)

    # --- 1: groups of near-identical frames (background signature) ---
    groups: list[dict] = []
    for k, (_, sig, _) in enumerate(samples):
        best = min(groups, key=lambda g: sig_dist(g["sig"], sig), default=None)
        if best is not None and sig_dist(best["sig"], sig) < CAMERA_DIST:
            best["sig"] = best["sig"] * 0.9 + sig * 0.1
            best["m"].append(k)
        else:
            groups.append({"sig": sig.copy(), "m": [k]})
    for g in groups:
        mean = np.mean([samples[k][1] for k in g["m"]], axis=0)
        g["rep"] = min(g["m"], key=lambda k: sig_dist(samples[k][1], mean))

    # --- 2: merge groups showing the same scene from the same angle ---
    groups.sort(key=lambda g: -len(g["m"]))
    cams: list[dict] = []
    for g in groups:
        best = None
        for c in cams:
            H, inl = _homography(feats[g["rep"]], feats[c["rep"]], MERGE_SCALE)
            if H is not None and inl >= MERGE_INLIERS and (best is None or inl > best[2]):
                best = (c, H, inl)
        if best:
            best[0]["groups"].append((g, best[1]))
        else:
            cams.append({"id": len(cams), "rep": g["rep"], "groups": [(g, np.eye(3))]})

    # every sample: its angle and the homography to that angle's reference frame
    assign: dict[int, tuple[int, np.ndarray | None]] = {}
    for c in cams:
        for g, Hg in c["groups"]:
            for k in g["m"]:
                if k == c["rep"]:
                    assign[k] = (c["id"], np.eye(3))
                    continue
                H, inl = _homography(feats[k], feats[c["rep"]])
                if H is None or inl < LOCATE_INLIERS:
                    Hs, inl2 = _homography(feats[k], feats[g["rep"]])
                    H = (Hg @ Hs) if Hs is not None and inl2 >= LOCATE_INLIERS else None
                assign[k] = (c["id"], H)
    if on_progress:
        on_progress(0.97)

    out_cams = []
    for c in cams:
        members = [k for g, _ in c["groups"] for k in g["m"]]
        hits = []
        for k in members:
            sp, H = speakers[k], assign[k][1]
            if sp is not None and H is not None:
                hits.append((*to_reference(H, sp[0], sp[1], (gw, gh)), sp[2]))
        has = len(hits) >= max(1, 0.3 * len(members))
        auto = None
        if has:
            xs, ys, ws = zip(*hits)
            auto = {"x": round(float(np.median(xs)), 4), "y": round(float(np.median(ys)), 4),
                    "w": round(float(np.median(ws)), 4)}
        out_cams.append({"id": c["id"], "sigs": [[int(v) for v in g["sig"].round().flatten()] for g, _ in c["groups"]],
                         "count": len(members), "share": round(len(members) / max(1, len(samples)), 4),
                         "has_speaker": has, "auto": auto, "manual": None, "zoom": None})
        if thumbs is not None:
            thumbs.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(thumbs / f"cam{c['id']}.jpg"), smalls[c["rep"]], [cv2.IMWRITE_JPEG_QUALITY, 85])

    if features is not None:
        arrays = {}
        for c in cams:
            kp, des = feats[c["rep"]]
            arrays[f"kp{c['id']}"] = np.float32([k.pt for k in kp]) if kp else np.zeros((0, 2), np.float32)
            arrays[f"des{c['id']}"] = des if des is not None else np.zeros((0, 32), np.uint8)
        np.savez_compressed(features, **arrays)

    out_samples = []
    for k, (t, _, _) in enumerate(samples):
        cid, H = assign[k]
        sp = speakers[k]
        out_samples.append([round(float(t), 2), cid,
                            round(float(sp[0]), 4) if sp else None, round(float(sp[1]), 4) if sp else None,
                            [round(float(v), 6) for v in H.flatten()] if H is not None else None])
    if on_progress:
        on_progress(1.0)
    return {"version": VERSION, "reference": [round(float(v), 5) for v in ref] if ref is not None else None,
            "geo": [gw, gh], "cameras": out_cams, "samples": out_samples}


class Locator:
    """Finds which camera angle a frame belongs to, and its homography to that
    angle's reference frame."""

    def __init__(self, data: dict, features: Path):
        self.data = data
        self.geo = tuple(data["geo"])
        arr = np.load(features)
        self.refs = {}
        for c in data["cameras"]:
            kp = [cv2.KeyPoint(float(x), float(y), 31) for x, y in arr[f"kp{c['id']}"]]
            self.refs[c["id"]] = (kp, arr[f"des{c['id']}"] if len(kp) else None)
        self.sigs = [(np.array(sg, np.float32).reshape(SIG_H, SIG_W), c) for c in data["cameras"] for sg in c["sigs"]]

    def locate(self, frame: np.ndarray) -> tuple[dict, np.ndarray] | None:
        sig = signature(frame)
        f = _features(_geo_gray(frame, *self.geo))
        # try angles in order of thumbnail similarity, keep the best geometric match
        order, seen = [], set()
        for d, c in sorted(((sig_dist(s, sig), c) for s, c in self.sigs), key=lambda x: x[0]):
            if c["id"] not in seen:
                seen.add(c["id"])
                order.append((d, c))
        best = None
        for d, c in order[:5]:
            H, inl = _homography(f, self.refs[c["id"]])
            if H is not None and inl >= LOCATE_INLIERS and (best is None or inl > best[2]):
                best = (c, H, inl)
        # return the *current* settings of the angle (manual framing/zoom change after analysis)
        current = {c["id"]: c for c in self.data["cameras"]}
        if best:
            return current.get(best[0]["id"], best[0]), best[1]
        # no geometric match (e.g. a blurry cutaway): fall back to a very close thumbnail
        if order and order[0][0] < CAMERA_DIST * 0.6:
            return current.get(order[0][1]["id"], order[0][1]), np.eye(3)
        return None


_locators: dict = {}


def locator(data: dict) -> Locator | None:
    path = data.get("_features")
    if not path or not Path(path).exists():
        return None
    key = (path, Path(path).stat().st_mtime)
    if key not in _locators:
        _locators.clear()
        _locators[key] = Locator(data, Path(path))
    loc = _locators[key]
    loc.data = data  # manual framings change without re-analysis
    return loc


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


def frame_framing(data: dict, frame: np.ndarray, det=None, rec=None,
                  lecturer: tuple[float, float] | None = None) -> dict:
    """How one frame is framed, exactly as the render does it: the angle's
    manual framing (mapped onto this frame), else the recognised lecturer,
    else the angle's usual lecturer position, else the centre. x/y are the
    crop centre / face height, normalised to this frame."""
    loc = locator(data)
    found = loc.locate(frame) if loc else None
    cam, H = found if found else (None, None)
    geo = tuple(data.get("geo", (GEO_W, round(GEO_W * frame.shape[0] / frame.shape[1]))))
    res = {"camera": cam["id"] if cam else None, "zoom": cam.get("zoom") if cam else None, "H": H}
    if cam and cam.get("manual"):
        x, y = to_frame(H, cam["manual"]["x"], cam["manual"].get("y", 0.36), geo)
        return {**res, "mode": "manual", "x": x, "y": y}
    if lecturer is None and data.get("reference") and det is not None:
        hit = identify(frame, det, rec, np.array(data["reference"], dtype=np.float32))
        lecturer = hit[:2] if hit else None
    if lecturer:
        return {**res, "mode": "lecturer", "x": float(lecturer[0]), "y": float(lecturer[1])}
    if cam and cam.get("auto"):
        x, y = to_frame(H, cam["auto"]["x"], cam["auto"]["y"], geo)
        return {**res, "mode": "camera", "x": x, "y": y}
    return {**res, "mode": "none", "x": 0.5, "y": 0.4}


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
    """Cached camera analysis (re-done when the format has changed)."""
    import json

    features = cache.with_suffix(".npz")
    if cache.exists() and features.exists():
        data = json.loads(cache.read_text())
        if data.get("version") == VERSION:
            data["_features"] = str(features)
            return data
    from .util import probe

    info = probe(video)
    data = analyze(video, info.width, info.height, info.duration, on_progress, thumbs, features)
    cache.write_text(json.dumps(data))
    data["_features"] = str(features)
    return data
