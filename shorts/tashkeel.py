"""Accurate, fully-diacritised Arabic text for an existing Whisper transcript.

Whisper is good at *when* words are said but often misspells classical Arabic
(e.g. "سعدين" for سَعْدٍ, "ساعدا" for سَعْدًا). Two Cohere models read the same
audio again, and their words are put on Whisper's word timings:

- Cohere Transcribe Arabic (CohereLabs, Apache-2.0) gets the words most right
  (8 % word errors on our test lecture, against 16 % for Whisper) but writes
  no harakat. It reads the lecture the way Cohere's own long-form
  transcription does: chunks of up to 35 s, cut at the quietest moment. With
  that much context it reads far better than sentence by sentence (shorter
  windows made it skip asides before a verse and invent words in quotations).
- Cohere-Speech-Tashkeel-2B (NAMAA-Space, Apache-2.0), its fine-tune, writes
  full harakat and i'rab. It reads ~15 s windows of whole sentences (on 35 s
  chunks it loops); wherever it read the same word, its spelling is used.

A chunk or window whose output looks degenerate is not used; sentences the
models skipped are re-read one by one, and a sentence that still fails keeps
Whisper's text. Set formulas (ﷺ, رضي الله عنه) that Whisper heard are written
in their standard form.

Every word is then checked against three other readings of the same audio
(aligned word by word with Needleman-Wunsch, so similar spellings pair up):
the Tashkeel model, Whisper and NVIDIA's FastConformer (small, on the CPU). A
word stands if any of them agrees, except that the Tashkeel model (Cohere's
own fine-tune, prone to the same mistakes) agreeing alone, against both
Whisper and NVIDIA, leaves it flagged. If two agree on something else, theirs is
used (flag "voted"); if none backs it, it's kept but flagged "doubt". The other
readings are kept in "alts" so the editor can offer them.
"""
import difflib
import gc
import re
from functools import lru_cache

import numpy as np

BASE = "CohereLabs/cohere-transcribe-arabic-07-2026"  # gated on Hugging Face: accept its terms once
MODEL = "NAMAA-Space/Cohere-Speech-Tashkeel-2B"
VOTER = "OpenVoiceOS/stt_ar_fastconformer_hybrid_large_pcd_v1.0_onnx"  # NVIDIA FastConformer, ONNX
SR = 16000
BATCH = 4
HEAD = 0.15    # audio added before a sentence clip
WINDOW = 15.0  # the Tashkeel model reads sentences in windows of up to this long (it loops on longer audio)
TAIL = 0.5     # and after it: Whisper often ends a sentence inside its last word, which then gets
               # misread. Words picked up from the neighbours at the edges are dropped in align().
FORMULAS = ["صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ", "رَضِيَ اللَّهُ عَنْهُ", "رَضِيَ اللَّهُ عَنْهَا", "رَضِيَ اللَّهُ عَنْهُمْ",
            "رَضِيَ اللَّهُ عَنْهُمَا", "سُبْحَانَهُ وَتَعَالَى", "عَزَّ وَجَلَّ"]


@lru_cache(maxsize=1)
def _load(name: str = MODEL):
    import torch
    from transformers import AutoProcessor, CohereAsrForConditionalGeneration

    proc = AutoProcessor.from_pretrained(name)
    model = CohereAsrForConditionalGeneration.from_pretrained(name, dtype=torch.bfloat16, device_map="cuda").eval()
    return proc, model


@lru_cache(maxsize=1)
def _voter():
    import onnx_asr

    # on the CPU: it's small and fast there, and leaves the GPU to the big model
    return onnx_asr.load_model(VOTER, providers=["CPUExecutionProvider"])


def _vote_texts(clips: list[np.ndarray]) -> list[str]:
    try:
        out = [_voter().recognize(c, sample_rate=SR) for c in clips]
    except Exception as e:  # the check is optional: never fail a transcription over it
        print(f"second recogniser unavailable: {e}", flush=True)
        return [""] * len(clips)
    return [t if isinstance(t, str) else getattr(t, "text", "") for t in out]


def _joined(text: str) -> list[str]:
    """Words, with a detached و / ف put back on the next word."""
    from .sources import norm

    out: list[str] = []
    for w in text.split():
        if not norm(w):
            continue
        if out and norm(out[-1]) in ("و", "ف"):
            out[-1] += w
        else:
            out.append(w)
    return out


GAP = 0.6  # cost of a word only one side has; a substitution costs 0.2-1.0 by how alike the words are


