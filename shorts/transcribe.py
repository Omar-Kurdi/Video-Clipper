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


def _audio(video: Path):
    """Mono 16 kHz audio, made the way Cohere's reference code (librosa) makes it:
    decoded at the file's own rate, channels averaged, resampled with soxr's
    high quality setting. The models are sensitive to this: ffmpeg's own
    downmix and resampler tipped borderline words differently (بالزين / بالزي).
    Streamed in pieces, so an hour of stereo audio never sits in memory whole."""
    import subprocess

    import numpy as np
    import soxr

    info = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                           "stream=sample_rate,channels", "-of", "csv=p=0", str(video)],
                          check=True, capture_output=True, text=True).stdout.split()[0].split(",")
    rate, channels = int(info[0]), int(info[1])
    stream = soxr.ResampleStream(rate, 16000, 1, dtype="float32", quality="HQ")
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-f", "f32le", "-"],
                            stdout=subprocess.PIPE)
    out, block = [], rate * channels * 4 * 10  # 10 s at a time
    while True:
        raw = proc.stdout.read(block)
        x = np.frombuffer(raw[: len(raw) // (4 * channels) * 4 * channels], dtype=np.float32)
        x = x.reshape(-1, channels).mean(axis=1) if channels > 1 else x
        out.append(stream.resample_chunk(x, last=not raw))
        if not raw:
            break
    if proc.wait():
        raise subprocess.CalledProcessError(proc.returncode, "ffmpeg")
    return np.concatenate(out).astype(np.float32)


MAX_SENTENCE = 8.0  # seconds; Whisper sometimes returns a whole 30 s window as one "sentence"


def split_long(words: list[dict], segs: list[dict]) -> list[dict]:
    """Split long sentences at their longest pause between words."""
    out = []
    todo = list(segs)
    while todo:
        g = todo.pop(0)
        n = g["w1"] - g["w0"]
        if g["e"] - g["s"] <= MAX_SENTENCE or n < 4:
            out.append(g)
            continue
        # the biggest gap, not too close to either end
        k = max(range(g["w0"] + 2, g["w1"] - 1), key=lambda i: words[i]["s"] - words[i - 1]["e"])
        a = {"s": g["s"], "e": words[k - 1]["e"], "w0": g["w0"], "w1": k}
        b = {"s": words[k]["s"], "e": g["e"], "w0": k, "w1": g["w1"]}
        todo[:0] = [a, b]
    return out


def release_whisper() -> None:
    import gc

    _model.cache_clear()
    gc.collect()


ENGINES = ("tashkeel", "whisper")


def transcribe(video: Path, model: str = "large-v3", language: str | None = "ar",
               device: str = "cuda", on_progress: Callable[[float], None] | None = None,
               engine: str = "tashkeel", title: str | None = None) -> Path:
    """engine "tashkeel" (Arabic): Whisper for timing, then Cohere-Speech-Tashkeel
    re-reads every sentence for accurate, diacritised text. "whisper": Whisper only.
    Quran quotations are then replaced by the exact mushaf text and hadith are
    linked to their source. `title` (the lecture's) helps pick between similar
    words: see sources.apply_vocab."""
    tashkeel = engine == "tashkeel" and (language or "ar") == "ar" and device == "cuda"
    share = 0.55 if tashkeel else 0.95
    m = _model(model, device)
    # (a hint via hotwords/initial_prompt helps Whisper's spelling of names but
    # squashes its word timings over a whole lecture, so it isn't used here)
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
            on_progress(share * min(1.0, seg.end / info.duration))

    segs = split_long(words, segs)
    data = {"language": info.language, "engine": "whisper", "words": words, "segments": segs, "title": title}
    if tashkeel and info.language == "ar" and segs:
        from . import tashkeel as tk

        release_whisper()  # both models don't need to share the GPU
        try:
            words2, segs2, improved = tk.rewrite(words, segs, _audio(video),
                                                 lambda f: on_progress and on_progress(share + (0.95 - share) * f))
            data.update(words=words2, segments=segs2, engine="tashkeel", improved=improved)
        finally:
            tk.release()
    from .sources import annotate

    data = annotate(data)
    out = words_path(video)
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    for old in video.parent.glob(f"{video.stem}.translation.*.json"):  # made from the previous text
        old.unlink()
    lines = [f"[{fmt_time(g['s'])} - {fmt_time(g['e'])}] " + " ".join(w["w"] for w in data["words"][g["w0"]:g["w1"]])
             for g in data["segments"]]
    video.with_suffix(".transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if on_progress:
        on_progress(1.0)
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
