"""Synthesize the frames at each pause cut.

Inside a transition window [start, start + d) the frames are rebuilt from the
last frame before it (P) and the first frame after it (Q):

  morph - optical-flow warp of P toward Q and Q toward P, blended (like
          Premiere's Morph Cut / Resolve's Smooth Cut). Hides head/hand jumps.
  fade  - eased dissolve P -> Q.
  cut   - leave the hard cut.

Joins that coincide with a camera change are always left as hard cuts.
"""
from collections import deque
from typing import Iterator

import cv2
import numpy as np

FLOW_SCALE = 0.5


def _ease(t: float) -> float:
    return t * t * (3 - 2 * t)  # smoothstep


def _flows(P: np.ndarray, Q: np.ndarray):
    h, w = P.shape[:2]
    sw, sh = int(w * FLOW_SCALE), int(h * FLOW_SCALE)
    gp = cv2.cvtColor(cv2.resize(P, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    gq = cv2.cvtColor(cv2.resize(Q, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    up = lambda f: cv2.resize(f, (w, h), interpolation=cv2.INTER_LINEAR) / FLOW_SCALE
    return up(dis.calc(gp, gq, None)), up(dis.calc(gq, gp, None))


def transition_frames(P: np.ndarray, Q: np.ndarray, d: int, mode: str) -> list[np.ndarray]:
    ts = [_ease((k + 1) / (d + 1)) for k in range(d)]
    if mode == "fade":
        return [cv2.addWeighted(P, 1 - t, Q, t, 0) for t in ts]

    f_pq, f_qp = _flows(P, Q)
    h, w = P.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    out = []
    for t in ts:
        # pixel y at time t came from P at y - t*f_pq and from Q at y - (1-t)*f_qp
        wp = cv2.remap(P, gx - t * f_pq[..., 0], gy - t * f_pq[..., 1],
                       cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        wq = cv2.remap(Q, gx - (1 - t) * f_qp[..., 0], gy - (1 - t) * f_qp[..., 1],
                       cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        out.append(cv2.addWeighted(wp, 1 - t, wq, t, 0))
    return out


def with_transitions(frames: Iterator[np.ndarray], windows: dict[int, str],
                     d: int) -> Iterator[tuple[int, np.ndarray]]:
    """Yield (index, frame), replacing each window start->start+d per its mode."""
    it = enumerate(frames)
    ahead: deque = deque()
    prev = None
    while True:
        item = ahead.popleft() if ahead else next(it, None)
        if item is None:
            return
        i, f = item
        mode = windows.get(i)
        if mode in ("morph", "fade") and prev is not None:
            win = [f]
            while len(win) < d + 1:
                nx = next(it, None)
                if nx is None:
                    break
                win.append(nx[1])
            if len(win) == d + 1:
                for k, m in enumerate(transition_frames(prev, win[-1], d, mode)):
                    yield i + k, m
                ahead.append((i + d, win[-1]))
            else:  # hit EOF, keep originals
                for k, w in enumerate(win):
                    yield i + k, w
                return
            continue
        yield i, f
        prev = f