@lru_cache(maxsize=65536)
def _sub_cost(x: str, y: str) -> float:
    if x == y:
        return 0.0
    return 1.0 - 0.8 * difflib.SequenceMatcher(None, x, y, autojunk=False).ratio()


def _opcodes(a: list[str], b: list[str]) -> list[tuple[str, int, int, int, int]]:
    """Best word-by-word alignment of a and b (Needleman-Wunsch): similar
    spellings line up (رجز / الرجز), and the pairing is optimal over the whole
    stretch, unlike a diff that grabs the first identical word it finds. Ops
    are one word each, in difflib's format."""
    n, m = len(a), len(b)
    cost = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        cost[i][0] = i * GAP
    for j in range(1, m + 1):
        cost[0][j] = j * GAP
    for i in range(1, n + 1):
        ci, ai = cost[i], a[i - 1]
        prev = cost[i - 1]
        for j in range(1, m + 1):
            ci[j] = min(prev[j - 1] + _sub_cost(ai, b[j - 1]), prev[j] + GAP, ci[j - 1] + GAP)
    ops = []
    i, j = n, m
    while i or j:
        if i and j and abs(cost[i][j] - (cost[i - 1][j - 1] + _sub_cost(a[i - 1], b[j - 1]))) < 1e-9:
            ops.append(("equal" if a[i - 1] == b[j - 1] else "replace", i - 1, i, j - 1, j))
            i, j = i - 1, j - 1
        elif i and abs(cost[i][j] - (cost[i - 1][j] + GAP)) < 1e-9:
            ops.append(("delete", i - 1, i, j, j))
            i -= 1
        else:
            ops.append(("insert", i, i, j - 1, j))
            j -= 1
    return ops[::-1]


def _blocks(ops: list[tuple[str, int, int, int, int]]) -> list[tuple[str, int, int, int, int]]:
    """Runs of unequal ops joined into one block each (as difflib reports them)."""
    out: list[list] = []
    for op, i0, i1, j0, j1 in ops:
        if out and op != "equal" and out[-1][0] != "equal":
            out[-1][2], out[-1][4] = i1, j1
            out[-1][0] = "replace"
        else:
            out.append([op, i0, i1, j0, j1])
    return [tuple(o) for o in out]


def _heard(P: list[str], text: str) -> dict[int, str]:
    """Which word of `text` stands at each position of the normalised words P."""
    from .sources import norm

    ow = _joined(text)
    on = [norm(w) for w in ow]
    out: dict[int, str] = {}
    for op, i0, i1, j0, j1 in _opcodes(P, on):
        if op in ("equal", "replace"):
            for k in range(i1 - i0):
                out[i0 + k] = ow[j0 + k]
    return out


def _harakat(new: list[dict], text: str) -> list[dict]:
    """Use the Tashkeel model's spelling (with harakat) where it read the same word."""
    from .sources import norm

    if not text:
        return new
    P = [norm(w["w"]) for w in new]
    for k, v in _heard(P, text).items():
        if norm(v) == P[k]:
            new[k]["w"] = v
    return new


def _vote(new: list[dict], others: list[str], sibling: str = "") -> list[dict]:
    """Check each word against other readings (in order of preferred spelling)
    and Whisper's (each word's "asr"). `sibling` is a reading from a model of
    the same family as the one that wrote `new` (the Tashkeel model, a fine-tune
    of Cohere Transcribe Arabic): it tends to make the same mistakes, so its
    agreement alone doesn't settle a word that both independent readings dispute:
    the word is kept but flagged. (Replacing it by what those two heard made the
    text worse on the test lecture, 7.6 % against 7.1 % word errors.)"""
    from .sources import norm

    P = [norm(w["w"]) for w in new]
    heard = [_heard(P, t) for t in others if t]
    sib = _heard(P, sibling) if sibling else {}
    for k, w in enumerate(new):
        asr = w.get("asr", "")
        votes = [h[k] for h in heard if k in h] + ([asr] if asr and " " not in asr else [])
        vn = [norm(v) for v in votes]
        if P[k] in vn or not (votes or k in sib):
            continue
        if k in sib and norm(sib[k]) == P[k]:  # only the sibling agrees
            if len(vn) >= 2:  # and both independent readings dispute it
                w["flag"] = "doubt"
                w["alts"] = list(dict.fromkeys(votes))
            continue
        votes = ([sib[k]] if k in sib else []) + votes
        vn = [norm(v) for v in votes]
        best = max(set(vn), key=vn.count)
        # a leading و is the commonest mishearing (often the end of the word before, as in هو):
        # it never replaces a word on its own, only flags it
        if vn.count(best) >= 2 and best not in ("و" + P[k], P[k][1:] if P[k][:1] == "و" else None):
            w["alts"] = [w["w"]]
            w["w"], w["flag"] = votes[vn.index(best)], "voted"
        else:
            w["flag"] = "doubt"
            w["alts"] = list(dict.fromkeys(votes))
    return new


