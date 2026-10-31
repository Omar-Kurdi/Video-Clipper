"""Who is talking: for podcasts and interviews with several people in one shot.

Each face's mouth is cut out a few times a second (anchored on YuNet's two
mouth-corner landmarks and scaled to a fixed size, so a big face and a small
one measure the same) and compared with the same mouth a moment earlier. A
mouth that keeps changing while there is sound is the one talking.

The decision is made per shot, in turns: the frame stays on one person, still,
until someone else has clearly been talking for a while, then it cuts to them,
at the start of their turn. It never pans from one person to the other.
"""
import subprocess
from pathlib import Path

import cv2
import numpy as np

PATCH = (24, 16)       # mouth cut-out size (w, h)
TRACK_DIST = 0.08      # a face this close (fraction of width) to a track's last spot is the same person
MIN_TRACK = 0.3        # people seen in less than this share of a shot's samples are ignored
SMOOTH = 1.0           # seconds: how much talking evidence is pooled
MIN_TURN = 1.5         # seconds someone must be ahead before the frame cuts to them
LEAD = 1.3             # ...and by how much (ratio of scores)
SR = 16000


def mouth_patch(gray: np.ndarray, f, scale: float = 1.0) -> np.ndarray | None:
    """A size-normalised grey cut-out of the mouth from a YuNet detection
    (coordinates in `gray`'s pixels divided by `scale`)."""
    rx, ry, lx, ly = (float(v) * scale for v in f[10:14])
    w = np.hypot(lx - rx, ly - ry)
    if w < 6:
        return None
    cx, cy = (rx + lx) / 2, (ry + ly) / 2
    hw, hh = w * 0.8, w * 0.55
    x0, x1, y0, y1 = int(cx - hw), int(cx + hw), int(cy - hh * 0.6), int(cy + hh * 1.4)
    H, W = gray.shape[:2]
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
        return None
    p = cv2.resize(gray[y0:y1, x0:x1], PATCH, interpolation=cv2.INTER_AREA).astype(np.float32)
    return (p - p.mean()) / (p.std() + 1e-3)


def audio_level(video: Path, times: np.ndarray, start: float = 0.0, win: float = 0.2) -> np.ndarray:
    """0..1 'there is speech' level at each time (seconds, relative to `start`)."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(video), "-vn",
                          "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.float32)
    if not len(a) or not len(times):
        return np.zeros(len(times))
    h = int(win * SR / 2)
    db = np.array([20 * np.log10(np.sqrt(np.mean(a[max(0, int(t * SR) - h): int(t * SR) + h] ** 2)) + 1e-6)
                   if int(t * SR) - h < len(a) else -120.0 for t in times])
    floor, loud = np.percentile(db, 10), np.percentile(db, 90)
    return np.clip((db - floor - 0.25 * (loud - floor)) / (0.5 * (loud - floor) + 1e-6), 0, 1)


def _tracks(samples, W: float) -> list[list]:
    """Group a shot's faces into people by where they sit. samples: [(t, faces)],
    faces: [(cx, cy, w, patch)]. Returns tracks of [(sample index, face)]."""
    tracks: list[list] = []
    for k, (_, faces) in enumerate(samples):
        used = set()
        for f in sorted(faces, key=lambda f: -f[2]):
            best = min((tr for tr in tracks if id(tr) not in used),
                       key=lambda tr: abs(tr[-1][1][0] - f[0]), default=None)
            if best is not None and abs(best[-1][1][0] - f[0]) < TRACK_DIST * W:
                best.append((k, f))
                used.add(id(best))
            else:
                tracks.append([(k, f)])
                used.add(id(tracks[-1]))
    return [tr for tr in tracks if len(tr) >= MIN_TRACK * len(samples)]


def _smooth(x: np.ndarray, sigma: float) -> np.ndarray:
    if sigma < 0.5 or len(x) < 3:
        return x
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    return np.convolve(np.pad(x, r, mode="edge"), k / k.sum(), mode="valid")


def turns(samples, speech: np.ndarray, W: float, rate: float) -> list[tuple[float, float] | None]:
    """For every sample of one shot: the (x, y) of the person talking, held
    still for their whole turn. None where nobody is found."""
    n = len(samples)
    tracks = _tracks(samples, W)
    if not tracks:
        return [None] * n
    pos = [(float(np.median([f[0] for _, f in tr])), float(np.median([f[1] for _, f in tr]))) for tr in tracks]
    if len(tracks) == 1:
        return [pos[0]] * n

    # how much each person's mouth changes, sample to sample. The cut-outs are already
    # normalised for size and contrast, so everyone is measured on the same scale
    act = np.zeros((len(tracks), n))
    for j, tr in enumerate(tracks):
        prev = None
        for k, f in tr:
            if f[3] is not None and prev is not None and prev[0] == k - 1:
                act[j, k] = float(np.mean(np.abs(f[3] - prev[1])))
            prev = (k, f[3]) if f[3] is not None else None
    score = np.array([_smooth(a * speech, SMOOTH * rate) for a in act])

    # turns with hysteresis: switch only when someone else leads clearly for MIN_TURN
    cur = int(np.argmax(score[:, : max(1, int(MIN_TURN * rate))].sum(axis=1)))
    who = np.empty(n, dtype=int)
    lead_since = None
    for k in range(n):
        best = int(np.argmax(score[:, k]))
        if best != cur and score[best, k] > LEAD * score[cur, k] + 0.05:
            if lead_since is None or lead_since[0] != best:
                lead_since = (best, k)
            if k - lead_since[1] >= MIN_TURN * rate:
                cur = best
                who[lead_since[1]: k] = cur  # the turn started when they took the lead
                lead_since = None
        else:
            lead_since = None
        who[k] = cur
    return [pos[j] for j in who]
