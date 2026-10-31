"""Words around the video, written by Gemini from the transcript: a title and
description for each short, and suggested moments worth making into shorts.
Both are suggestions; the user edits or ignores them."""
from .proofread import ask_json
from .util import fmt_time

LANG_NAME = {"ar": "Arabic", "en": "English"}


def _text(data: dict, a: float, b: float) -> str:
    return " ".join(w["w"] for w in data["words"] if w["s"] < b and w["e"] > a)


def describe(data: dict, ranges: list[tuple[float, float]], video_title: str | None, lang: str) -> dict:
    """{"title", "description", "hashtags"} for a short made of `ranges`."""
    said = "\n…\n".join(_text(data, a, b) for a, b in ranges)
    prompt = f"""You write the post for a vertical short video (TikTok, Reels, YouTube Shorts) cut from a longer video{f' titled «{video_title}»' if video_title else ''}.
This is everything said in the short:

{said}

Write in {LANG_NAME.get(lang, lang)}:
- title: at most 70 characters, specific to what is said, no clickbait, no emoji, no quotation marks around it.
- description: 1 to 3 short sentences saying what the viewer will hear. Don't invent anything that isn't said; if a Quran verse or hadith is quoted, you may name it.
- hashtags: 3 to 6, without the # sign, relevant and commonly used.
Don't name the speaker unless they are named in what is said or in the video title."""
    schema = {"type": "OBJECT", "properties": {
        "title": {"type": "STRING"}, "description": {"type": "STRING"},
        "hashtags": {"type": "ARRAY", "items": {"type": "STRING"}}},
        "required": ["title", "description", "hashtags"]}
    out, model = ask_json(prompt, schema)
    return {"title": str(out["title"]).strip(), "description": str(out["description"]).strip(),
            "hashtags": [str(h).strip().lstrip("#").replace(" ", "") for h in out["hashtags"] if str(h).strip()][:6],
            "model": model}


def moments(data: dict, video_title: str | None, count: int = 8,
            shortest: float = 20.0, longest: float = 90.0) -> list[dict]:
    """Stretches that stand on their own as a short: [{"s", "e", "title", "reason"}],
    snapped to sentence boundaries, best first."""
    segs = data["segments"]
    lines = "\n".join(f"[{k}] {fmt_time(sg['s'])} {_text(data, sg['s'], sg['e'])}" for k, sg in enumerate(segs))
    lang = LANG_NAME.get(data.get("language") or "ar", "the video's language")
    prompt = f"""Below is the transcript of a video{f' titled «{video_title}»' if video_title else ''}, one numbered sentence per line with its start time.
Find up to {count} moments that would work as a vertical short on their own: a complete thought with its ending
(a question with its answer, a story with its point, a strong reminder), {int(shortest)} to {int(longest)} seconds long,
that makes sense without the rest of the video. Prefer moments with a strong first sentence. They must not overlap.

For each, give the first and last sentence numbers, a title (at most 60 characters, in {lang}), and in English a short
reason why it works (a few words, e.g. "question answered", "complete story", "strong opening line"). Best first.

Transcript:
{lines}"""
    schema = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "first": {"type": "INTEGER"}, "last": {"type": "INTEGER"},
        "title": {"type": "STRING"}, "reason": {"type": "STRING"}},
        "required": ["first", "last", "title", "reason"]}}
    items, model = ask_json(prompt, schema, temperature=0.3)
    out: list[dict] = []
    for it in items:
        a, b = int(it.get("first", -1)), int(it.get("last", -1))
        if not (0 <= a <= b < len(segs)):
            continue
        s, e = segs[a]["s"], segs[b]["e"]
        if e - s < shortest * 0.7 or e - s > longest * 1.4:
            continue
        if any(s < m["e"] and e > m["s"] for m in out):
            continue
        out.append({"s": round(s, 2), "e": round(e, 2), "title": str(it["title"]).strip(),
                    "reason": str(it["reason"]).strip(), "model": model})
    return out[:count]