def release() -> None:
    """Free the GPU memory (the model is reloaded on next use, ~6 s)."""
    import torch

    _load.cache_clear()
    gc.collect()
    torch.cuda.empty_cache()


def _decode(clips: list[np.ndarray], name: str = MODEL) -> list[str]:
    import torch

    proc, model = _load(name)
    feats = proc.feature_extractor(clips, sampling_rate=SR, return_tensors="pt", padding="longest",
                                   return_attention_mask=True)
    idx = feats.pop("audio_chunk_index")
    prompt = proc.get_decoder_prompt_ids(language="ar", punctuation=True)
    n = feats["input_features"].shape[0]
    dec = torch.tensor([prompt] * n, dtype=torch.long, device=model.device)
    longest = max(len(c) for c in clips) / SR
    with torch.no_grad():
        out = model.generate(input_features=feats["input_features"].to(model.device, torch.bfloat16),
                             attention_mask=feats["attention_mask"].to(model.device),
                             decoder_input_ids=dec, max_new_tokens=int(14 * longest) + 24)
    texts = proc.decode(out, skip_special_tokens=True, audio_chunk_index=idx, language="ar")
    return [t.strip() for t in (texts if isinstance(texts, list) else [texts])]


_REPEAT = re.compile(r"(.)\1{4,}|(\S{1,3})\2{3,}")


def _loops(ws: list[str]) -> bool:
    """A phrase of 1-4 words said 3+ times in a row (the model got stuck)."""
    from .sources import norm

    ws = [norm(w) for w in ws]
    for n in range(1, 5):
        for i in range(len(ws) - 3 * n + 1):
            if ws[i:i + n] == ws[i + n:i + 2 * n] == ws[i + 2 * n:i + 3 * n]:
                return True
    return False


def _degenerate(text: str, asr: str) -> bool:
    from .sources import norm

    a, b = norm(text.replace(" ", "")), norm(asr.replace(" ", ""))
    if not a:
        return True
    if _REPEAT.search(re.sub(r"[ً-ٰٟ]", "", text)) or (_loops(text.split()) and not _loops(asr.split())):
        return True
    return b and not (0.5 < len(a) / len(b) < 1.8)


def align(asr: list[dict], text: str, edges: bool = False) -> list[dict]:
    """Put the new words on the old words' timings (letters compared without tashkeel).
    Each new word gets "src": the index of the Whisper word it stands for.
    edges=True drops words added before the first or after the last Whisper
    word (heard in the padding around a clip: they belong to the neighbours)."""
    from .sources import norm

    new = text.split()
    if not asr or not new:
        return asr
    a = [norm(w["w"]) for w in asr]
    b = [norm(w) for w in new]
    out: list[dict] = []
    for op, i0, i1, j0, j1 in _blocks(_opcodes(a, b)):
        if j0 == j1:  # Cohere has nothing for these Whisper words: drop them
            continue
        if edges and i0 == i1 and (i0 == 0 or i0 == len(asr)):
            continue
        if i1 - i0 == j1 - j0:
            for k in range(j1 - j0):
                w = asr[i0 + k]
                out.append({"w": new[j0 + k], "s": w["s"], "e": w["e"], "asr": w["w"], "src": i0 + k})
            continue
        # different counts: share the time span of the Whisper words by letter count
        if i0 < i1:
            s0, s1 = asr[i0]["s"], asr[i1 - 1]["e"]
        else:  # inserted words: the gap between neighbours
            s0 = asr[i0 - 1]["e"] if i0 > 0 else asr[0]["s"]
            s1 = asr[i0]["s"] if i0 < len(asr) else s0 + 0.3
        total = sum(len(b[j]) + 1 for j in range(j0, j1)) or 1
        t = s0
        for j in range(j0, j1):
            dur = (s1 - s0) * (len(b[j]) + 1) / total
            src = min(len(asr) - 1, i0 + int((j - j0) * (i1 - i0) / (j1 - j0))) if i0 < i1 else max(0, i0 - 1)
            out.append({"w": new[j], "s": round(t, 3), "e": round(t + dur * 0.95, 3),
                        "asr": " ".join(w["w"] for w in asr[i0:i1]) if i0 < i1 else "", "src": src})
            t += dur
    return out


