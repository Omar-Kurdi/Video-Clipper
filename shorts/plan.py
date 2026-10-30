"""Turn selected ranges into frame-exact kept segments (pauses removed).

Silence comes from Silero VAD on the actual audio, not from Whisper word
timings (Whisper often stretches a word across a pause).
"""
import math
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import numpy as np

SR = 16000


@dataclass
class CutSettings:
    min_gap: float = 0.40     # only pauses longer than this are cut
    pre_pad: float = 0.07     # kept before speech resumes
    post_pad: float = 0.13    # kept after speech stops (word tails / breaths)
    min_removed: float = 0.12  # don't bother cutting less than this
    fade_frames: int = 3      # crossfade length at each join


@dataclass
class Segment:
    f0: int  # first source frame (inclusive)
    f1: int  # last source frame (exclusive)

    @property
    def frames(self) -> int:
        return self.f1 - self.f0


def _range_audio(video: Path, start: float, dur: float) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(video),
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _snap_to_words(start: float, end: float, words: list[dict],
                   limit: float = 0.25) -> tuple[float, float]:
    """Move range edges outward so they don't split a word, by at most `limit`:
    Whisper often stretches a word across a pause, and following it would keep
    seconds past where the user put the edge."""
    for w in words:
        if w["s"] < start < w["e"] and start - w["s"] <= limit:
            start = w["s"]
        if w["s"] < end < w["e"] and w["e"] - end <= limit:
            end = w["e"]
    return start, end


def speech_spans(video: Path, start: float, end: float, cs: CutSettings) -> list[tuple[float, float]]:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio = _range_audio(video, start, end - start)
    opts = VadOptions(threshold=0.5, min_speech_duration_ms=120,
                      min_silence_duration_ms=int(cs.min_gap * 1000), speech_pad_ms=0)
    return [(start + t["start"] / SR, start + t["end"] / SR)
            for t in get_speech_timestamps(audio, opts)]


def plan_range(video: Path, start: float, end: float, words: list[dict],
               fps: Fraction, duration: float, cs: CutSettings) -> list[Segment]:
    start, end = _snap_to_words(start, end, words)
    # stay one frame short of EOF so the last segment is never truncated
    lo, hi = max(0.0, start - cs.pre_pad), min(end + cs.post_pad, duration - 1 / float(fps))
    spans = speech_spans(video, lo, hi, cs)
    if not spans:
        spans = [(start, end)]

    # pad speech, clamp to the range
    padded = [(max(lo, s - cs.pre_pad), min(hi, e + cs.post_pad)) for s, e in spans]

    # merge where the removed part would be too small to be worth a cut
    half_fade = cs.fade_frames / float(fps) / 2
    merged = [list(padded[0])]
    for s, e in padded[1:]:
        removed = s - merged[-1][1] - 2 * half_fade
        if removed < cs.min_removed:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    # extend inner joins by half a fade so the blend eats silence, not speech
    for i, seg in enumerate(merged):
        if i > 0:
            seg[0] -= half_fade
        if i < len(merged) - 1:
            seg[1] += half_fade

    last_frame = math.floor(hi * fps)
    segs = [Segment(math.floor(s * fps), min(math.ceil(e * fps), last_frame)) for s, e in merged]

    # every piece must be comfortably longer than the crossfade
    min_frames = 3 * cs.fade_frames
    out: list[Segment] = []
    for seg in segs:
        if out and (seg.frames < min_frames or out[-1].frames < min_frames):
            out[-1] = Segment(out[-1].f0, seg.f1)
        else:
            out.append(seg)
    return out


def plan(video: Path, ranges: list[tuple[float, float]], words: list[dict],
         fps: Fraction, duration: float, cs: CutSettings) -> tuple[list[Segment], list[int]]:
    """Kept segments for all ranges, plus the index of each range's first segment."""
    segs: list[Segment] = []
    firsts: list[int] = []
    for a, b in ranges:
        firsts.append(len(segs))
        segs.extend(plan_range(video, a, b, words, fps, duration, cs))
    return segs, firsts


def output_starts(segs: list[Segment], fade_frames: int) -> list[int]:
    """Output-timeline start frame of each segment after crossfades."""
    starts, acc = [], 0
    for i, seg in enumerate(segs):
        starts.append(acc)
        acc += seg.frames - fade_frames
    return starts


def output_frames(segs: list[Segment], fade_frames: int) -> int:
    return sum(s.frames for s in segs) - fade_frames * (len(segs) - 1)
