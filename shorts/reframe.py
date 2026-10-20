"""Stage 2a: compute a smooth 9:16 crop path that follows the speaker's face.

Faces are detected (YuNet) a few times per second, the speaker is followed by
continuity, and the virtual camera is damped: it holds still inside a deadzone
and eases toward the face once it leaves it. At hard shot changes the camera
jumps instead of panning.
"""
import urllib.request
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

MODEL_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")
MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "face_detection_yunet_2023mar.onnx"

DETECT_WIDTH = 960
SAMPLES_PER_SEC = 5
CUT_THRESHOLD = 28.0           # mean abs diff (0-255) of 64x36 thumbnails
DISSOLVE_LAG = 8
JOIN_THRESHOLD = 25.0          # P vs Q difference above which a join is treated as a shot change
REACQUIRE_SAMPLES = SAMPLES_PER_SEC  # ~1 s of rejected faces -> pick the main face again


def _near(samples, a: int, b: int, x: float, W: int, radius: float = 0.12):
    """Face positions in frames [a, b) close to x (the lecturer once he's located)."""
    pts = []
    for i, faces in samples:
        if a <= i < b and faces:
            f = min(faces, key=lambda f: abs(f[0] - x))
            if abs(f[0] - x) < radius * W:
                pts.append((i, f[0], f[1]))
    return pts


@dataclass
class ReframeSettings:
    zoom: float = 1.0          # >1 crops tighter than full height
    deadzone: float = 0.05     # fraction of source width the face may drift before panning
    tau: float = 0.35          # pan easing time constant (s)
    smooth: float = 0.4        # gaussian sigma on the face track (s)
    hold: float = 0.07         # with a known lecturer: how far (fraction of width) he may move before the frame follows
    face_y: float = 0.36       # where the face sits vertically in the crop (only when zoom > 1)


def _detector(w: int, h: int):
    if not MODEL_PATH.exists():
        MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    return cv2.FaceDetectorYN.create(str(MODEL_PATH), "", (w, h), 0.6, 0.3, 50)


