"""Translate a transcript sentence by sentence (Arabic <-> English).

A small local instruction model (Qwen3-4B-Instruct, Apache-2.0) translates the
transcript a few sentences at a time, as numbered lines, so that a sentence
the recogniser split in two is understood whole but each piece keeps its own
translation (and timing). A glossary covers the usual formulas (ﷺ, رضي الله
عنه, ...). If the model doesn't return one line per piece, that group is
translated piece by piece. (Tested Oct 2026 against ALLaM-7B, which reads
better but slides translations onto neighbouring pieces, and against showing
each piece inside its passage, which makes both models translate the passage.)

Quran is never machine-translated: a quotation that covers whole verses is
replaced by the Saheeh International translation of those verses, and a
partial quotation is translated with that translation given as the reference.
A recognised hadith gets the collection's English as a reference for wording.

Saved next to the video as <video>.translation.<lang>.json; each sentence
keeps the source text it was made from, so an edited sentence shows as stale.
"""
import gc
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Callable

from .sources import TEXTS, _fetch, _quran

MODEL = "Qwen/Qwen3-4B-Instruct-2507"
QURAN_EN_URL = "https://huggingface.co/api/datasets/nassimjp/quran/parquet/en-saheeh/train/0.parquet"
QURAN_EN = "Saheeh International"
BATCH = 8
GROUP = 6          # pieces translated together
GROUP_SECONDS = 25.0
WHOLE_VERSE = 0.9  # share of a verse's words that must be quoted to use the published translation as is

LANGS = {"ar": "Arabic", "en": "English"}
GLOSSARY = {
    "en": ("صلى الله عليه وسلم = ﷺ. رضي الله عنه / عنها / عنهم = may Allah be pleased with him / her / them.\n"
           "رسول الله = the Messenger of Allah. النبي = the Prophet. الله = Allah. اللهم = O Allah. "
           "سبحانه وتعالى = the Exalted. عز وجل = the Mighty and Majestic.\n"
           "Keep Arabic names in common English spelling (عمر = Umar, سعد = Sa'd, أبو بكر = Abu Bakr)."),
    "ar": ("peace be upon him / ﷺ = صلى الله عليه وسلم. may Allah be pleased with him = رضي الله عنه.\n"
           "the Messenger of Allah = رسول الله. the Prophet = النبي. God / Allah = الله."),
}


def translation_path(video: Path, lang: str) -> Path:
    return video.with_suffix(f".translation.{lang}.json")


def load(video: Path, lang: str) -> dict | None:
    p = translation_path(video, lang)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@lru_cache(maxsize=1)
def _load():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL, padding_side="left")
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda").eval()
    return tok, model


def release() -> None:
    import torch

    _load.cache_clear()
    gc.collect()
    torch.cuda.empty_cache()


@lru_cache(maxsize=1)
def _quran_en() -> dict[tuple[int, int], str]:
    import pandas as pd

    df = pd.read_parquet(_fetch(QURAN_EN_URL, TEXTS / "quran_en_saheeh.parquet"))
    return {(int(r.surah), int(r.ayah)): r.text for r in df.itertuples()}


@lru_cache(maxsize=1)
def _verse_lengths() -> dict[tuple[int, int], int]:
    out: dict[tuple[int, int], int] = {}
    for _, _, s, a in _quran()[0]:
        out[(s, a)] = out.get((s, a), 0) + 1
    return out


def _verses(sp: dict) -> list[tuple[int, int]]:
    s, a, a1 = sp["surah"], sp["ayah"], sp["ayah_end"]
    if a1 < a:  # crosses into the next surah (rare): keep the first verse only
        return [(s, a)]
    return [(s, k) for k in range(a, a1 + 1)]


def _quran_english(sp: dict) -> tuple[str, bool]:
    """(the published English for the quoted verses, whether the quote covers them whole)."""
    en = _quran_en()
    vs = _verses(sp)
    total = sum(_verse_lengths().get(v, 0) for v in vs) or 1
    text = " ".join(en.get(v, "") for v in vs).strip()
    whole = (sp["w1"] - sp["w0"]) / total >= WHOLE_VERSE
    return text, whole


def _system(src_lang: str, lang: str) -> str:
    return (f"You translate Islamic lectures from {LANGS[src_lang]} into clear, natural {LANGS[lang]}, "
           "one sentence at a time. Translate faithfully what is said: no commentary, no notes, nothing added. "
           "Output only the translation.\n" + GLOSSARY[lang] +
           "\nText in ⟦ ⟧ brackets is a placeholder: copy it unchanged into your translation where it belongs.")