def _formulas(asr: list[dict], out: list[dict]) -> list[dict]:
    """Where Whisper heard a set formula, use its standard written form."""
    from .sources import norm

    a = [norm(w["w"]) for w in asr]
    for f in FORMULAS:
        ft = f.split()
        fn = [norm(t) for t in ft]
        for i in range(len(a) - len(fn) + 1):
            if a[i:i + len(fn)] != fn:
                continue
            got = [w for w in out if i <= w["src"] < i + len(fn)]
            if [w["w"] for w in got] == ft:  # already in the standard form (with harakat)
                continue
            keep = [w for w in out if not (i <= w["src"] < i + len(fn))]
            at = next((k for k, w in enumerate(keep) if w["src"] >= i + len(fn)), len(keep))
            fixed = [{"w": t, "s": asr[i + k]["s"], "e": asr[i + k]["e"], "asr": asr[i + k]["w"], "src": i + k}
                     for k, t in enumerate(ft)]
            out = keep[:at] + fixed + keep[at:]
    return out


@lru_cache(maxsize=1)
def _fe():
    from transformers import AutoProcessor

    for name in (BASE, MODEL):
        try:
            return AutoProcessor.from_pretrained(name).feature_extractor
        except Exception:
            continue
    raise RuntimeError("no Cohere ASR processor available")


def _chunks(audio: np.ndarray) -> list[tuple[float, float]]:
    """The lecture cut the way Cohere's own long-form transcription cuts it:
    chunks of up to 35 s, each ending at the quietest moment of its last 5 s.
    The models read much better with this much context than sentence by sentence."""
    import torch

    fe = _fe()
    size = int(round(fe.max_audio_clip_s * SR))
    look = int(round(fe.overlap_chunk_second * SR))
    wave, n = torch.from_numpy(audio.copy()), len(audio)
    out, i = [], 0
    while i < n:
        if i + size >= n:
            out.append((i, n))
            break
        cut = fe._find_split_point_energy(wave, max(i, i + size - look), min(i + size, n))
        cut = max(i + 1, min(cut, n))
        out.append((i, cut))
        i = cut
    return [(a / SR, b / SR) for a, b in out]


