"""Corrections to a transcript dict (words, segments, sources), without I/O.

Every edit keeps the sentence's recognised words in seg["orig"] the first time,
so "revert to recognised text" can undo any mix of sentence and word edits.
"""


def segment_of(data: dict, i: int) -> int:
    for k, seg in enumerate(data["segments"]):
        if seg["w0"] <= i < seg["w1"]:
            return k
    raise IndexError("no such word")


def splice(data: dict, k: int, a: int, b: int, new: list[dict]) -> None:
    """Replace words[a:b] (inside sentence k) with `new`, keeping later word
    indices right in the sentences and in the Quran/hadith spans."""
    delta = len(new) - (b - a)
    data["words"][a:b] = new
    segs = data["segments"]
    segs[k]["w1"] += delta
    for later in segs[k + 1:]:
        later["w0"] += delta
        later["w1"] += delta
    if delta:
        end = a + len(new)
        shift = lambda x: x + delta if x >= b else min(x, end)  # noqa: E731
        for src in data.get("sources") or []:
            src["w0"], src["w1"] = shift(src["w0"]), shift(src["w1"])
        data["sources"] = [s for s in data.get("sources") or [] if s["w1"] > s["w0"]]


def replace_word(data: dict, i: int, text: str | None) -> dict:
    """Settle a word the recognisers disagreed on.

    text = None keeps the word as it is (only the doubt mark goes); otherwise
    the word becomes `text`, which may be several words (they share its time)
    or empty (the word is removed). The other words keep their timings and marks.
    """
    k = segment_of(data, i)
    seg, words = data["segments"][k], data["words"]
    w = words[i]
    clean = {key: v for key, v in w.items() if key not in ("flag", "alts", "why", "checked")}
    if text is None:
        new = [clean]
    else:
        tokens = text.split()
        if not tokens and seg["w1"] - seg["w0"] == 1:
            raise ValueError("a sentence can't be empty")
        clean.pop("spoken", None)  # what was heard no longer applies to a different word
        if len(tokens) == 1:
            new = [clean | {"w": tokens[0]}]
        else:
            total = sum(len(t) + 1 for t in tokens)
            new, t = [], w["s"]
            for tok in tokens:
                dur = (w["e"] - w["s"]) * (len(tok) + 1) / total
                new.append(clean | {"w": tok, "s": round(t, 3), "e": round(t + dur, 3)})
                t += dur
    seg.setdefault("orig", [dict(x) for x in words[seg["w0"]:seg["w1"]]])
    seg["edited"] = True
    splice(data, k, i, i + 1, new)
    return data


def add_missing(data: dict, i: int, add: bool) -> dict:
    """Add (or turn down) the hadith words suggested after word i (see
    sources.hadith_gaps). Added words go in the pause after it when there is
    room, else they share the end of its time."""
    k = segment_of(data, i)
    seg, words = data["segments"][k], data["words"]
    w = words[i]
    text = w.pop("missing", None)
    if not text:
        raise ValueError("nothing is suggested after this word")
    if not add:
        w["missing_no"] = text
        return data
    tokens = text.split()
    nxt = words[i + 1]["s"] if i + 1 < len(words) else w["e"] + 0.3 * len(tokens)
    room = min(nxt - w["e"], 0.3 * len(tokens))
    seg.setdefault("orig", [dict(x) for x in words[seg["w0"]:seg["w1"]]])
    seg["edited"] = True
    if room >= 0.1 * len(tokens):
        s, step = w["e"], room / len(tokens)
    else:  # no pause: the last third of the word's time
        s = w["e"] - (w["e"] - w["s"]) / 3
        step = (w["e"] - s) / len(tokens)
        w["e"] = round(s, 3)
    new = [{"w": tok, "s": round(s + n * step, 3), "e": round(s + (n + 1) * step, 3)} for n, tok in enumerate(tokens)]
    splice(data, k, i + 1, i + 1, new)
    return data