def _prompt(src_lang: str, lang: str, context: list[str], text: str, refs: list[str]) -> list[dict]:
    sys = _system(src_lang, lang)
    user = ""
    if context:
        user += "Previous sentences (context only, do not translate):\n" + "\n".join(context) + "\n\n"
    if refs:
        user += "Reference translations for quoted texts (use their wording where the speaker quotes them):\n" + \
                "\n".join(refs) + "\n\n"
    user += "Translate:\n" + text
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _group_prompt(src_lang: str, lang: str, context: list[str], pieces: list[str], refs: list[str]) -> list[dict]:
    sys = _system(src_lang, lang) + (
        "\nYou get numbered pieces of the lecture, in order. The pieces are often parts of one sentence: "
        "understand them together, then translate each piece's own words so that, read in order, the "
        "translations form natural sentences. Answer with exactly one line per piece, in the form "
        "'N. translation', using the same numbers.")
    user = ""
    if context:
        user += "Previous pieces (context only, do not translate):\n" + "\n".join(context) + "\n\n"
    if refs:
        user += "Reference translations for quoted texts (use their wording where the speaker quotes them):\n" + \
                "\n".join(refs) + "\n\n"
    user += "Translate:\n" + "\n".join(f"{i + 1}. {t}" for i, t in enumerate(pieces))
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _groups(segs: list[dict]) -> list[list[int]]:
    groups, cur = [], []
    for k, g in enumerate(segs):
        if cur and (len(cur) >= GROUP or g["e"] - segs[cur[0]]["s"] > GROUP_SECONDS):
            groups.append(cur)
            cur = []
        cur.append(k)
    return groups + ([cur] if cur else [])


def _parse(text: str, n: int) -> list[str] | None:
    got: dict[int, str] = {}
    for line in text.splitlines():
        m = _LINE.match(line)
        if m:
            got[int(m.group(1))] = m.group(2).strip()
    if sorted(got) != list(range(1, n + 1)) or not all(got.values()):
        return None
    return [got[i + 1] for i in range(n)]


def _generate(batch: list[list[dict]], max_new: int) -> list[str]:
    import torch

    tok, model = _load()
    enc = tok.apply_chat_template(batch, add_generation_prompt=True, return_tensors="pt", return_dict=True,
                                  padding=True, enable_thinking=False).to(model.device)
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=max_new, do_sample=False)
    n = enc["input_ids"].shape[1]
    return [tok.decode(o[n:], skip_special_tokens=True).strip() for o in out]


_HARAKAT = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")
_PLACEHOLDER = re.compile(r"⟦\s*Q([\d.]+)\s*⟧")
_LINE = re.compile(r"^\s*(\d+)\s*[.:)\-]\s*(.*)$")


def _sentence_jobs(data: dict, lang: str) -> list[tuple[int, str, list[str], dict[str, str]]]:
    """Per sentence: (index, text to translate, reference lines, placeholder -> exact text)."""
    words, segs = data["words"], data["segments"]
    spans = [sp for sp in data.get("sources", []) if sp["type"] in ("quran", "hadith")]
    jobs = []
    for k, g in enumerate(segs):
        # without harakat: the glossary (and most text the model learnt from) is written without
        toks = [_HARAKAT.sub("", w["w"]) for w in words[g["w0"]:g["w1"]]]
        refs, fixed = [], {}
        for sp in spans:
            a, b = max(sp["w0"], g["w0"]), min(sp["w1"], g["w1"])
            if a >= b:
                continue
            if sp["type"] == "quran" and lang == "en" and not sp["ref"].startswith("~"):
                text, whole = _quran_english(sp)
                inside = sp["w0"] >= g["w0"] and sp["w1"] <= g["w1"]
                if whole and inside and text:
                    key = f"⟦Q{k}.{len(fixed) + 1}⟧"
                    fixed[key] = f"“{text}” ({sp['ref'].split()[-1]})"
                    toks[a - g["w0"]:b - g["w0"]] = [key] + [""] * (b - a - 1)
                elif text:
                    refs.append(f"Quran {sp['ref'].split()[-1]} ({QURAN_EN}): {text}")
            elif sp["type"] == "hadith" and lang == "en" and sp.get("english"):
                refs.append(f"Hadith ({sp['ref']}): {sp['english'][:500]}")
        jobs.append((k, " ".join(t for t in toks if t), refs, fixed))
    return jobs


