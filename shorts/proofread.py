"""Optional proofreading of doubtful words by Gemini (Google), which hears the
audio and knows Arabic, the Quran and hadith.

The local recognisers only match sounds to letters, and their vote can only
pick between what they heard. Gemini gets the lecture audio and the whole
transcript, with every doubtful word marked and its other readings listed,
and says what was actually said there. Only those words change; Quran text is
never touched (it's already the exact mushaf). Each change keeps the old
reading in "alts" and Gemini's reason in "why".

Needs GEMINI_API_KEY (environment, or .env / .env.local at the project root). On Google's
free tier, prompts and responses may be used to improve Google's products.
One request per 30 minutes of audio.
"""
import base64
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://generativelanguage.googleapis.com/v1beta"
WINDOW = 30 * 60  # seconds of audio per request (inline audio must stay under ~20 MB)

PROMPT = """You proofread an automatic transcript of an Arabic Islamic lecture{title}.
You get the lecture audio and the transcript as numbered sentences with their start time in seconds.
Some words are marked like [[7: word | heard also: a / b]]: the speech recognisers disagreed on them.

For each marked word, listen to the audio at that moment and give exactly what the speaker said in that
slot. Use the audio first, then the meaning, the grammar, the lecture's topic and well-known wording of
the Quran and hadith. Keep the speaker's own phrasing and dialect: correct mishearings, never paraphrase.
Write the word with full harakat only where you are sure of them, otherwise without. If the transcript's
word is right, repeat it. If the marked word is really part of the word before or after it (one word was
split in two, e.g. «وسوسة هو» for «وسوستُه»), write the whole word and set "joins" to "previous" or "next";
otherwise "joins" is "none". If the slot holds two words, write both.

Answer with a JSON list, one item per marked word: {{"id": <number>, "word": "<what was said>",
"joins": "none" | "previous" | "next", "reason": "<a few English words, e.g. 'hadith wording, Muslim 2218'>"}}.

Transcript:
{transcript}"""


class ProofreadError(RuntimeError):
    pass


class Busy(ProofreadError):
    """The model is overloaded right now (another model may answer)."""


class OutOfQuota(ProofreadError):
    """This model's free quota is used up for now (each model has its own)."""


def _setting(name: str) -> str | None:
    """From the environment, else .env or .env.local at the project root."""
    if os.environ.get(name):
        return os.environ[name].strip()
    for f in (ROOT / ".env", ROOT / ".env.local"):
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                k, _, v = line.partition("=")
                if k.strip() == name and v.strip():
                    return v.strip().strip('"').strip("'")
    return None


def api_key() -> str | None:
    return _setting("GEMINI_API_KEY")


RETRY_WAITS = (5, 15, 30)  # seconds between attempts when the model is busy


def _call(path: str, key: str, body: dict | None = None, timeout: float = 600) -> dict:
    """One API call; a busy model (500/503) is tried again a few times."""
    import time

    for wait in RETRY_WAITS + (None,):
        try:
            return _call_once(path, key, body, timeout)
        except Busy:
            if wait is None:
                raise
            time.sleep(wait)


