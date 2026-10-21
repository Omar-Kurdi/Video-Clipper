"""Small helpers: time parsing, ffprobe, subprocess."""
import json
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from fractions import Fraction
from pathlib import Path


def parse_time(s: str) -> float:
    """'75', '1:15', '1:15.5', '01:01:15' -> seconds."""
    parts = [float(p) for p in s.strip().split(":")]
    t = 0.0
    for p in parts:
        t = t * 60 + p
    return t


def parse_range(s: str) -> tuple[float, float]:
    a, b = s.split("-", 1)
    start, end = parse_time(a), parse_time(b)
    if end <= start:
        raise ValueError(f"range end must be after start: {s}")
    return start, end


def fmt_time(t: float) -> str:
    m, s = divmod(round(max(t, 0.0), 1), 60)
    h, m = divmod(int(m), 60)
    return f"{h}:{m:02d}:{s:04.1f}" if h else f"{m:02d}:{s:04.1f}"


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: Fraction
    duration: float


def probe(path: Path) -> VideoInfo:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True).stdout
    d = json.loads(out)
    st = d["streams"][0]
    return VideoInfo(int(st["width"]), int(st["height"]),
                     Fraction(st["avg_frame_rate"]), float(d["format"]["duration"]))


def run(cmd: list[str], **kw) -> None:
    print("+", " ".join(cmd[:6]), "..." if len(cmd) > 6 else "")
    subprocess.run(cmd, check=True, **kw)


@lru_cache(maxsize=1)
def gpu_encoder() -> bool:
    """True when ffmpeg can encode H.264 on the NVIDIA GPU (NVENC)."""
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.2",
                            "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True, timeout=30)
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def encode_args(quality: int) -> list[str]:
    """H.264 encoder settings: NVENC on the GPU, else a light CPU preset that
    leaves cores free. `quality` ~ CRF (lower is better)."""
    if gpu_encoder():
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(quality), "-b:v", "0"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(quality), "-threads", "4"]