def translate(video: Path, data: dict, lang: str = "en",
              on_progress: Callable[[float], None] | None = None) -> dict:
    """Translate every sentence of a transcript (words.json dict) into `lang`."""
    src_lang = data.get("language") or "ar"
    if lang not in LANGS or src_lang not in LANGS or lang == src_lang:
        raise ValueError(f"can't translate {src_lang} to {lang}")
    words, segs = data["words"], data["segments"]
    source = [" ".join(w["w"] for w in words[g["w0"]:g["w1"]]) for g in segs]
    jobs = _sentence_jobs(data, lang)
    out = [""] * len(jobs)

    def finish(k: int, text: str) -> None:
        fixed = jobs[k][3]
        text = _PLACEHOLDER.sub(lambda m: fixed.get(f"⟦Q{m.group(1)}⟧", ""), text)
        missing = [v for v in fixed.values() if v not in text]
        out[k] = (text + " " + " ".join(missing)).strip() if missing else text

    groups = _groups(segs)
    retry: list[int] = []
    try:
        order = sorted(range(len(groups)), key=lambda g: sum(len(jobs[k][1]) for k in groups[g]))
        for b in range(0, len(order), BATCH):
            gs = [groups[g] for g in order[b:b + BATCH]]
            prompts = [_group_prompt(src_lang, lang, source[max(0, g[0] - 2):g[0]], [jobs[k][1] for k in g],
                                     [r for k in g for r in jobs[k][2]]) for g in gs]
            longest = max(sum(len(jobs[k][1]) for k in g) for g in gs)
            for g, text in zip(gs, _generate(prompts, max_new=int(longest * 0.9) + 30 * max(len(g) for g in gs) + 40)):
                lines = _parse(text, len(g))
                if lines is None:
                    retry += g
                    continue
                for k, line in zip(g, lines):
                    finish(k, line)
            if on_progress:
                on_progress(0.9 * min(1.0, (b + len(gs)) / max(1, len(order))))
        for b in range(0, len(retry), BATCH):  # groups the model didn't number properly
            ks = retry[b:b + BATCH]
            prompts = [_prompt(src_lang, lang, source[max(0, k - 2):k], jobs[k][1], jobs[k][2]) for k in ks]
            longest = max(len(jobs[k][1]) for k in ks)
            for k, text in zip(ks, _generate(prompts, max_new=int(longest * 0.8) + 40)):
                finish(k, text)
    finally:
        release()
    if on_progress:
        on_progress(1.0)
    # keep hand-edited translations whose sentence hasn't changed since
    old = load(video, lang)
    for k, seg in enumerate(old["segments"] if old and len(old["segments"]) == len(out) else []):
        if seg.get("edited") and seg.get("source") == source[k]:
            out[k] = seg["text"]
    edited = [bool(old and len(old["segments"]) == len(out) and old["segments"][k].get("edited")
                   and old["segments"][k].get("source") == source[k]) for k in range(len(out))]
    result = {"lang": lang, "source_lang": src_lang, "model": MODEL, "quran": QURAN_EN,
              "segments": [{"text": t, "source": s, **({"edited": True} if e else {})}
                           for t, s, e in zip(out, source, edited)]}
    translation_path(video, lang).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


def edit(video: Path, lang: str, k: int, text: str, source: str) -> dict:
    """Replace sentence k's translation by hand. It is marked as edited (kept
    when translating again) and counts as made from the current `source`."""
    tr = load(video, lang)
    if tr is None:
        raise KeyError("translation")
    seg = tr["segments"][k]
    if not text.strip():
        raise ValueError("a translation can't be empty")
    seg.update(text=text.strip(), source=source, edited=True)
    translation_path(video, lang).write_text(json.dumps(tr, ensure_ascii=False), encoding="utf-8")
    return tr


def timed_words(data: dict, tr: dict) -> list[dict]:
    """Translated sentences as caption words: each sentence's words share its
    time span by length (the translation has no word timings of its own)."""
    out = []
    for g, seg in zip(data["segments"], tr["segments"]):
        toks = seg["text"].split()
        if not toks:
            continue
        s0, s1 = g["s"], g["e"]
        total = sum(len(t) + 1 for t in toks)
        t = s0
        for tok in toks:
            dur = (s1 - s0) * (len(tok) + 1) / total
            out.append({"w": tok, "s": round(t, 3), "e": round(t + dur * 0.95, 3)})
            t += dur
    return out
