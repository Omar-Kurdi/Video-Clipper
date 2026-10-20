"""Transcribe a lecture once with word timestamps; cache next to the video."""
import json
from functools import lru_cache
from pathlib import Path
from typing import Callable

from .util import fmt_time


@lru_cache(maxsize=1)
def _model(model: str, device: str):
    """Loaded once per process (the web server reuses it between jobs)."""
    from faster_whisper import WhisperModel

    return WhisperModel(model, device=device, compute_type="float16" if device == "cuda" else "int8")


def words_path(video: Path) -> Path:
    return video.with_suffix(".words.json")


def transcribe(video: Path, model: str = "large-v3", language: str | None = "ar",
               device: str = "cuda", on_progress: Callable[[float], None] | None = None) -> Path:
    m = _model(model, device)
    segments, info = m.transcribe(
        str(video), language=language, word_timestamps=True, vad_filter=True,
        condition_on_previous_text=False)

    words, lines, segs = [], [], []
    for seg in segments:
        lines.append(f"[{fmt_time(seg.start)} - {fmt_time(seg.end)}] {seg.text.strip()}")
        print(lines[-1], flush=True)
        first = len(words)
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)})
        segs.append({"s": round(seg.start, 3), "e": round(seg.end, 3), "w0": first, "w1": len(words)})
        if on_progress and info.duration:
            on_progress(min(1.0, seg.end / info.duration))

    out = words_path(video)
    out.write_text(json.dumps({"language": info.language, "words": words, "segments": segs},
                              ensure_ascii=False), encoding="utf-8")
    video.with_suffix(".transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def transcribe_ranges(video: Path, ranges: list[tuple[float, float]], model: str = "large-v3",
                      language: str | None = "ar", device: str = "cuda",
                      margin: float = 1.0) -> list[dict]:
    """Transcribe only the selected ranges (no full-lecture transcript needed)."""
    import subprocess

    import numpy as np

    m = _model(model, device)
    words = []
    for a, b in ranges:
        start = max(0.0, a - margin)
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{b + margin - start:.3f}",
             "-i", str(video), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
            check=True, capture_output=True).stdout
        audio = np.frombuffer(raw, dtype=np.float32)
        segments, _ = m.transcribe(audio, language=language, word_timestamps=True,
                                   vad_filter=True, condition_on_previous_text=False)
        for seg in segments:
            for w in seg.words or []:
                words.append({"w": w.word.strip(), "s": round(start + w.start, 3),
                              "e": round(start + w.end, 3)})
    return words


def load_words(video: Path) -> list[dict]:
    return json.loads(words_path(video).read_text(encoding="utf-8"))["words"]
