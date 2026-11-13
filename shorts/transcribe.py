"""Transcribe a lecture once with word timestamps; cache next to the video."""
import json
from functools import lru_cache
from pathlib import Path
from typing import Callable

from .util import default_device, fmt_time


def _load_cuda12() -> None:
    """CTranslate2 needs CUDA 12's cuBLAS and cuDNN. They come from the
    nvidia-*-cu12 packages, but nothing puts them on the library path (a torch
    built for CUDA 13 doesn't load them), so load them here by full path."""
    import ctypes
    import importlib.util

    for pkg, libs in (("nvidia.cublas", ("libcublasLt.so.12", "libcublas.so.12")),
                      ("nvidia.cudnn", ("libcudnn.so.9",))):
        spec = importlib.util.find_spec(pkg)
        for root in (spec.submodule_search_locations or []) if spec else []:
            for name in libs:
                lib = Path(root) / "lib" / name
                if lib.exists():
                    ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)


@lru_cache(maxsize=1)
def _model(model: str, device: str, compute: str | None = None):
    """Loaded once per process (the web server reuses it between jobs)."""
    from faster_whisper import WhisperModel

    if device == "cuda":
        _load_cuda12()
    return WhisperModel(model, device=device, compute_type=compute or ("float16" if device == "cuda" else "int8"))


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


# ---------- speech Whisper skipped ----------
# With its voice filter on, Whisper sometimes ends a 30 s window early and
# writes nothing for the rest of it (a lecture's opening after a recited
# verse, say). Every stretch of detected speech left without words is read
# again on its own.

HOLE_GAP = 2.0       # seconds between two words before it can be a hole
HOLE_SPEECH = 1.5    # seconds of detected speech in it that make it one


