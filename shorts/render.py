"""Stage 2: transitions, crop, scale to 1080x1920, captions, encode."""
import subprocess
from fractions import Fraction
from pathlib import Path

import cv2

from .captions import Overlay
from .reframe import CropPath
from .transitions import with_transitions

OUT_W, OUT_H = 1080, 1920
GRADE = "eq=contrast=1.08:saturation=1.15,unsharp=5:5:0.6,vignette=PI/5"


def _frames(cap: cv2.VideoCapture):
    while True:
        ok, frame = cap.read()
        if not ok:
            return
        yield frame


def render_vertical(cut: Path, path: CropPath, fps: Fraction, windows: dict[int, str], d: int,
                    overlay: Overlay | None, out: Path, grade: bool, on_frame=None) -> None:
    vf = ["setsar=1"] + ([GRADE] if grade else []) + ["format=yuv420p"]
    cmd = ["ffmpeg", "-v", "error", "-stats", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{OUT_W}x{OUT_H}", "-r", str(fps), "-i", "-",
           "-i", str(cut), "-map", "0:v", "-map", "1:a",
           "-vf", ",".join(vf),
           "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", "-cq", "19", "-b:v", "0",
           "-profile:v", "high", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", str(out)]
    print("+ ffmpeg (vertical render) ->", out)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cap = cv2.VideoCapture(str(cut))
    last = len(path.xs) - 1
    try:
        for i, frame in with_transitions(_frames(cap), windows, d):
            k = min(i, last)
            x, y = path.xs[k], path.ys[k]
            crop = frame[y:y + path.ch, x:x + path.cw]
            img = cv2.resize(crop, (OUT_W, OUT_H), interpolation=cv2.INTER_LANCZOS4)
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
