"""Render a short and check it is exactly what the editor showed.

    python tests/verify_render.py <lecture video> --range 322-360 [--zoom 0.8]

Checks:
  1. the cut plan (segments, length) equals the editor's estimate/preview plan
  2. the output length (video and audio) equals the plan, to the frame
  3. sampled output frames equal the planned crop of the source at the mapped
     time (captions off), i.e. the right moments, framed as planned
  4. manual camera framing and per-camera zoom were applied
  5. audio is in sync with the source at the mapped times
Exit code 0 when everything matches.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shorts.cameras import framing, match_camera, signature  # noqa: E402
from shorts.pipeline import ShortOptions, estimate, make_short  # noqa: E402
from shorts.plan import output_starts  # noqa: E402
from shorts.render import compose  # noqa: E402
from shorts.transcribe import load_words, words_path  # noqa: E402
from shorts.util import parse_range, probe  # noqa: E402


def frame_at(video: Path, t: float, w: int, h: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.4f}", "-i", str(video), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8)[: w * h * 3].reshape(h, w, 3)


def audio_at(video: Path, t: float, dur: float) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.4f}", "-t", f"{dur:.4f}", "-i", str(video),
                          "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--range", action="append", required=True)
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--transition", default="morph")
    ap.add_argument("--samples", type=int, default=12)
    a = ap.parse_args()

    video = a.video
    info = probe(video)
    cams_file = video.with_suffix(".cameras.json")
    identity = json.loads(cams_file.read_text()) if cams_file.exists() else None
    o = ShortOptions(ranges=[parse_range(r) for r in a.range], captions=False, zoom=a.zoom,
                     transition=a.transition, identity=identity)
    words = load_words(video) if words_path(video).exists() else []
    est = estimate(video, o, words)

    work = Path(tempfile.mkdtemp(prefix="verify-"))
    out, rep_file = work / "short.mp4", work / "report.json"
    make_short(video, out, o, report=rep_file, log=lambda m: None)
    rep = json.loads(rep_file.read_text())
    fps = Fraction(*rep["fps"])
    d = rep["fade"]
    segs = rep["segments"]
    ok = True

    def check(name: str, passed: bool, detail: str) -> None:
        nonlocal ok
        ok &= passed
        print(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}")

    # 1. same plan as the editor
    est_segs = [[round(s0 * float(fps)), round(s1 * float(fps))] for s0, s1 in est["segments"]]
    check("plan = editor preview", est_segs == segs, f"{len(segs)} segments, estimate {len(est_segs)}")

    # 2. length
    n_plan = sum(f1 - f0 for f0, f1 in segs) - d * (len(segs) - 1)
    durs = {}
    for st in ("v:0", "a:0"):
        durs[st] = float(subprocess.run(["ffprobe", "-v", "error", "-select_streams", st, "-show_entries",
                                         "stream=duration", "-of", "csv=p=0", str(out)],
                                        capture_output=True, text=True).stdout.strip())
    plan_s = n_plan / float(fps)
    check("length", abs(durs["v:0"] - plan_s) <= 1 / float(fps) and abs(durs["a:0"] - plan_s) <= 0.05,
          f"plan {plan_s:.3f}s, video {durs['v:0']:.3f}s, audio {durs['a:0']:.3f}s, editor estimate {est['duration']:.3f}s")

    # map output frame -> source frame (outside synthesized transitions)
    starts = output_starts([type("S", (), {"frames": f1 - f0})() for f0, f1 in segs], d)
    win = {int(k) for k in rep["windows"]}
    blocked = {j for s0 in win for j in range(s0 - 1, s0 + d + 1)}
    a_trim, b_trim = d // 2, d - d // 2
    mapping = []
    for k, (f0, f1) in enumerate(segs):
        lo = starts[k] + (b_trim if k > 0 else 0)
        hi = starts[k] + (f1 - f0) - (a_trim if k < len(segs) - 1 else 0)
        for j in range(lo, hi):
            if j not in blocked:
                mapping.append((j, f0 + (j - starts[k])))

    # 3. frames
    rng = np.random.default_rng(1)
    picks = sorted(rng.choice(len(mapping), size=min(a.samples, len(mapping)), replace=False))
    W, H = info.width, info.height
    worst = 99.0
    cap = cv2.VideoCapture(str(out))
    for idx in picks:
        j, src = mapping[idx]
        cap.set(cv2.CAP_PROP_POS_FRAMES, j)
        okf, got = cap.read()
        sf = frame_at(video, src / float(fps), W, H)
        x, y, cw, ch = rep["xs"][j], rep["ys"][j], rep["cws"][j], rep["chs"][j]
        want = compose(sf[y:y + ch, x:x + cw])
        worst = min(worst, psnr(cv2.resize(got, (270, 480)), cv2.resize(want, (270, 480))) if okf else 0)
    cap.release()
    check("frames = planned crop of the source", worst > 28, f"lowest PSNR over {len(picks)} frames {worst:.1f} dB (> 28 expected)")

    # 4. manual framing / per-camera zoom
    if identity:
        hits, misses = 0, 0
        for idx in picks:
            j, src = mapping[idx]
            cam = match_camera(identity, signature(frame_at(video, src / float(fps), W, H)))
            if not cam:
                continue
            cw, ch = rep["cws"][j], rep["chs"][j]
            if cam.get("manual"):
                cx = rep["xs"][j] + cw / 2
                exp = min(max(cam["manual"]["x"] * W, cw / 2), W - cw / 2)
                hits += abs(cx - exp) <= 2
                misses += abs(cx - exp) > 2
            if cam.get("zoom"):
                from shorts.reframe import crop_size
                hits += (ch, cw) == crop_size(W, H, cam["zoom"])
                misses += (ch, cw) != crop_size(W, H, cam["zoom"])
        check("manual framing / camera zoom applied", misses == 0,
              f"{hits} checks passed, {misses} failed" if hits + misses else "no manual cameras in these clips")

    # 5. audio sync: correlate 0.5 s of output against the source around the mapped time
    worst_off, offs = 0.0, []
    join_t = [s0 / float(fps) for s0 in starts[1:]]
    # windows that don't touch a join (where audio from two clips is crossfaded)
    clean = [m for m in mapping if all(not (jt - 0.7 < m[0] / float(fps) < jt + d / float(fps) + 0.1) for jt in join_t)]
    for j, src in clean[:: max(1, len(clean) // 8)]:
        t_out, t_src = j / float(fps), src / float(fps)
        x = audio_at(out, t_out, 0.5)
        y = audio_at(video, t_src - 0.1, 0.7)
        if len(x) < 4000 or np.std(x) < 1e-3:
            continue
        corr = np.correlate(y, x, mode="valid")
        off = (int(np.argmax(corr)) - 1600) / 16000
        offs.append(round(off * 1000))
        worst_off = max(worst_off, abs(off))
    check("audio in sync", worst_off <= 0.02, f"largest offset {worst_off * 1000:.0f} ms over {len(offs)} windows {offs}")

    print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED", f"(output: {out})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
