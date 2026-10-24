"""Word and sentence corrections keep timings, marks and Quran/hadith spans
in step. No GPU needed.

    python tests/test_transcript_edit.py
"""
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.transcript_edit import replace_word, splice  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def sample() -> dict:
    """Two sentences of three words, one doubtful word, a hadith over sentence 2."""
    words = [{"w": w, "s": float(i), "e": i + 0.8} for i, w in enumerate("a b c d e f".split())]
    words[1] |= {"flag": "doubt", "alts": ["x", "y z"]}
    words[2] |= {"flag": "voted", "alts": ["c0"]}
    return {"words": words,
            "segments": [{"s": 0.0, "e": 2.8, "w0": 0, "w1": 3}, {"s": 3.0, "e": 5.8, "w0": 3, "w1": 6}],
            "sources": [{"type": "hadith", "w0": 3, "w1": 6}]}


# picking another reading keeps the word's time and the other words' marks
d = replace_word(sample(), 1, "x")
w = d["words"][1]
check("replaced word", w["w"] == "x" and (w["s"], w["e"]) == (1.0, 1.8), w)
check("its mark goes", "flag" not in w and "alts" not in w, w)
check("other marks stay", d["words"][2].get("flag") == "voted", d["words"][2])
check("sentence marked edited, original kept", d["segments"][0].get("edited") and d["segments"][0]["orig"][1]["w"] == "b", d["segments"][0])

# keeping it clears only the mark
d = replace_word(sample(), 1, None)
check("keep: text unchanged, mark gone", d["words"][1]["w"] == "b" and "flag" not in d["words"][1], d["words"][1])

# a two-word reading shares the word's time and shifts what follows
d = replace_word(sample(), 1, "y z")
ws = d["words"]
check("two words in the slot", [x["w"] for x in ws[:4]] == ["a", "y", "z", "c"], [x["w"] for x in ws])
check("they share its time", ws[1]["s"] == 1.0 and ws[2]["e"] == 1.8 and ws[1]["e"] <= ws[2]["s"], ws[1:3])
check("sentences shift", d["segments"][0]["w1"] == 4 and d["segments"][1] == {"s": 3.0, "e": 5.8, "w0": 4, "w1": 7}, d["segments"])
check("hadith span shifts", d["sources"][0]["w0"] == 4 and d["sources"][0]["w1"] == 7, d["sources"])

# an empty reading removes the word (others heard nothing there)
d = replace_word(sample(), 1, "")
check("word removed", [x["w"] for x in d["words"]] == ["a", "c", "d", "e", "f"], [x["w"] for x in d["words"]])
check("spans shift back", d["segments"][1]["w0"] == 2 and d["sources"][0] == {"type": "hadith", "w0": 2, "w1": 5}, (d["segments"], d["sources"]))

# a sentence can't lose its only word
one = {"words": [{"w": "a", "s": 0.0, "e": 0.5, "flag": "doubt", "alts": []}], "segments": [{"s": 0.0, "e": 0.5, "w0": 0, "w1": 1}]}
try:
    replace_word(copy.deepcopy(one), 0, "")
    check("empty sentence refused", False, "no error")
except ValueError:
    check("empty sentence refused", True)

# a span that ends inside a shrunk region is clipped, not lost
d = sample()
d["sources"] = [{"type": "quran", "w0": 1, "w1": 3}]
splice(d, 0, 1, 3, [{"w": "q", "s": 1.0, "e": 2.8}])
check("span clipped to the new words", d["sources"] == [{"type": "quran", "w0": 1, "w1": 2}], d["sources"])

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
