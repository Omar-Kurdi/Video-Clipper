"""Words the tashkeel reader adds with no Whisper word to time them by: repeats
of the words around them are dropped, the others get time from their
neighbours. No GPU needed.

    python tests/test_untimed.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shorts.tashkeel import _untimed, settle_untimed  # noqa: E402
from shorts.transcribe import settle_untimed_words  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def W(w: str, s: float, e: float, asr: str = "x") -> dict:
    return {"w": w, "s": s, "e": e, "asr": asr}


def U(w: str, t: float) -> dict:  # added by the reader: no time, nothing Whisper heard
    return {"w": w, "s": t, "e": t, "asr": ""}


def text(ws: list[dict]) -> str:
    return " ".join(w["w"] for w in ws)


out, n = settle_untimed([W("قال", 0, 1), U("بغير", 1), U("علم", 1), W("بغير", 1, 1.5), W("علم", 1.5, 2)])
check("a repeat of the words after it is dropped", text(out) == "قال بغير علم" and n == 2, text(out))

out, n = settle_untimed([W("عادل", 0, 0.5), U("عادل", 0.5), W("لكن", 0.5, 1)])
check("a repeat of the word before it is dropped", text(out) == "عادل لكن" and n == 1, text(out))

out, n = settle_untimed([W("الله", 0, 1), U("بغير", 1), U("علم", 1), U("ليضل", 1), U("عن", 1), U("سبيل", 1), U("الله", 1),
                         W("بغير", 1, 1.5), W("علم", 1.5, 2)],
                        before_ctx=[W("ليضل", -2, -1.5), W("عن", -1.5, -1), W("سبيل", -1, -0.5)])
check("a run made of what comes before and after is dropped", text(out) == "الله بغير علم", text(out))

out, n = settle_untimed([W("فهذا", 0, 0.5), U("فهذا", 0.5), U("اللفظ", 0.5)], after_ctx=[W("هذا", 1, 1.5), W("اللفظ", 1.5, 2)])
check("a leading و / ف doesn't hide a repeat", text(out) == "فهذا", text(out))

out, n = settle_untimed([W("يقول", 0, 1), U("أليس", 1), U("الله", 1), U("بكاف", 1), W("الباء", 1, 2)])
check("real words are kept", text(out) == "يقول أليس الله بكاف الباء" and n == 0, text(out))
check("and every word gets time", not any(_untimed(w) for w in out), [(w["w"], w["s"], w["e"]) for w in out])
check("in order, within the neighbours' time", out[0]["s"] == 0 and out[-1]["e"] == 2
      and all(a["e"] <= b["s"] + 1e-6 for a, b in zip(out, out[1:])), [(w["w"], w["s"], w["e"]) for w in out])

out, _ = settle_untimed([W("كيف", 0, 1), U("نكون", 1), U("هذا", 1)], limit=1.4)
check("never timed past the next sentence", out[-1]["e"] <= 1.4, [(w["w"], w["s"], w["e"]) for w in out])

data = {"words": [W("قال", 0, 1), U("قال", 1), W("نعم", 1, 2), W("هذا", 3, 4), U("هذا", 4)],
        "segments": [{"s": 0, "e": 2, "w0": 0, "w1": 3}, {"s": 3, "e": 4, "w0": 3, "w1": 5}]}
data, where, dropped = settle_untimed_words(data)
check("a whole transcript, sentence by sentence", text(data["words"]) == "قال نعم هذا" and dropped == 2
      and [(g["w0"], g["w1"]) for g in data["segments"]] == [(0, 2), (2, 3)] and where == [0, 1], (text(data["words"]), data["segments"]))

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