def _clip(audio: np.ndarray, a: float, b: float, pad: bool = True) -> np.ndarray:
    head, tail = (HEAD, TAIL) if pad else (0.0, 0.0)
    a0, a1 = max(0, int((a - head) * SR)), int((b + tail) * SR)
    return audio[a0:a1] if a1 > a0 else np.zeros(SR // 10, np.float32)


def _decode_all(spans: list[tuple[float, float]], audio: np.ndarray, on_progress=None,
                name: str = MODEL, pad: bool = True) -> list[str]:
    """Decode audio spans (seconds), similar lengths batched together."""
    order = sorted(range(len(spans)), key=lambda k: spans[k][1] - spans[k][0])
    texts = [""] * len(spans)
    for b in range(0, len(order), BATCH):
        ks = order[b:b + BATCH]
        for k, t in zip(ks, _decode([_clip(audio, *spans[k], pad) for k in ks], name)):
            texts[k] = t
        if on_progress:
            on_progress(min(1.0, (b + len(ks)) / max(1, len(order))))
    return texts


def _read(spans: list[tuple[float, float]], audio: np.ndarray, on_progress=None,
          pad: bool = True) -> tuple[list, list, list]:
    """(base model, Tashkeel model, second recogniser) texts for each span, one
    model on the GPU at a time. Without access to the base model, its texts are
    empty and the Tashkeel model's are used alone."""
    part = lambda a, b: (lambda f: on_progress(a + (b - a) * f)) if on_progress else None  # noqa: E731
    try:
        base = _decode_all(spans, audio, part(0.0, 0.45), BASE, pad)
    except Exception as e:  # e.g. the gated model's terms not accepted on Hugging Face
        print(f"{BASE} unavailable ({type(e).__name__}): using the Tashkeel model alone", flush=True)
        base = [""] * len(spans)
    finally:
        release()
    tash = _decode_all(spans, audio, part(0.45, 0.9), MODEL, pad)
    release()
    other = _vote_texts([_clip(audio, a, b, pad) for a, b in spans])
    return base, tash, other


def _merge(old: list[dict], base: str, tash: str, other: str, edges: bool = True) -> list[dict] | None:
    """The new words for Whisper words `old`, or None if both models went wrong."""
    asr = " ".join(w["w"] for w in old)
    base = "" if not base or _degenerate(base, asr) else base
    tash = "" if not tash or _degenerate(tash, asr) else tash
    if not old or not (base or tash):
        return None
    if base:
        new = _harakat(align(old, base, edges), tash)
        return _formulas(old, _vote(new, [other], sibling=tash))
    return _formulas(old, _vote(align(old, tash, edges), [other]))


def _windows(segments: list[dict]) -> list[list[int]]:
    groups, cur = [], []
    for k, g in enumerate(segments):
        if cur and g["e"] - segments[cur[0]]["s"] > WINDOW:
            groups.append(cur)
            cur = []
        cur.append(k)
    return groups + ([cur] if cur else [])


def _read_chunks(chunks: list[tuple[float, float]], words: list[dict], segments: list[dict],
                 audio: np.ndarray, on_progress=None) -> tuple[list, list, list]:
    """Like _read, but the Tashkeel model reads ~15 s windows of whole sentences
    (on 35 s chunks it loops); its words are put on Whisper's timings and
    gathered into the chunks by time."""
    part = lambda a, b: (lambda f: on_progress(a + (b - a) * f)) if on_progress else None  # noqa: E731
    try:
        base = _decode_all(chunks, audio, part(0.0, 0.45), BASE, pad=False)
    except Exception as e:  # e.g. the gated model's terms not accepted on Hugging Face
        print(f"{BASE} unavailable ({type(e).__name__}): using the Tashkeel model alone", flush=True)
        base = [""] * len(chunks)
    finally:
        release()
    groups = _windows(segments)
    texts = _decode_all([(segments[g[0]]["s"], segments[g[-1]]["e"]) for g in groups], audio, part(0.45, 0.9), MODEL)
    release()
    timed: list[tuple[float, str]] = []
    for g, t in zip(groups, texts):
        old = words[segments[g[0]]["w0"]:segments[g[-1]]["w1"]]
        if old and t and not _degenerate(t, " ".join(w["w"] for w in old)):
            timed += [((w["s"] + w["e"]) / 2, w["w"]) for w in align(old, t, edges=True)]
    tash = [" ".join(w for m, w in timed if a <= m < b) for a, b in chunks]
    other = _vote_texts([_clip(audio, a, b, pad=False) for a, b in chunks])
    return base, tash, other


def rewrite(words: list[dict], segments: list[dict], audio: np.ndarray,
            on_progress=None) -> tuple[list[dict], list[dict], int]:
    """Re-read the lecture; returns (words, segments, sentences improved)."""
    chunks = _chunks(audio)
    read = _read_chunks(chunks, words, segments, audio, (lambda f: on_progress(0.85 * f)) if on_progress else None)

    seg_of = [0] * len(words)
    for k, g in enumerate(segments):
        for i in range(g["w0"], g["w1"]):
            seg_of[i] = k
    mids = [(w["s"] + w["e"]) / 2 for w in words]
    per_seg: dict[int, list[dict]] = {k: [] for k in range(len(segments))}  # sentence -> its new words
    failed: set[int] = set()
    i = 0
    for (a, b), base, tash, other in zip(chunks, *read):
        w0 = i
        while i < len(words) and mids[i] < b:
            i += 1
        if w0 == i:
            continue
        new = _merge(words[w0:i], base, tash, other, edges=False)  # chunks end in silence: keep every word
        if new is None:
            failed.update(seg_of[w0:i])
            continue
        for w in new:
            per_seg[seg_of[w0 + w["src"]]].append(w)

    # sentences the models skipped (mostly) or whose chunk went wrong: one by one
    retry = sorted(k for k, g in enumerate(segments)
                   if k in failed or len(per_seg[k]) * 2 < g["w1"] - g["w0"])
    if retry:
        spans = [(segments[k]["s"], segments[k]["e"]) for k in retry]
        read = _read(spans, audio, (lambda f: on_progress(0.85 + 0.15 * f)) if on_progress else None)
        for k, base, tash, other in zip(retry, *read):
            new = _merge(words[segments[k]["w0"]:segments[k]["w1"]], base, tash, other)
            per_seg[k] = new or []

    new_words, new_segs, improved = [], [], 0
    for k, g in enumerate(segments):
        seg_words = per_seg.get(k)
        if seg_words:
            improved += 1
            seg_words = [{kk: v for kk, v in w.items() if kk != "src"} for w in seg_words]
        else:
            seg_words = words[g["w0"]:g["w1"]]
        first = len(new_words)
        new_words.extend(seg_words)
        new_segs.append({**g, "w0": first, "w1": len(new_words)})
    return new_words, new_segs, improved
