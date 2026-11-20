"""Captions split as spoken (no video, no models).

    python tests/test_caption_split.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shorts.captions import PRESETS, spoken_chunks  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


# three lines of a transcript, and how they should come out as captions
LINES = [
    "وَانْشَقَّ الْقَمَرُ فِي عَهْدِ رَسُولِ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ",
    "حَتَّى رَآهُ النَّاسُ وَإِنَّمَا رَآهُ مَنْ كَانَ حَاضِرًا",
    "أَوْ مَنِ اتَّفَقَ نَظَرُهُ إِلَى الْقَمَرْ فِي ذلك الْوَقْتْ",
]
WANT = [
    "وَانْشَقَّ الْقَمَرُ",
    "فِي عَهْدِ رَسُولِ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ",
    "حَتَّى رَآهُ النَّاسُ",
    "وَإِنَّمَا رَآهُ",
    "مَنْ كَانَ حَاضِرًا",
    "أَوْ مَنِ اتَّفَقَ نَظَرُهُ إِلَى الْقَمَرْ",
    "فِي ذلك الْوَقْتْ",
]
paused_before = {len(" ".join(WANT[:k]).split()) for k in range(1, len(WANT))}  # word indices
line_starts = {len(" ".join(LINES[:k]).split()) for k in range(1, len(LINES))}

words, t = [], 0.0
for i, w in enumerate(" ".join(LINES).split()):
    t += 0.25 if i in paused_before else 0.0
    words.append((w, t, t + 0.4, i, t, t + 0.4))  # timed back to back, as the recognisers often give them
    t += 0.4


def hard(a, b):
    return b[3] in line_starts


def audio_pause(a, b):
    return 0.25 if b[3] in paused_before else 0.0


def texts(chunks):
    return [" ".join(w[0] for w in c) for c in chunks]


for style in ("pill", "phrase", "outline"):
    ts = PRESETS[style].captions
    got = texts(spoken_chunks(words, ts, pause_of=audio_pause, hard=hard))
    check(f"{style}: split where the speaker pauses", got == WANT, got)

    got = texts(spoken_chunks(words, ts, pause_of=lambda a, b: 0.0, hard=hard))
    check(f"{style}: no pauses heard: each transcript line still starts a caption",
          all(any(g.startswith(line.split()[0]) for g in got) for line in LINES), got)
    check(f"{style}: no pauses heard: the formula stays with the Prophet's name",
          any("رَسُولِ اللَّهِ صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ" in g for g in got), got)
    check(f"{style}: no pauses heard: never a caption ending in a particle",
          not any(g.split()[-1] in ("فِي", "مَنْ", "إِلَى", "مَنِ") for g in got), got)

# a short breath after a particle is a hesitation, not the end of a caption
hes = [("وَلَمْ", 0, 0.3, 0, 0, 0.3), ("تَخُطَّ", 0.5, 0.9, 1, 0.5, 0.9), ("أَنَامِلُهُمْ", 0.9, 1.5, 2, 0.9, 1.5)]
got = texts(spoken_chunks(hes, PRESETS["pill"].captions, pause_of=lambda a, b: 0.2 if b[3] == 1 else 0.0))
check("no caption is left with only a particle", got == ["وَلَمْ تَخُطَّ أَنَامِلُهُمْ"], got)

# a long dramatic pause after one word: that word may stand alone
lone = [("العرب", 0, 0.5, 0, 0, 0.5), ("تُسَمِّي", 1.9, 2.3, 1, 1.9, 2.3), ("الْخَيَّاطَ", 2.3, 2.8, 2, 2.3, 2.8),
        ("كَاتِبًا", 2.8, 3.3, 3, 2.8, 3.3)]
got = texts(spoken_chunks(lone, PRESETS["pill"].captions, pause_of=lambda a, b: 1.4 if b[3] == 1 else 0.0))
check("a long pause after one word ends the caption", got == ["العرب", "تُسَمِّي الْخَيَّاطَ كَاتِبًا"], got)

print("all passed" if not failures else f"{len(failures)} failed")
sys.exit(1 if failures else 0)