def _call_once(path: str, key: str, body: dict | None, timeout: float) -> dict:
    req = urllib.request.Request(f"{API}/{path}", data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        if e.code in (500, 503):
            raise Busy(f"Gemini is busy right now ({e.code}); try again in a while") from e
        if e.code == 429:
            try:
                msg = json.loads(detail)["error"]["message"].split("\n")[0][:200]
            except (ValueError, KeyError, TypeError):
                msg = "rate limit"
            raise OutOfQuota(f"Gemini quota reached for now: {msg}") from e
        if e.code in (400, 401, 403) and "API key" in detail:
            raise ProofreadError("Gemini rejected the API key (GEMINI_API_KEY in .env)") from e
        raise ProofreadError(f"Gemini error {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise ProofreadError(f"can't reach Gemini: {e.reason}") from e


def choose_models(key: str) -> list[str]:
    """Models to try, in order: GEMINI_MODEL if set, then this key's Flash
    models from newest to oldest (full Flash before Flash-Lite)."""
    forced = _setting("GEMINI_MODEL")
    names = []
    page = ""
    while True:
        out = _call(f"models?pageSize=200{'&pageToken=' + page if page else ''}", key)
        names += [m["name"].removeprefix("models/") for m in out.get("models", [])
                  if "generateContent" in m.get("supportedGenerationMethods", [])]
        page = out.get("nextPageToken", "")
        if not page:
            break

    def version(n: str) -> tuple:
        m = re.match(r"gemini-(\d+(?:\.\d+)?)-flash(-lite)?$", n)
        return (float(m.group(1)), not m.group(2)) if m else (-1, False)

    flash = sorted((n for n in names if version(n)[0] >= 0), key=version, reverse=True)
    order = ([forced.removeprefix("models/")] if forced else []) + flash
    if not order:
        raise ProofreadError("no Gemini Flash model available for this key")
    return list(dict.fromkeys(order))


def _audio(video: Path, start: float, length: float) -> bytes:
    """Compact mono speech audio (Ogg Opus, 24 kb/s) for one window."""
    return subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.2f}", "-t", f"{length:.2f}", "-i", str(video),
                           "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", "-"],
                          check=True, capture_output=True).stdout


def _marked(data: dict, lo: float, hi: float) -> tuple[str, dict[int, int]]:
    """The transcript between lo and hi seconds (times relative to lo), doubtful
    words marked with an id; returns (text, id -> word index)."""
    words, ids, lines = data["words"], {}, []
    for g in data["segments"]:
        if g["e"] < lo or g["s"] >= hi:
            continue
        parts = []
        for i in range(g["w0"], g["w1"]):
            w = words[i]
            if w.get("flag") and not w.get("quran"):
                ids[len(ids) + 1] = i
                others = " / ".join(dict.fromkeys(a for a in w.get("alts", []) + [w.get("asr", "")] if a and a != w["w"]))
                parts.append(f"[[{len(ids)}: {w['w']}" + (f" | heard also: {others}" if others else "") + "]]")
            else:
                parts.append(w["w"])
        lines.append(f"{len(lines) + 1}. ({max(0.0, g['s'] - lo):.1f}s) " + " ".join(parts))
    return "\n".join(lines), ids


def suggest(video: Path, data: dict, title: str | None = None, on_progress=None) -> list[dict]:
    """Gemini's readings for the doubtful words: [{"i": word index, "word", "reason"}]."""
    key = api_key()
    if not key:
        raise ProofreadError("set GEMINI_API_KEY in .env to use Gemini proofreading")
    models = choose_models(key)
    end = max((w["e"] for w in data["words"]), default=0.0)
    windows = [(t, min(end, t + WINDOW)) for t in range(0, int(end) + 1, WINDOW)] or [(0, end)]
    out = []
    for n, (lo, hi) in enumerate(windows):
        text, ids = _marked(data, lo, hi)
        if not ids:
            continue
        prompt = PROMPT.format(title=f' titled «{title}»' if title else "", transcript=text)
        body = {
            "contents": [{"role": "user", "parts": [
                {"inline_data": {"mime_type": "audio/ogg", "data": base64.b64encode(_audio(video, lo, hi - lo)).decode()}},
                {"text": prompt}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json",
                                 "responseSchema": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                                     "id": {"type": "INTEGER"}, "word": {"type": "STRING"},
                                     "joins": {"type": "STRING", "enum": ["none", "previous", "next"]},
                                     "reason": {"type": "STRING"}}, "required": ["id", "word", "joins"]}}},
        }
        for model in models:  # a busy or exhausted model hands over to the next one
            try:
                res = _call(f"models/{model}:generateContent", key, body)
                break
            except (Busy, OutOfQuota):
                if model == models[-1]:
                    raise
        models = models[models.index(model):]  # stay with the one that answered
        try:
            items = json.loads(res["candidates"][0]["content"]["parts"][0]["text"])
        except (KeyError, IndexError, json.JSONDecodeError) as e:
            raise ProofreadError(f"unexpected answer from Gemini: {str(res)[:300]}") from e
        for it in items:
            i = ids.get(int(it.get("id", -1)))
            if i is not None and str(it.get("word", "")).strip():
                out.append({"i": i, "word": it["word"].strip(), "reason": str(it.get("reason", "")).strip(),
                            "joins": it.get("joins", "none"), "model": model})
        if on_progress:
            on_progress((n + 1) / len(windows))
    return out


