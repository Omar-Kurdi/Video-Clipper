"""Stage 1: render kept segments back to back.

Video is joined with hard cuts; the transition frames are synthesized later
(see transitions.py), where we know whether a join stays on the same camera.
Audio is crossfaded over the same number of frames, so both streams have the
same length: sum(L) - (n-1) * d frames.

Each ffmpeg pass opens at most GROUP inputs (each a seeked decoder limited to
two threads). Long shorts are built in passes: groups are rendered to
intermediate files, which are then joined the same way. Opening hundreds of
decoders at once (one per kept segment of a whole lecture) exhausts memory.
"""
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from .plan import Segment, output_starts
from .util import encode_args, run

AR = 48000
GROUP = 8              # max decoders per ffmpeg pass
DECODER_THREADS = "2"


@dataclass
class Join:
    start: int  # first output frame of the transition window
    cut: int    # output frame where the incoming segment's first frame sits


def joins(segs: list[Segment], d: int) -> list[Join]:
    a = d // 2       # trimmed from the end of the outgoing segment
    b = d - a        # trimmed from the start of the incoming segment
    return [Join(s, s + b) for s in output_starts(segs, d)[1:]]


@dataclass
class _Piece:
    path: Path
    f0: int       # first frame in that file
    frames: int


def _join(pieces: list[_Piece], fps: Fraction, d: int, out: Path, script: Path,
          on_done=None) -> None:
    """One ffmpeg pass: pieces back to back, inner joins trimmed/crossfaded."""
    n = len(pieces)
    a, b = d // 2, d - d // 2
    inputs: list[str] = []
    lines: list[str] = []
    for i, p in enumerate(pieces):
        inputs += ["-threads", DECODER_THREADS, "-ss", f"{float(p.f0 / fps):.6f}",
                   "-t", f"{float(p.frames / fps) + 0.5:.6f}", "-i", str(p.path)]
        v0 = b if i > 0 else 0
        v1 = p.frames - (a if i < n - 1 else 0)
        lines.append(f"[{i}:v]setpts=PTS-STARTPTS,fps={fps},trim=start_frame={v0}:end_frame={v1},"
                     f"setpts=PTS-STARTPTS,format=yuv420p[v{i}];")
        samples = round(p.frames * AR / fps)
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
    script.write_text("\n".join(lines).rstrip(";") + "\n")
    run(["ffmpeg", "-v", "error", "-stats", "-y", *inputs,
         "-/filter_complex", str(script),
         "-map", "[vout]", "-map", "[aout]", "-r", str(fps),
         *encode_args(15), "-c:a", "pcm_s16le", str(out)])
    if on_done:
        on_done()


def render_cut(video: Path, segs: list[Segment], fps: Fraction, d: int,
               out: Path, workdir: Path, on_progress=None) -> None:
    pieces = [_Piece(video, s.f0, s.frames) for s in segs]
    # count passes up front for progress
    total, k = 0, len(pieces)
    while k > GROUP:
        k = -(-k // GROUP)
        total += k
    total += 1
    done = [0]

    def tick():
        done[0] += 1
        if on_progress:
            on_progress(done[0] / total)

    level = 0
    while len(pieces) > GROUP:
        nxt = []
        for g in range(0, len(pieces), GROUP):
            group = pieces[g:g + GROUP]
            part = workdir / f"pass{level}_{g // GROUP}.mkv"
            _join(group, fps, d, part, workdir / "cut.filtergraph", tick)
            nxt.append(_Piece(part, 0, sum(p.frames for p in group) - d * (len(group) - 1)))
        if level > 0:  # earlier intermediates are no longer needed
            for p in pieces:
                p.path.unlink(missing_ok=True)
        pieces, level = nxt, level + 1
    _join(pieces, fps, d, out, workdir / "cut.filtergraph", tick)
    if level > 0:
        for p in pieces:
            p.path.unlink(missing_ok=True)