def _scan(video: Path, on_frame=None):
    """One pass: face detections every few frames + per-frame change scores."""
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = DETECT_WIDTH / W
    det = _detector(DETECT_WIDTH, round(H * scale))
    step = max(1, round(fps / SAMPLES_PER_SEC))

    thumbs: deque = deque(maxlen=DISSOLVE_LAG + 1)
    d1, dlong, samples, all_thumbs = [], [], [], []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # centre half of the frame: static overlays/borders don't mask a shot change
        centre = frame[:, W // 4: W - W // 4]
        small = cv2.cvtColor(cv2.resize(centre, (48, 54), interpolation=cv2.INTER_AREA),
                             cv2.COLOR_BGR2GRAY).astype(np.float32)
        thumbs.append(small)
        all_thumbs.append(small.astype(np.uint8))
        d1.append(float(np.mean(np.abs(small - thumbs[-2]))) if len(thumbs) > 1 else 0.0)
        dlong.append(float(np.mean(np.abs(small - thumbs[0]))) if len(thumbs) > DISSOLVE_LAG else 0.0)
        if i % step == 0:
            img = cv2.resize(frame, (DETECT_WIDTH, round(H * scale)), interpolation=cv2.INTER_AREA)
            _, faces = det.detect(img)
            found = [] if faces is None else [
                ((f[0] + f[2] / 2) / scale, (f[1] + f[3] / 2) / scale, f[2] / scale, float(f[14]))
                for f in faces]
            samples.append((i, found))
        i += 1
        if on_frame and i % 50 == 0:
            on_frame(i)
    cap.release()
    return fps, W, H, i, np.array(d1), np.array(dlong), samples, np.array(all_thumbs)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    runs, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def _shot_bounds(d1: np.ndarray, dlong: np.ndarray, fps: float) -> list[int]:
    """Frames where a new shot starts: hard cuts exactly at the first new
    frame, gradual dissolves at their midpoint."""
    hard = [a for a, _ in _runs(d1 > max(CUT_THRESHOLD, 6 * float(np.median(d1)) + 8))]
    soft = []
    for a, b in _runs(dlong > max(CUT_THRESHOLD, 6 * float(np.median(dlong)) + 8)):
        if not any(a - DISSOLVE_LAG <= h <= b for h in hard):
            soft.append((a - DISSOLVE_LAG + b) // 2)
    bounds = [0]
    for f in sorted(hard + soft):
        if f - bounds[-1] > fps * 0.5:
            bounds.append(f)
    return bounds


def _track_shot(samples, a: int, b: int, W: int):
    """Pick the speaker's face in each sample of frames [a, b) by continuity."""
    pts, prev, misses = [], None, 0
    for i, faces in samples:
        if not (a <= i < b) or not faces:
            continue
        if prev is None or misses >= REACQUIRE_SAMPLES:
            pick = max(faces, key=lambda f: f[2] * f[2] * f[3])
        else:
            def cost(f):
                return abs(f[0] - prev[0]) / W + 0.5 * abs(np.log(f[2] / prev[2]))
            pick = min(faces, key=cost)
            if abs(pick[0] - prev[0]) > 0.25 * W:
                misses += 1  # likely someone else; re-acquire if it persists
                continue
        misses = 0
        pts.append((i, pick[0], pick[1]))
        prev = pick
    return pts


def _gauss(x: np.ndarray, sigma: float) -> np.ndarray:
    if sigma < 1 or len(x) < 3:
        return x
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(x, r, mode="edge"), k, mode="valid")


def _camera(target: np.ndarray, dz: float, alpha: float, start: float | None = None) -> np.ndarray:
    """Deadzone + eased follow. Starts at `start` (or the first target)."""
    out = np.empty_like(target)
    c, moving = (target[0] if start is None else start), False
    for k, t in enumerate(target):
        err = t - c
        if abs(err) > dz:
            moving = True
        if moving:
            c += err * alpha
            if abs(err) < dz * 0.2:
                moving = False
        out[k] = c
    return out


@dataclass
class CropPath:
    cw: int
    ch: int
    xs: np.ndarray
    ys: np.ndarray
    camera_changes: list[int]  # frames where the source itself cuts to another shot
    thumbs: np.ndarray         # per-frame grey thumbnail of the frame centre

    def looks_different(self, a: int, b: int) -> bool:
        """True when frames a and b look like different shots."""
        if not (0 <= a < len(self.thumbs) and 0 <= b < len(self.thumbs)):
            return False
        diff = np.mean(np.abs(self.thumbs[a].astype(np.float32) - self.thumbs[b]))
        return diff > JOIN_THRESHOLD


def _lock_shots(video: Path, bounds: list[int], W: int, H: int, identity: dict) -> list[dict]:
    """Per shot: where the lecturer is (face recognition on a few frames), and
    the camera it belongs to (for manual framing)."""
    from .cameras import _recognizer, framing, identify, match_camera, signature

    ref = np.array(identity["reference"], dtype=np.float32) if identity.get("reference") else None
    det = _detector(W, H)
    rec = _recognizer() if ref is not None else None
    cap = cv2.VideoCapture(str(video))
    out = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        hits, sig = [], None
        for q in (0.2, 0.5, 0.8):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(a + (b - a) * q))
            ok, frame = cap.read()
            if not ok:
                continue
            if q == 0.5 or sig is None:
                sig = signature(frame)
            if ref is not None:
                hit = identify(frame, det, rec, ref)
                if hit:
                    hits.append(hit)
        cam = match_camera(identity, sig) if (sig is not None and identity.get("cameras")) else None
        manual = cam.get("manual") if cam else None
        lect = (float(np.median([h[0] for h in hits])), float(np.median([h[1] for h in hits]))) if hits else None
        auto = framing(cam) if cam else None
        out.append({"camera": cam["id"] if cam else None, "manual": manual, "lecturer": lect,
                     "camera_framing": auto, "found": ref is not None})
    cap.release()
    return out