def _similar(a: str, b: str) -> float:
    import difflib

    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def apply(data: dict, suggestions: list[dict]) -> int:
    """Apply Gemini's readings to the doubtful words. A changed word gets flag
    "gemini" (its old reading in alts, the reason in "why"); a confirmed one
    loses its doubt. When Gemini's word clearly covers the word before or after
    too (one word misheard as two: «وسوسة هو» = «وسوسته»), the two become one.
    Returns the number of words changed."""
    from .sources import _drop_words, norm

    words, changed = data["words"], 0
    for s in suggestions:
        w = words[s["i"]]
        if not w.get("flag") or w.get("quran") or w.get("_drop"):
            continue
        new = re.sub(r"[\[\]]", "", s["word"]).strip()
        joins = s.get("joins", "none")
        if new.startswith("ـ") and s["i"] > 0:  # just a suffix («ـهُ»): it ends the word before
            prev = words[s["i"] - 1]["w"]
            prev = re.sub("ة([\u064B-\u0652]*)$", "ت\\1", prev)  # ة becomes ت before a suffix
            new, joins = prev + new.lstrip("ـ"), "previous"
        nn, nw = norm(new), norm(w["w"])
        if nn == nw:
            w.pop("flag", None)
            w["checked"] = "gemini"
            continue
        # does the answer stand for this word and a neighbour together?
        merge = {"previous": s["i"] - 1, "next": s["i"] + 1}.get(joins)
        if merge is not None and (not 0 <= merge < len(words) or words[merge].get("quran") or words[merge].get("_drop")):
            merge = None
        for j in (() if merge is not None else (s["i"] - 1, s["i"] + 1)):
            if 0 <= j < len(words) and not words[j].get("quran") and not words[j].get("_drop"):
                pair = norm(words[j]["w"]) + nw if j < s["i"] else nw + norm(words[j]["w"])
                if _similar(pair, nn) >= 0.7 and _similar(pair, nn) > _similar(nw, nn) + 0.3:
                    merge = j
                    break
        if merge is not None:
            first, second = sorted((s["i"], merge))
            keep, gone = words[first], words[second]
            keep["alts"] = [keep["w"] + " " + gone["w"]]
            keep["w"], keep["e"], keep["flag"], keep["why"] = new, gone["e"], "gemini", s.get("reason") or "Gemini"
            gone["_drop"] = True
        else:
            w["alts"] = [w["w"]] + [a for a in w.get("alts", []) if a != w["w"]]
            w["w"], w["flag"], w["why"] = new, "gemini", s.get("reason") or "Gemini"
        changed += 1
    _drop_words(data, [])
    data["proofread"] = {"model": suggestions[0]["model"] if suggestions else None, "changed": changed}
    return changed


def ask_json(prompt: str, schema: dict, temperature: float = 0.4) -> tuple[object, str]:
    """A text-only question with a JSON answer (`schema` in Gemini's format).
    Returns (answer, model). Busy or exhausted models hand over to the next."""
    key = api_key()
    if not key:
        raise ProofreadError("set GEMINI_API_KEY in .env to use Gemini")
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temperature, "responseMimeType": "application/json",
                                 "responseSchema": schema}}
    models = choose_models(key)
    for model in models:
        try:
            res = _call(f"models/{model}:generateContent", key, body)
            break
        except (Busy, OutOfQuota):
            if model == models[-1]:
                raise
    try:
        return json.loads(res["candidates"][0]["content"]["parts"][0]["text"]), model
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        raise ProofreadError(f"unexpected answer from Gemini: {str(res)[:300]}") from e
