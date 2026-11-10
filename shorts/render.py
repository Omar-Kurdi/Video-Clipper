"""Stage 2: transitions, crop, scale to 1080x1920, captions, encode."""
import subprocess
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np

from .captions import Overlay
from .reframe import CropPath
from .transitions import with_transitions
from .util import encode_args

OUT_W, OUT_H = 1080, 1920
GRADE = "eq=contrast=1.08:saturation=1.15,unsharp=5:5:0.6,vignette=PI/5"


def compose(crop: np.ndarray) -> np.ndarray:
    """Crop -> 1080x1920. A crop wider than 9:16 (zoomed out) is fitted to the
    width and the space above and below is filled with a blurred, dimmed copy."""
    h, w = crop.shape[:2]
    if w * OUT_H <= h * OUT_W + h:  # 9:16 (or narrower): fill the frame
        return cv2.resize(crop, (OUT_W, OUT_H), interpolation=cv2.INTER_LANCZOS4)
    fh = round(OUT_W * h / w) // 2 * 2
    fg = cv2.resize(crop, (OUT_W, fh), interpolation=cv2.INTER_LANCZOS4)
    # background: cover-scale a tiny copy, blur, scale up (cheap)
    sw = max(1, round(h * 9 / 16))
    x0 = (w - sw) // 2
    small = cv2.resize(crop[:, x0:x0 + sw], (54, 96), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), 6)
    bg = cv2.resize(small, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)
    bg = (bg * 0.55).astype(np.uint8)
    top = (OUT_H - fh) // 2
    bg[top:top + fh] = fg
    return bg


def _frames(cap: cv2.VideoCapture):
    while True:
        ok, frame = cap.read()
        if not ok:
            return
        yield frame


def _atempo(speed: float) -> str:
    """Speed up audio without changing the voice's pitch (atempo takes 0.5-2 per stage)."""
    stages, s = [], speed
    while s > 2.0:
        stages.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        stages.append("atempo=0.5")
        s /= 0.5
    stages.append(f"atempo={s:.4f}")
    return ",".join(stages)


LOUDNESS = -14.0  # LUFS: what YouTube, TikTok and Instagram play shorts back at


def _loudnorm(cut: Path, target: float) -> str:
    """A loudnorm filter that brings the cut's audio to `target` LUFS evenly
    (measured first, then one gain for the whole short: no pumping)."""
    import json
    import re

    err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(cut), "-vn",
                          "-af", f"loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    m = json.loads(re.findall(r"\{[^{}]*\}", err)[-1])
    if float(m["input_i"]) < -70:  # silence: nothing to level
        return ""
    return (f"loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
            f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}"
            ":linear=true,aresample=48000")


def render_vertical(cut: Path, path: CropPath, fps: Fraction, windows: dict[int, str], d: int,
                    overlay: Overlay | None, out: Path, grade: bool, on_frame=None,
                    speed: float = 1.0, loudness: float | None = None) -> None:
    vf = ["setsar=1"] + ([GRADE] if grade else [])
    if abs(speed - 1.0) > 1e-3:
        vf.append(f"setpts=PTS/{speed:.4f}")
    vf.append("format=yuv420p")
    af = [f for f in (_atempo(speed) if abs(speed - 1.0) > 1e-3 else "",
                      _loudnorm(cut, loudness) if loudness is not None else "") if f]
    audio = (["-af", ",".join(af)] if af else []) + (["-shortest"] if abs(speed - 1.0) > 1e-3 else [])
    cmd = ["ffmpeg", "-v", "error", "-stats", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{OUT_W}x{OUT_H}", "-r", str(fps), "-i", "-",
           "-i", str(cut), "-map", "0:v", "-map", "1:a",
           "-vf", ",".join(vf), *audio, "-r", str(fps),
           *encode_args(19), "-profile:v", "high", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", str(out)]
    print("+ ffmpeg (vertical render) ->", out)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cap = cv2.VideoCapture(str(cut))
    last = len(path.xs) - 1
    try:
        for i, frame in with_transitions(_frames(cap), windows, d):
            k = min(i, last)
            x, y = path.xs[k], path.ys[k]
            cw, ch = path.size(k)
            crop = frame[y:y + ch, x:x + cw]
            img = compose(crop)
            if overlay:
                overlay.apply(img, i / float(fps))
            proc.stdin.write(img.tobytes())
            if on_frame and i % 25 == 0:
                on_frame(i)
    finally:
        cap.release()
        proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("final ffmpeg render failed")
