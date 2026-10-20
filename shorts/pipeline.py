"""The whole lecture -> short pipeline as one reusable call (CLI and web app)."""
import json
import shutil
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable

from .captions import Overlay, Style, chunk, load_style, map_words, style_from_dict
from .cut import joins, render_cut
from .plan import CutSettings, Segment, output_frames, plan
from .reframe import ReframeSettings, crop_path, ease_crop_across
from .render import render_vertical
from .transcribe import load_words, transcribe_ranges, words_path
from .util import probe

Progress = Callable[[str, float], None]  # (stage, 0..1 overall)

# rough share of total time per stage, for one overall progress bar
_STAGES = {"transcribe": (0.0, 0.15), "plan": (0.15, 0.2), "cut": (0.2, 0.35),
           "reframe": (0.35, 0.55), "render": (0.55, 1.0)}


@dataclass
class ShortOptions:
    ranges: list[tuple[float, float]]
    title: str | None = None
    style: str = "box"               # preset name or path to a style .json
    style_data: dict | None = None   # inline style (same shape as the .json), wins over `style`
    font: str | None = None
    min_gap: float = 0.40
    transition: str = "morph"        # morph | fade | cut
    transition_frames: int = 4
    zoom: float = 1.0
    grade: bool = False
    captions: bool = True
    language: str | None = "ar"
    model: str = "large-v3"
    device: str = "cuda"
    extra: dict = field(default_factory=dict)


def _stage(progress: Progress | None, name: str):
    lo, hi = _STAGES[name]

    def cb(frac: float) -> None:
        if progress:
            progress(name, lo + (hi - lo) * max(0.0, min(1.0, frac)))
    cb(0.0)
    return cb


def resolve_style(o: ShortOptions) -> Style:
    style = style_from_dict(o.style_data) if o.style_data else load_style(o.style)
    if o.font:
        style = replace(style, captions=replace(style.captions, font=o.font),
                        title=replace(style.title, font=o.font))
    return style


def get_words(video: Path, o: ShortOptions, progress: Progress | None = None) -> list[dict]:
    """Full transcript if there is one; else (for captions) just the ranges."""
    if words_path(video).exists():
        return load_words(video)
    if not o.captions:
        return []
    cb = _stage(progress, "transcribe")
    words = transcribe_ranges(video, o.ranges, model=o.model, language=o.language, device=o.device)
    cb(1.0)
    return words


def plan_short(video: Path, o: ShortOptions, words: list[dict]):
    info = probe(video)
    cs = CutSettings(min_gap=o.min_gap, fade_frames=o.transition_frames)
    segs, firsts = plan(video, o.ranges, words, info.fps, info.duration, cs)
    return info, segs, firsts


def estimate(video: Path, o: ShortOptions, words: list[dict] | None = None) -> dict:
    """Cheap preview of what the cut will do (no rendering)."""
    info, segs, _ = plan_short(video, o, words if words is not None else [])
    n_out = output_frames(segs, o.transition_frames)
    return {"selected": sum(b - a for a, b in o.ranges),
            "duration": float(n_out / info.fps),
            "cuts": len(segs) - 1,
            "segments": [[float(s.f0 / info.fps), float(s.f1 / info.fps)] for s in segs]}


def make_short(video: Path, out: Path, o: ShortOptions, progress: Progress | None = None,
               keep_temp: bool = False, log: Callable[[str], None] = print) -> dict:
    words = get_words(video, o, progress)
    cb = _stage(progress, "plan")
    info, segs, firsts = plan_short(video, o, words)
    fps, d = info.fps, o.transition_frames
    n_out = output_frames(segs, d)
    log(f"{len(segs)} segments, {len(segs) - 1} cuts, {float(n_out / fps):.1f}s output")
    cb(1.0)

    out.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="shorts-", dir=out.parent))
    try:
        (work / "segments.json").write_text(json.dumps(
            [{"src_start": float(s.f0 / fps), "src_end": float(s.f1 / fps)} for s in segs], indent=1))
        cut = work / "cut.mkv"
        cb = _stage(progress, "cut")
        render_cut(video, segs, fps, d, cut, work)
        cb(1.0)

        js = joins(segs, d)
        range_joins = [js[i - 1].cut for i in firsts[1:]]
        cb = _stage(progress, "reframe")
        path = crop_path(cut, ReframeSettings(zoom=o.zoom), forced=range_joins,
                         on_frame=lambda i: cb(i / n_out))

        # same camera -> synthesized transition; camera change -> clean hard cut
        windows, hard = {}, 0
        for j in js:
            if (o.transition == "cut"
                    or any(j.start <= c <= j.start + d for c in path.camera_changes)
                    or path.looks_different(j.start - 1, j.start + d)):
                hard += 1
                continue
            windows[j.start] = o.transition
            ease_crop_across(path, j.start, d)
        log(f"transitions: {len(windows)} {o.transition}, {hard} hard cuts")

        overlay = None
        if o.captions or o.title:
            style = resolve_style(o)
            chunks = chunk(map_words(words, segs, fps, d), style.captions) if o.captions else []
            overlay = Overlay(chunks, style, o.title)

        cb = _stage(progress, "render")
        render_vertical(cut, path, fps, windows, d, overlay, out, o.grade,
                        on_frame=lambda i: cb(i / n_out))
        cb(1.0)
        return {"duration": float(n_out / fps), "cuts": len(segs) - 1,
                "hard_cuts": hard, "camera_changes": len(path.camera_changes)}
    finally:
        if keep_temp:
            log(f"intermediates kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


__all__ = ["ShortOptions", "make_short", "estimate", "get_words", "resolve_style", "Segment"]
