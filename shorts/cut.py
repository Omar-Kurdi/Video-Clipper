"""Stage 1: render kept segments back to back.

Video is joined with hard cuts; the transition frames are synthesized later
(see transitions.py), where we know whether a join stays on the same camera.
Audio is crossfaded over the same number of frames, so both streams have the
same length: sum(L) - (n-1) * d frames.

One seeked input per segment (no `split` over the hour-long source), every
segment a whole number of frames.
"""
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from .plan import Segment, output_starts
from .util import run

AR = 48000


@dataclass
class Join:
    start: int  # first output frame of the transition window
    cut: int    # output frame where the incoming segment's first frame sits


def joins(segs: list[Segment], d: int) -> list[Join]:
    a = d // 2       # trimmed from the end of the outgoing segment
    b = d - a        # trimmed from the start of the incoming segment
    return [Join(s, s + b) for s in output_starts(segs, d)[1:]]


def render_cut(video: Path, segs: list[Segment], fps: Fraction, d: int,
               out: Path, workdir: Path) -> None:
    n = len(segs)
    a, b = d // 2, d - d // 2
    inputs: list[str] = []
    lines: list[str] = []
    for i, seg in enumerate(segs):
        t0 = seg.f0 / fps
        inputs += ["-ss", f"{float(t0):.6f}", "-t", f"{float(seg.frames / fps) + 0.5:.6f}",
                   "-i", str(video)]
        v0 = b if i > 0 else 0
        v1 = seg.frames - (a if i < n - 1 else 0)
        lines.append(f"[{i}:v]setpts=PTS-STARTPTS,fps={fps},trim=start_frame={v0}:end_frame={v1},"
                     f"setpts=PTS-STARTPTS,format=yuv420p[v{i}];")
        samples = round(seg.frames * AR / fps)
        lines.append(f"[{i}:a]aresample={AR},aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,"
                     f"atrim=end_sample={samples},asetpts=PTS-STARTPTS[a{i}];")

    lines.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vout];")

    fade = float(d / fps)
    aprev = "a0"
    for i in range(1, n):
        ao = "aout" if i == n - 1 else f"ax{i}"
        lines.append(f"[{aprev}][a{i}]acrossfade=d={fade:.6f}:c1=qsin:c2=qsin[{ao}];")
        aprev = ao
    if n == 1:
        lines.append("[a0]anull[aout];")

    script = workdir / "cut.filtergraph"
    script.write_text("\n".join(lines).rstrip(";") + "\n")
    run(["ffmpeg", "-v", "error", "-stats", "-y", *inputs,
         "-/filter_complex", str(script),
         "-map", "[vout]", "-map", "[aout]", "-r", str(fps),
         "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "16", "-b:v", "0",
         "-c:a", "pcm_s16le", str(out)])