def crop_path(video: Path, rs: ReframeSettings, forced: list[int] = (),
              on_frame=None, identity: dict | None = None) -> CropPath:
    """One crop x/y per frame of `video`.

    `forced` are extra tracking resets (e.g. where two selected ranges join).
    `identity` is the lecture's camera analysis (cameras.json): with it the
    lecturer is recognised in every shot and the frame is locked on him (or on
    a camera's manual framing); without it the main face is followed.
    """
    fps, W, H, n, d1, dlong, samples, thumbs = _scan(video, on_frame)
    ch = int(H / rs.zoom) // 2 * 2
    cw = int(ch * 9 / 16) // 2 * 2
    if cw > W:
        raise ValueError("source is narrower than 9:16")

    detected = _shot_bounds(d1, dlong, fps)
    bounds = sorted(set(detected) | {f for f in forced if 0 < f < n}) + [n]
    shots = _lock_shots(video, bounds, W, H, identity) if identity else None
    alpha = 1 - np.exp(-1 / (rs.tau * fps))
    calm = 1 - np.exp(-1 / (max(rs.tau, 0.6) * fps))
    cx_all, cy_all = np.empty(n), np.empty(n)
    last = (W / 2, H / 2)
    log = []
    for k, (a, b) in enumerate(zip(bounds[:-1], bounds[1:])):
        frames = np.arange(a, b)
        info = shots[k] if shots else None
        if info and info["manual"]:
            # the user placed this camera's frame: hold it exactly
            mx = info["manual"]["x"] * W
            my = info["manual"].get("y", (info["camera_framing"] or (0.5, 0.36))[1]) * H
            cx_all[a:b], cy_all[a:b] = mx, my
            log.append("manual")
        elif info and (info["lecturer"] or info["camera_framing"]):
            # lock on the lecturer; only follow if he really moves
            lx, ly = (info["lecturer"] or info["camera_framing"])
            lx, ly = lx * W, ly * H
            pts = _near(samples, a, b, lx, W)
            if pts:
                t, x, y = map(np.array, zip(*pts))
                tx, ty = np.interp(frames, t, x), np.interp(frames, t, y)
                tx, ty = _gauss(tx, rs.smooth * 2 * fps), _gauss(ty, rs.smooth * 2 * fps)
            else:
                tx, ty = np.full(b - a, lx), np.full(b - a, ly)
            cx_all[a:b] = _camera(tx, rs.hold * W, calm, start=lx)
            cy_all[a:b] = _camera(ty, rs.hold * H, calm, start=ly)
            log.append("lecturer" if info["lecturer"] else "camera")
        elif info and info["found"]:
            # lecturer not in this shot (audience cutaway): centre it, steady
            cx_all[a:b], cy_all[a:b] = W / 2, H * 0.4
            log.append("no lecturer")
        else:
            pts = _track_shot(samples, a, b, W)
            if pts:
                t, x, y = map(np.array, zip(*pts))
                tx, ty = np.interp(frames, t, x), np.interp(frames, t, y)
                start = (float(np.median(x)), float(np.median(y)))
            else:  # no face this shot: hold the previous framing
                tx, ty = np.full(b - a, last[0]), np.full(b - a, last[1])
                start = last
            tx, ty = _gauss(tx, rs.smooth * fps), _gauss(ty, rs.smooth * fps)
            cx_all[a:b] = _camera(tx, rs.deadzone * W, alpha, start=start[0])
            cy_all[a:b] = _camera(ty, rs.deadzone * H, alpha, start=start[1])
            log.append("face")
        last = (cx_all[b - 1], cy_all[b - 1])

    xs = np.clip(np.round(cx_all - cw / 2), 0, W - cw).astype(int)
    ys = np.clip(np.round(cy_all - rs.face_y * ch), 0, H - ch).astype(int)
    print(f"reframe: {n} frames, camera changes at "
          f"{[round(b / fps, 2) for b in detected[1:]]}, crop {cw}x{ch}, shots: {log}")
    return CropPath(cw, ch, xs, ys, detected[1:], thumbs)


def ease_crop_across(path: CropPath, start: int, d: int) -> None:
    """Inside a synthesized transition, glide the crop from the frame before
    to the frame after, so it never jumps mid-blend."""
    a, b = start - 1, start + d
    if a < 0 or b >= len(path.xs):
        return
    for k in range(d):
        t = (k + 1) / (d + 1)
        t = t * t * (3 - 2 * t)
        path.xs[start + k] = round(path.xs[a] + (path.xs[b] - path.xs[a]) * t)
        path.ys[start + k] = round(path.ys[a] + (path.ys[b] - path.ys[a]) * t)