def speech_spans(audio) -> list[list[float]]:
    """Where someone is talking (seconds), as the analysis finds it (speech.json)."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    spans = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=150, speech_pad_ms=0,
                                                    min_speech_duration_ms=120))
    return [[round(x["start"] / 16000, 3), round(x["end"] / 16000, 3)] for x in spans]


def holes(words: list[dict], speech: list[list[float]], end: float = 1e9,
          tried: list[list[float]] | None = None) -> list[tuple[float, float]]:
    """Stretches with detected speech but no words, trimmed to that speech
    (leaving out those already read again without finding words: `tried`)."""
    out = []
    edges = [(0.0, words[0]["s"] if words else end)] + [(a["e"], b["s"]) for a, b in zip(words, words[1:])]
    edges += [(words[-1]["e"], end)] if words else []
    for a, b in edges:
        if b - a < HOLE_GAP:
            continue
        inside = [(max(a, s0), min(b, s1)) for s0, s1 in speech if s1 > a and s0 < b]
        if sum(y - x for x, y in inside) >= HOLE_SPEECH:
            h = (round(max(a, inside[0][0] - 0.3), 3), round(min(b, inside[-1][1] + 0.3), 3))
            if not any(t0 - 0.5 <= h[0] and h[1] <= t1 + 0.5 for t0, t1 in tried or []):
                out.append(h)
    return out


# what Whisper writes over quiet or unclear audio, learned from subtitled videos, not heard
MADE_UP = ("اشتركوا في القناة", "اشترك في القناة", "لا تنسوا الاشتراك", "شكرا للمشاهدة", "ترجمة نانسي قنقر",
           "نانسي قنقر", "thanks for watching", "thank you for watching", "subscribe to", "subtitles by")


def _made_up(text: str) -> bool:
    t = " ".join(text.lower().split())
    return any(p in t for p in MADE_UP)


def _read_holes(m, audio, gaps: list[tuple[float, float]], language: str | None) -> list[list[dict]]:
    """Whisper on each hole alone (no voice filter, so it can't skip it again).
    Returns the new sentences, each a list of words."""
    found = []
    for a, b in gaps:
        segments, _ = m.transcribe(audio, language=language, word_timestamps=True, vad_filter=False,
                                   condition_on_previous_text=False, clip_timestamps=[a, b])
        for seg in segments:
            # unsure or repetitive text over a hole is more likely made up than heard
            if seg.avg_logprob < -1.0 or seg.compression_ratio > 2.4 or _made_up(seg.text):
                continue
            ws = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)} for w in seg.words or []
                  if w.word.strip() and a - 0.05 <= (w.start + w.end) / 2 <= b + 0.05]
            if ws:
                found.append(ws)
    return found


def _placeholders(words: list[dict], gaps: list[tuple[float, float]]) -> set[int]:
    """Words the tashkeel reader heard in a stretch Whisper skipped: with no
    Whisper word to take the timing from, they sit stacked, without length,
    at the edge of the gap. Once the gap is transcribed they would say it twice."""
    return {i for i, w in enumerate(words)
            if w["e"] - w["s"] < 0.02 and not w.get("asr") and any(abs(w["s"] - a) < 0.3 or abs(w["s"] - b) < 0.3
                                                                for a, b in gaps)}


def _merge(words: list[dict], segs: list[dict], new: list[list[dict]],
           drop: set[int] = frozenset()) -> tuple[list[dict], list[dict], list[int]]:
    """Sentences of `new` put in among the old ones by time (words in `drop`
    left out). Returns the words, the sentences, and for each old sentence its
    index in the result (-1 if nothing was left of it)."""
    groups = [(g["s"], 0, k, [w for i, w in enumerate(words[g["w0"]:g["w1"]], g["w0"]) if i not in drop], g)
              for k, g in enumerate(segs)]
    groups += [(ws[0]["s"], 1, -1, ws, None) for ws in new]
    groups.sort(key=lambda x: (x[0], x[1]))
    out_w, out_s, where = [], [], [-1] * len(segs)
    for _, _, k, ws, g in groups:
        if not ws:
            continue
        if k >= 0:
            where[k] = len(out_s)
        if g is not None:  # an old sentence keeps its own times and everything else it has
            out_s.append({**g, "w0": len(out_w), "w1": len(out_w) + len(ws)})
        else:
            out_s.append({"s": ws[0]["s"], "e": ws[-1]["e"], "w0": len(out_w), "w1": len(out_w) + len(ws)})
        out_w += ws
    return out_w, out_s, where


def fill_holes(video: Path, model: str = "large-v3", device: str | None = None,
               on_progress: Callable[[float], None] | None = None) -> int:
    """Transcribe the speech an existing transcript skipped, keeping everything
    else as it is (corrections, proofreading, the translation's sentences).
    Returns how many sentences were added."""
    path = words_path(video)
    data = json.loads(path.read_text(encoding="utf-8"))
    audio = _audio(video)
    speech_file = video.parent / "speech.json"
    speech = json.loads(speech_file.read_text()) if speech_file.exists() else speech_spans(audio)
    gaps = holes(data["words"], speech, len(audio) / 16000, data.get("holes_tried"))
    if not gaps:
        return 0
    device = device or default_device()
    new = _read_holes(_model(model, device), audio, gaps, data.get("language"))
    if on_progress:
        on_progress(0.6)
    if new and data.get("engine") == "tashkeel" and device == "cuda":
        new = _tashkeel_pieces(new, audio)
    # what's left of a hole after this had no words to find (music, a cough, the audience): don't offer it again
    data["holes_tried"] = (data.get("holes_tried") or []) + [list(g) for g in gaps]
    if not new:
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return 0
    _save_merged(video, data, new, _placeholders(data["words"], gaps))
    if on_progress:
        on_progress(1.0)
    return len(new)


def _save_merged(video: Path, data: dict, new: list[list[dict]], drop: set[int]) -> None:
    """Put `new` sentences in (and leave the `drop` words out), recheck the
    Quran/hadith marks, and keep each translation's sentences in step."""
    from .sources import annotate

    words, segs, where = _merge(data["words"], data["segments"], new, drop)
    data.update(words=words, segments=segs)
    data = annotate(data)
    words_path(video).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    _write_text(video, data)
    remap_translations(video, data, where)


def settle_untimed_words(data: dict) -> tuple[dict, list[int], int]:
    """Words the tashkeel reader added without a time (see tashkeel.settle_untimed),
    sorted out sentence by sentence in a transcript made before that was done.
    Returns (data, for each old sentence its index now or -1, words dropped)."""
    from .tashkeel import settle_untimed

    words, segs, where, dropped = [], [], [], 0
    old, gs = data["words"], data["segments"]
    for k, g in enumerate(gs):
        nxt = gs[k + 1] if k + 1 < len(gs) else None
        ws, n = settle_untimed(old[g["w0"]:g["w1"]], before_ctx=words[-6:],
                               after_ctx=old[nxt["w0"]:nxt["w0"] + 6] if nxt else (),
                               limit=old[nxt["w0"]]["s"] if nxt and nxt["w1"] > nxt["w0"] else None)
        dropped += n
        if not ws:
            where.append(-1)
            continue
        where.append(len(segs))
        segs.append({**g, "s": min(g["s"], ws[0]["s"]), "w0": len(words), "w1": len(words) + len(ws)})
        words += ws
    data.update(words=words, segments=segs, untimed_settled=True)
    return data, where, dropped


def remap_translations(video: Path, data: dict, where: list[int]) -> None:
    """Keep each translation's sentences in step after sentences were added or
    removed: old sentences keep their translations, new ones start empty."""
    from . import translate as tr

    words, segs = data["words"], data["segments"]
    if where == list(range(len(segs))):
        return
    for lang in tr.LANGS:
        t = tr.load(video, lang)
        if not t or len(t.get("segments", [])) != len(where):
            continue
        out = [{"text": "", "source": " ".join(w["w"] for w in words[g["w0"]:g["w1"]])} for g in segs]
        for k, i in enumerate(where):
            if i >= 0:
                out[i] = t["segments"][k]
        t["segments"] = out
        tr.translation_path(video, lang).write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")


def _tashkeel_pieces(new: list[list[dict]], audio) -> list[list[dict]]:
    """The tashkeel reader over just the new sentences, each read on its own
    (as it re-reads sentences its first pass got wrong), its models loaded once."""
    from . import tashkeel as tk

    release_whisper()
    try:
        base, tash, other = tk._read([(ws[0]["s"], ws[-1]["e"]) for ws in new], audio)
    finally:
        tk.release()
    return [tk._merge(ws, b, t, o) or ws for ws, b, t, o in zip(new, base, tash, other)]


def _write_text(video: Path, data: dict) -> None:
    lines = [f"[{fmt_time(g['s'])} - {fmt_time(g['e'])}] " + " ".join(w["w"] for w in data["words"][g["w0"]:g["w1"]])
             for g in data["segments"]]
    video.with_suffix(".transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def release_whisper() -> None:
    import gc

    _model.cache_clear()
    gc.collect()


ENGINES = ("tashkeel", "whisper")


def _whisper_pass(video: Path, m, language: str | None, on_progress, share: float):
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
    return words, lines, segs, info


def transcribe(video: Path, model: str = "large-v3", language: str | None = "ar",
               device: str | None = None, on_progress: Callable[[float], None] | None = None,
               engine: str = "tashkeel", title: str | None = None) -> Path:
    """engine "tashkeel" (Arabic): Whisper for timing, then Cohere-Speech-Tashkeel
    re-reads every sentence for accurate, diacritised text. "whisper": Whisper only.
    Quran quotations are then replaced by the exact mushaf text and hadith are
    linked to their source. `title` (the lecture's) helps pick between similar
    words: see sources.apply_vocab."""
    device = device or default_device()
    tashkeel = engine == "tashkeel" and (language or "ar") == "ar" and device == "cuda"
    share = 0.55 if tashkeel else 0.95
    # when other programs fill the GPU, retry in 8-bit: about half the memory, nearly the same text
    for compute in ([None, "int8_float16"] if device == "cuda" else [None]):
        try:
            words, lines, segs, info = _whisper_pass(video, _model(model, device, compute), language,
                                                     on_progress, share)
            break
        except RuntimeError as e:
            if "out of memory" not in str(e) or compute:
                raise
            print("GPU out of memory: Whisper again in 8-bit", flush=True)
            release_whisper()

    # speech Whisper skipped, read again on its own
    audio = _audio(video)
    new = _read_holes(_model(model, device, compute), audio, holes(words, speech_spans(audio), len(audio) / 16000),
                      language or info.language)
    if new:
        print(f"read {len(new)} skipped stretch(es) of speech again", flush=True)
        words, segs, _ = _merge(words, segs, new)

    segs = split_long(words, segs)
    data = {"language": info.language, "engine": "whisper", "words": words, "segments": segs, "title": title}
    if tashkeel and info.language == "ar" and segs:
        from . import tashkeel as tk

        release_whisper()  # both models don't need to share the GPU
        try:
            words2, segs2, improved = tk.rewrite(words, segs, audio,
                                                 lambda f: on_progress and on_progress(share + (0.95 - share) * f))
            data.update(words=words2, segments=segs2, engine="tashkeel", improved=improved, untimed_settled=True)
        finally:
            tk.release()
    from .sources import annotate

    data = annotate(data)
    out = words_path(video)
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    for old in video.parent.glob(f"{video.stem}.translation.*.json"):  # made from the previous text
        old.unlink()
    _write_text(video, data)
    if on_progress:
        on_progress(1.0)
    return out


def transcribe_ranges(video: Path, ranges: list[tuple[float, float]], model: str = "large-v3",
                      language: str | None = "ar", device: str | None = None,
                      margin: float = 1.0) -> list[dict]:
    """Transcribe only the selected ranges (no full-lecture transcript needed)."""
    import subprocess

    import numpy as np

    m = _model(model, device or default_device())
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
