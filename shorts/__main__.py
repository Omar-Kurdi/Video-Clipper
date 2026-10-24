"""CLI.

  python -m shorts transcribe lecture.mp4
  python -m shorts make lecture.mp4 --range 12:30-13:45 [--range 20:10-20:40] -o short.mp4
"""
import argparse
from pathlib import Path

from .cameras import load_or_analyze
from .pipeline import ShortOptions, make_short
from .transcribe import transcribe
from .util import parse_range


def cmd_transcribe(a) -> None:
    out = transcribe(a.video, model=a.model, language=a.lang or None, device=a.device)
    print(f"words: {out}\ntranscript: {a.video.with_suffix('.transcript.txt')}")


def cmd_make(a) -> None:
    o = ShortOptions(
        ranges=[parse_range(r) for r in a.range], title=a.title, style=a.style, font=a.font,
        min_gap=a.min_gap, transition=a.transition, transition_frames=a.transition_frames,
        zoom=a.zoom, grade=a.grade, captions=not a.no_captions, speed=a.speed,
        language=a.lang or None, model=a.model, device=a.device)
    if not a.no_lock:
        print("finding the lecturer and the camera positions (cached after the first run) ...")
        o.identity = load_or_analyze(a.video, a.video.with_suffix(".cameras.json"))
    make_short(a.video, a.output, o, keep_temp=a.keep_temp)
    print(f"done: {a.output}")


def main() -> None:
    p = argparse.ArgumentParser(prog="shorts", description="Lecture -> vertical short")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("video", type=Path)
        sp.add_argument("--model", default="large-v3")
        sp.add_argument("--lang", default="ar", help="language code, '' to auto-detect")
        sp.add_argument("--device", default="cuda", choices=["cuda", "cpu"])

    t = sub.add_parser("transcribe", help="transcribe once, writes .words.json + .transcript.txt")
    common(t)
    t.set_defaults(fn=cmd_transcribe)

    m = sub.add_parser("make", help="cut selected ranges into a 9:16 short")
    common(m)
    m.add_argument("--range", action="append", required=True,
                   help="START-END, e.g. 12:30-13:45.5 (repeatable, joined in order). No transcript needed: without one, only these ranges are transcribed")
    m.add_argument("-o", "--output", type=Path, required=True)
    m.add_argument("--title", help="name plate shown under the captions")
    m.add_argument("--min-gap", type=float, default=0.40, help="cut pauses longer than this (s)")
    m.add_argument("--transition", default="morph", choices=["morph", "fade", "cut"],
                   help="how pause cuts are smoothed (camera changes are always hard cuts)")
    m.add_argument("--transition-frames", "--fade-frames", type=int, default=4,
                   help="length of each transition in frames")
    m.add_argument("--zoom", type=float, default=1.0, help=">1 for a tighter crop")
    m.add_argument("--speed", type=float, default=1.0, help="export speed, e.g. 1.25 (voice pitch is kept)")
    m.add_argument("--style", default="pill",
                   help="caption preset (box, pill, outline, minimal) or a style .json")
    m.add_argument("--font", help="override the style font (fontconfig name or .ttf path)")
    m.add_argument("--grade", action="store_true", help="punchier contrast/sharpen/vignette")
    m.add_argument("--no-captions", action="store_true")
    m.add_argument("--no-lock", action="store_true",
                   help="follow the main face instead of recognising and locking on the lecturer")
    m.add_argument("--keep-temp", action="store_true")
    m.set_defaults(fn=cmd_make)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
