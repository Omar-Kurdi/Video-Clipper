"""Regression tests for Quran/hadith recognition, the title vocabulary and the
word alignment. Each case comes from a real lecture where something went
wrong. No GPU needed (the Quran and hadith texts download on first run).

    python tests/test_sources.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shorts.sources import annotate, apply_vocab, find_quran, norm  # noqa: E402
from shorts.tashkeel import align  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def refs(text: str) -> list[tuple[str, int, int]]:
    return [(q["ref"], q["w0"], q["w1"]) for q in find_quran(text.split())]


def transcript(text: str, **extra) -> dict:
    """A transcript dict with one word per second; extra[i] = fields for word i."""
    words = [{"w": w, "s": float(i), "e": i + 0.9} for i, w in enumerate(text.split())]
    for i, fields in extra.items():
        words[int(i)].update(fields)
    return {"words": words, "segments": [{"s": 0.0, "e": float(len(words)), "w0": 0, "w1": len(words)}]}


# ---------- Quran ----------

# a two-word ayah right after a cue (al-Rijz 0:59), and the lecturer repeating it
r = refs("قال ربنا سبحانه والرجز فاهجر والرجز فاهجر اي عبادة الاوثان")
check("74:5 after «قال ربنا»", r[:1] == [("المدثر 74:5", 3, 5)], r)
check("74:5 said again right after", len(r) == 2 and r[1][0] == "المدثر 74:5", r)
check("two words without a cue are not Quran", refs("وقال الشيخ والرجز فاهجر اي عبادة") == [])

# after a cue, words found in many places are Quran but name no surah/ayah
r = refs("قال الله تعالى ان الله غفور رحيم ثم قال الشيخ")
check("ambiguous place: no surah/ayah claimed", len(r) == 1 and r[0][0].startswith("~"), r)
check("a cue introduces one quotation only", len(r) == 1, r)

# «يا موسى» = mushaf «يَٰمُوسَىٰ»; one misheard word (عنه for عنهم) bridged inside the verse
d = annotate(transcript("ولما وقع عليهم الرجز قالوا يا موسى ادع لنا ربك بما عهد عندك لئن كشفت عنه الرجز لنؤمنن لك"))
q = [s for s in d["sources"] if s["type"] == "quran"]
words = [w["w"] for w in d["words"]]
check("7:134 found as one quotation", len(q) == 1 and q[0]["ref"] == "الأعراف 7:134", q)
check("«يا موسى» becomes «يَٰمُوسَىٰ»", any(norm(w) == "يموسي" for w in words), words)
check("«عنه» inside the verse becomes «عَنَّا»", "عنه" not in words, words)

# another recogniser's reading counts (al-Rijz 0:16: Cohere «مزعومون», Whisper «موسى»)
d = annotate(transcript("ولما وقع عليهم الرجز قالوا يا مزعومون", **{"6": {"alts": ["موسى"]}}))
check("Quran match uses other readings", any(norm(w["w"]) == "يموسي" for w in d["words"]), [w["w"] for w in d["words"]])

# a reading under discussion keeps the lecturer's harakat
d = annotate(transcript("وفي قراءة يعقوب قال ربنا وَالرِّجْزَ فَاهْجُرْ بالكسر"))
check("qira'at: lecturer's harakat kept", d["words"][5]["w"] == "وَالرِّجْزَ" and d["words"][5].get("quran"),
      d["words"][5])

# ---------- hadith ----------

# «قال صلى الله عليه وسلم» is a cue; a short hadith; the collection's wording fixes a word another model heard
d = annotate(transcript("قال صلى الله عليه وسلم الطاعون ريجز الرجز يطلق ويراد به العذاب",
                        **{"6": {"flag": "doubt", "alts": ["رج", "رجز"]}}))
h = [s for s in d["sources"] if s["type"] == "hadith"]
check("short hadith after «قال ﷺ» found (Muslim 2218)", h and (h[0]["ref"] or "").startswith("Sahih Muslim 2218"), h)
check("hadith wording fixes «ريجز» -> «رِجْزٌ»", d["words"][6]["w"] == "رِجْزٌ", d["words"][6])
check("the lecturer's words after the hadith are untouched", [w["w"] for w in d["words"][7:]] ==
      "الرجز يطلق ويراد به العذاب".split())

# attribution words are never "corrected" from a hadith's text
d = annotate(transcript("رواه البخاري ومسلم قال رسول الله صلى الله عليه وسلم السواك مطهرة للفم مرضاة للرب",
                        **{"2": {"flag": "doubt", "alts": ["وسلم"]}}))
check("«ومسلم» stays (not «وسلم»)", d["words"][2]["w"] == "ومسلم", d["words"][2])

# attribution alone («رواه البخاري ومسلم») is not named as a hadith; the hadith after it is
d = annotate(transcript("روى البخاري ومسلم في صحيحيهما عن عائشة رضي الله عنها ان رسول الله صلى الله عليه وسلم "
                        "قال السواك مطهرة للفم مرضاة للرب"))
h = [s for s in d["sources"] if s["type"] == "hadith" and s["ref"]]
check("attribution words don't end a hadith span", h and norm(d["words"][h[0]["w1"] - 1]["w"]) == "للرب",
      [(s["ref"], " ".join(w["w"] for w in d["words"][s["w0"]:s["w1"]])) for s in h])

# ---------- lecture vocabulary ----------

TITLE = "ما الفرق بين الرِّجز والرِّجس؟ فرقٌ دقيق قد لا تعرفه ـ الشيخ سعيد الكملي"
ws = [{"w": "الرجز"}, {"w": "يطلق"}, {"w": "والرجل", "flag": "doubt", "alts": ["والرج"]}, {"w": "يطلق"},
      {"w": "الرجل"}, {"w": "قال", "flag": "doubt"}]
apply_vocab(ws, TITLE)
check("doubtful «والرجل» -> «والرِّجز» (title word)", ws[2]["w"] == "والرِّجز" and ws[2]["flag"] == "voted", ws[2])
check("undoubted «الرجل» is left alone", ws[4]["w"] == "الرجل", ws[4])
check("unrelated doubtful word left alone", ws[5]["w"] == "قال", ws[5])

# ---------- alignment (al-Rijz 1:30, the duplicated sentence) ----------

asr = [{"w": w, "s": float(i), "e": i + 0.9} for i, w in enumerate("ويقال بالزاي رجز ويقال بالسيم رجز".split())]
out = align(asr, "ويقال بالزاي الرجز ويقال بالسين رجز")
check("each word lands on its own Whisper word", [w["src"] for w in out] == [0, 1, 2, 3, 4, 5], [(w["w"], w["src"]) for w in out])

# ---------- re-checking is stable ----------

d = annotate(transcript("قال ربنا سبحانه والرجز فاهجر ولما وقع عليهم الرجز قالوا يا موسى ادع لنا ربك"))
again = annotate({**d, "words": [dict(w) for w in d["words"]]})
check("annotating twice gives the same text", [w["w"] for w in d["words"]] == [w["w"] for w in again["words"]])

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
