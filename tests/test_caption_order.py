"""Caption words keep their order across a cut (no video, no models).

    python tests/test_caption_order.py
"""
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shorts.captions import map_words  # noqa: E402
from shorts.plan import Segment  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


FPS = Fraction(25)
# two kept stretches, 0-2 s and 3-5 s, with the pause between them removed and a 4-frame blend
SEGS = [Segment(0, 50), Segment(75, 125)]


def word(w, s, e):
    return {"w": w, "s": s, "e": e}


# a translated sentence spread evenly over 1.6-3.4 s: "ibn" falls in the removed pause
words = [word("Amr", 1.6, 1.95), word("ibn", 2.3, 2.6), word("Rabi'ah,", 2.95, 3.4), word("he", 3.5, 3.8)]
mapped = map_words(words, SEGS, FPS, 4, keep_all=True)
check("every word is kept", len(mapped) == 4, len(mapped))
check("in the order given", [m[0] for m in mapped] == ["Amr", "ibn", "Rabi'ah,", "he"], [m[0] for m in mapped])
check("times never go back", all(a[1] <= b[1] for a, b in zip(mapped, mapped[1:])), [m[1] for m in mapped])
check("a word never ends before it starts", all(m[1] <= m[2] for m in mapped), [(m[1], m[2]) for m in mapped])

# words that sit inside the kept stretches are placed exactly as before
plain = map_words([word("a", 0.5, 0.9), word("b", 3.5, 3.9)], SEGS, FPS, 4)
check("a word inside a stretch keeps its place", abs(plain[0][1] - 0.5) < 1e-6 and abs(plain[0][2] - 0.9) < 1e-6, plain[0])
check("a word after the cut moves up by the pause less the blend", abs(plain[1][1] - (3.5 - 1.0 - 4 / 25)) < 1e-6, plain[1])

if failures:
    sys.exit(f"{len(failures)} failed")
print("all passed")
