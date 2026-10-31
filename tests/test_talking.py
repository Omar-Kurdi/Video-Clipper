"""Choosing whoever is talking, on described shots (no video, no models).

    python tests/test_talking.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shorts.talking import turns  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


RATE, W = 5.0, 1920.0
rng = np.random.default_rng(0)


def shot(talker, n):
    """Two people at x=500 and x=1400; talker(k) says who moves their mouth at sample k."""
    samples = []
    for k in range(n):
        faces = []
        for who, x in ((0, 500.0), (1, 1400.0)):
            amp = 1.0 if talker(k) == who else 0.08
            faces.append((x, 400.0, 120.0, rng.normal(0, amp, (16, 24)).astype(np.float32)))
        samples.append((k / RATE, faces))
    return samples


n = 100
picks = turns(shot(lambda k: 1, n), np.ones(n), W, RATE)
check("the person whose mouth moves is framed", all(p and p[0] == 1400.0 for p in picks), picks[:3])

picks = turns(shot(lambda k: 0 if k < 50 else 1, n), np.ones(n), W, RATE)
xs = [p[0] for p in picks]
check("starts on the first talker", xs[10] == 500.0, xs[10])
check("cuts to the second talker", xs[90] == 1400.0, xs[90])
check("one cut, no back and forth", sum(a != b for a, b in zip(xs, xs[1:])) == 1, xs)
cut = next(k for k in range(1, n) if xs[k] != xs[k - 1])
check("the cut lands near where the turn starts", 44 <= cut <= 56, cut)

# a single interjection shorter than a turn doesn't pull the frame away
picks = turns(shot(lambda k: 1 if 40 <= k < 44 else 0, n), np.ones(n), W, RATE)
check("a short interjection is ignored", all(p[0] == 500.0 for p in picks), [p[0] for p in picks])

# mouth movement with no sound (smiling, chewing) doesn't count
speech = np.r_[np.ones(50), np.zeros(50)]
picks = turns(shot(lambda k: 0 if k < 50 else 1, n), speech, W, RATE)
check("moving mouth in silence is not talking", picks[90][0] == 500.0, picks[90])

# one person in the shot: just them
one = [(k / RATE, [(800.0, 400.0, 120.0, rng.normal(0, 1, (16, 24)).astype(np.float32))]) for k in range(20)]
check("one person: framed throughout", all(p == (800.0, 400.0) for p in turns(one, np.ones(20), W, RATE)))
check("nobody: nothing to frame", turns([(0.0, [])] * 5, np.ones(5), W, RATE) == [None] * 5)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
