"""Find Quran verses and hadith in a transcript.

Quran: spoken words are matched against every verse (tolerant of small
transcription errors). A match of 4+ words, or 3+ right after a cue such as
"قال تعالى", is treated as Quran and the words are *replaced by the exact
Uthmani text* (with tashkeel), so Quran in captions is always 100% the mushaf.

Hadith: cue phrases ("قال رسول الله صلى الله عليه وسلم", "روى البخاري",
"عن ... قال", ...) mark the following words as a hadith quotation, and the
words are fuzzy-matched against the six books to show the source and grading.
Hadith wording is not forced (lecturers paraphrase); the reference text is
offered alongside.

Texts (downloaded on first use into models/texts/):
  Quran  - arbml/quran_uthmani (Hugging Face)
  Hadith - meeAtif/hadith_datasets (six books, MIT)
"""
import re
import urllib.request
from collections import defaultdict
from functools import lru_cache
from itertools import product
from pathlib import Path

TEXTS = Path(__file__).resolve().parent.parent / "models" / "texts"
QURAN_URL = "https://huggingface.co/datasets/arbml/quran_uthmani/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet"
HADITH_URL = "https://huggingface.co/datasets/meeAtif/hadith_datasets/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet"

SURAH_NAMES = (
    "الفاتحة البقرة آل_عمران النساء المائدة الأنعام الأعراف الأنفال التوبة يونس هود يوسف الرعد إبراهيم الحجر "
    "النحل الإسراء الكهف مريم طه الأنبياء الحج المؤمنون النور الفرقان الشعراء النمل القصص العنكبوت الروم لقمان "
    "السجدة الأحزاب سبأ فاطر يس الصافات ص الزمر غافر فصلت الشورى الزخرف الدخان الجاثية الأحقاف محمد الفتح "
    "الحجرات ق الذاريات الطور النجم القمر الرحمن الواقعة الحديد المجادلة الحشر الممتحنة الصف الجمعة المنافقون "
    "التغابن الطلاق التحريم الملك القلم الحاقة المعارج نوح الجن المزمل المدثر القيامة الإنسان المرسلات النبأ "
    "النازعات عبس التكوير الانفطار المطففين الانشقاق البروج الطارق الأعلى الغاشية الفجر البلد الشمس الليل الضحى "
    "الشرح التين العلق القدر البينة الزلزلة العاديات القارعة التكاثر العصر الهمزة الفيل قريش الماعون الكوثر "
    "الكافرون النصر المسد الإخلاص الفلق الناس").split()

QURAN_CUES = ["قال تعالى", "قال الله تعالى", "قال الله", "يقول الله", "يقول تعالى", "قال ربنا", "يقول ربنا",
              "قوله تعالى", "قول الله", "في كتابه", "اعوذ بالله من الشيطان الرجيم", "بسم الله الرحمن الرحيم",
              "قال سبحانه", "يقول سبحانه", "قال عز وجل", "يقول عز وجل", "تبارك وتعالى"]
# the lecturer is discussing a reading (qira'a): keep the harakat he says instead of forcing Hafs
QIRAAT_CUES = ["قراءة", "قراءه", "القراءة", "قرئ", "وقرئ", "قرا", "وقرا", "يقرا", "قراها", "بالكسر", "بالضم",
               "بالفتح", "بالسكون", "حفص", "ورش", "قالون", "يعقوب", "حمزة", "الكسائي", "ابن كثير", "ابو عمرو",
               "ابن عامر", "شعبة", "الجمهور"]
HADITH_CUES = ["قال رسول الله", "قال النبي", "قال الرسول", "يقول رسول الله", "يقول النبي", "عن النبي",
               "عن رسول الله", "روى البخاري", "روى مسلم", "رواه البخاري", "رواه مسلم", "في الصحيح", "في الصحيحين",
               "حدثنا", "اخبرنا", "صلى الله عليه وسلم قال", "ان رسول الله", "ان النبي",
               "قال صلى الله عليه وسلم", "يقول صلى الله عليه وسلم", "قوله صلى الله عليه وسلم",
               "في الحديث", "وفي الحديث", "في حديث", "وفي حديث", "في الصحيحين", "متفق عليه"]

_TASHKEEL = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿـ]")
_NONLETTER = re.compile(r"[^ء-ي0-9a-zA-Z]")


def norm(w: str) -> str:
    """Letters only, without tashkeel or Quranic marks; unify letter variants."""
    w = _TASHKEEL.sub("", w)
    w = (w.replace("ٱ", "ا").replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي")
         .replace("ة", "ه").replace("ؤ", "و").replace("ئ", "ي").replace("ء", ""))
    return _NONLETTER.sub("", w)


def _close(a: str, b: str) -> bool:
    """Same word allowing one transcription slip (for words of 4+ letters)."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4 or abs(len(a) - len(b)) > 1:
        return False
    # Levenshtein distance <= 1
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) <= 1
    s, l = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(s) and s[i] == l[i]:
        i += 1
    return s[i:] == l[i + 1:]


def _fetch(url: str, path: Path) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, path)
    return path


# ---------------- Quran ----------------

@lru_cache(maxsize=1)
def _quran():
    import pandas as pd

    df = pd.read_parquet(_fetch(QURAN_URL, TEXTS / "quran_uthmani.parquet"))
    verses = [(int(r.sorah), int(r.ayah), r.sentence) for r in df.itertuples()]
    if not any(s == 1 and a == 1 for s, a, _ in verses):  # this copy lacks the Fatiha basmala
        verses.insert(0, (1, 1, "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ"))
    verses.sort()
    tokens = []  # (normalised, original, surah, ayah)
    for s, a, text in verses:
        for t in text.split():
            n = norm(t)
            if n:
                tokens.append((n, t, s, a))
    index = defaultdict(list)
    for i in range(len(tokens) - 2):
        index[(tokens[i][0], tokens[i + 1][0], tokens[i + 2][0])].append(i)
    return tokens, index


def _same(word: str, tok) -> bool:
    """Spoken word vs Quran token. The mushaf writes some long a's as a small
    (dagger) alif, which ordinary spelling writes out: مَٰلِكِ = مالك."""
    if _close(word, tok[0]):
        return True
    return "\u0670" in tok[1] and _close(word, norm(tok[1].replace("\u0670", "ا")))


def _step(cands: list[list[str]], wi: int, toks, qi: int, back: bool = False) -> int:
    """How many spoken words (1 or 2) make mushaf word qi, ending/starting at
    word wi; 0 if they don't match."""
    if any(_same(c, toks[qi]) for c in cands[wi]):
        return 1
    o = wi - 1 if back else wi + 1
    if 0 <= o < len(cands):
        for a in cands[o] if back else cands[wi]:
            for b in cands[wi] if back else cands[o]:
                if _same(a + b, toks[qi]):
                    return 2
    return 0


def _extend(cands: list[list[str]], i: int, toks, p: int, back: bool = False) -> list[tuple[int, int, int, int]]:
    """Run of matching words from transcript word i / Quran token p (forwards,
    or backwards from just before them), as (first word, end word, first token,
    number of tokens). A word matches if any reading of it does (what the
    recognisers heard, cands[i]); a misheard word (one letter off) is fine, and
    two spoken words may make one mushaf word (يا موسى = يَٰمُوسَىٰ). A stretch
    that doesn't match (1-2 words for 1-2 mushaf words, e.g. أجرهم heard for
    أَجَلٍ هُم) is taken as misheard only if the next two words match again;
    otherwise the run ends, so a lecturer's own words inside a quotation are
    never overwritten."""
    d = -1 if back else 1
    pairs: list[tuple[int, int, int, int]] = []
    wi, qi = (i - 1, p - 1) if back else (i, p)

    def ok(wi: int, qi: int) -> int:
        return _step(cands, wi, toks, qi, back) if 0 <= wi < len(cands) and 0 <= qi < len(toks) else 0

    def anchored(wi: int, qi: int) -> bool:  # the next two mushaf words match from here
        n = ok(wi, qi)
        return bool(n) and bool(ok(wi + d * n, qi + d))

    while 0 <= wi < len(cands) and 0 <= qi < len(toks):
        n, nq = ok(wi, qi), 1
        if not n:
            if not pairs:
                break
            gap = next(((nw, nt) for nw, nt in ((1, 1), (1, 2), (2, 1))
                        if 0 <= wi + d * (nw - 1) < len(cands) and anchored(wi + d * nw, qi + d * nt)), None)
            if gap is None:
                break
            n, nq = gap
        a, b = (wi - n + 1, wi + 1) if back else (wi, wi + n)
        q = qi - nq + 1 if back else qi
        pairs.append((a, b, q, nq))
        wi, qi = wi + d * n, qi + d * nq
    return pairs[::-1] if back else pairs


BASMALA = [norm(w) for w in "بسم الله الرحمن الرحيم".split()]
MIN_QURAN, MIN_QURAN_CUED = 5, 3


def _quran_span(toks, pairs: list[tuple[int, int, int, int]]) -> dict:
    q0, q1 = pairs[0][2], pairs[-1][2] + pairs[-1][3] - 1
    s0, a0, s1, a1 = toks[q0][2], toks[q0][3], toks[q1][2], toks[q1][3]
    ref = f"{SURAH_NAMES[s0 - 1].replace('_', ' ')} {s0}:{a0}" + (f"–{a1}" if (s1, a1) != (s0, a0) else "")
    return {"type": "quran", "w0": pairs[0][0], "w1": pairs[-1][1], "ref": ref, "surah": s0, "ayah": a0,
            "ayah_end": a1, "text": " ".join(t[1] for t in toks[q0:q1 + 1]),
            # (first word, end word, mushaf text for them: usually one word, two where one was misheard)
            "map": [[a, b, " ".join(t[1] for t in toks[q:q + nq])] for a, b, q, nq in pairs],
            "matched": len(pairs), "url": f"https://quran.com/{s0}/{a0}", "_pairs": pairs}


MERGE_GAP = 2  # words


def _merge_runs(toks, spans: list[dict]) -> list[dict]:
    """Join two runs of the same quotation split by 1-2 words the recogniser got
    wrong (e.g. عنه for عَنْهُمُ): only when exactly as many mushaf words lie
    between them, so the gap is filled by the mushaf words that belong there."""
    out: list[dict] = []
    for sp in spans:
        if out:
            prev = out[-1]
            pa, pb = prev["_pairs"], sp["_pairs"]
            gap = pb[0][0] - pa[-1][1]
            qend = pa[-1][2] + pa[-1][3]
            if 0 <= gap <= MERGE_GAP and pb[0][2] - qend == gap:
                fill = [(pa[-1][1] + k, pa[-1][1] + k + 1, qend + k, 1) for k in range(gap)]
                merged = _quran_span(toks, pa + fill + pb)
                if prev.get("keep_spoken") or sp.get("keep_spoken"):
                    merged["keep_spoken"] = True
                out[-1] = merged
                continue
        out.append(sp)
    return out


@lru_cache(maxsize=1)
def _bigrams() -> dict[tuple[str, str], list[int]]:
    toks = _quran()[0]
    out: dict[tuple[str, str], list[int]] = defaultdict(list)
    for k in range(len(toks) - 1):
        out[(toks[k][0], toks[k + 1][0])].append(k)
    return out


@lru_cache(maxsize=1)
def _short_ayahs() -> dict[tuple[str, str], list[int]]:
    """Two-word ayahs (e.g. 74:5 وَٱلرُّجْزَ فَٱهْجُرْ), by their words: too short
    for the 3-word index, so they're only looked up right after a cue."""
    toks = _quran()[0]
    by_ayah: dict[tuple[int, int], list[int]] = defaultdict(list)
    for k, t in enumerate(toks):
        by_ayah[(t[2], t[3])].append(k)
    out: dict[tuple[str, str], list[int]] = defaultdict(list)
    for ks in by_ayah.values():
        if len(ks) == 2:
            out[(toks[ks[0]][0], toks[ks[1]][0])].append(ks[0])
    return out


CUE_REACH = 6  # a quotation may start this many words after a cue


def _places(toks, options: list[list[tuple[int, int, int, int]]]) -> tuple[list, int, bool]:
    """The longest of the candidate runs, how many different places in the Quran
    it fits equally well, and whether the mushaf text is the same in all of them."""
    n = max(len(o) for o in options)
    top = [o for o in options if len(o) == n]
    starts = {o[0][2] for o in top}
    texts = {tuple(toks[q][1] for _, _, q, _ in o) for o in top}
    return top[0], len(starts), len(texts) == 1


def find_quran(words: list[str], alts: list[list[str]] | None = None) -> list[dict]:
    """Quran spans in a list of transcript words (as spoken). alts[i]: other
    readings of word i (what the other recognisers heard), also tried.

    Without a cue, a quotation needs 5+ matching words (or a basmala). Right
    after a cue («قال تعالى», «قال ربنا», ...) any 2+ words that continue the
    mushaf count. If they fit several places equally, the span is still Quran
    but no surah/ayah is claimed (ref starts with "~"), and the mushaf text is
    only applied if it reads the same in all of them."""
    toks, index = _quran()
    bigrams = _bigrams()
    nw = [norm(w) for w in words]
    cands = [[n] + [x for x in (norm(a) for a in (alts[k] if alts else [])) if x and x != n] for k, n in enumerate(nw)]
    cue_at = _cue_positions(nw, QURAN_CUES)
    qiraat_at = _cue_positions(nw, QIRAAT_CUES)
    out, i = [], 0
    while i < len(nw) - 1:
        options = []
        for p in index.get(tuple(nw[i:i + 3]), [])[:200] if i < len(nw) - 2 else []:
            pairs = _extend(cands, i, toks, p)
            if pairs:  # words before the three that found it may belong too
                start = out[-1]["w1"] if out else 0
                pairs = [x for x in _extend(cands, i, toks, p, back=True) if x[0] >= start] + pairs
                options.append(pairs)
        # a cue introduces the first quotation after it, not whatever follows that one
        cued = any(0 <= i - c <= CUE_REACH and not (out and out[-1]["w0"] >= c) for c in cue_at)
        if cued:  # after a cue, two words are enough to look
            for p in bigrams.get((nw[i], nw[i + 1]), [])[:3000]:
                pairs = _extend(cands, i, toks, p)
                if len(pairs) >= 2:
                    options.append(pairs)
        repeat = bool(out) and 0 <= i - out[-1]["w1"] <= 3
        if repeat:  # saying the quotation just made again (lecturers often repeat a verse)
            pairs = _extend(cands, i, toks, out[-1]["_pairs"][0][2])
            if len(pairs) >= 2:
                options.append(pairs)
        best, places, same = _places(toks, options) if options else (None, 0, True)
        basmala = nw[i:i + 4] == BASMALA
        again = repeat and best is not None and best[0][2] == out[-1]["_pairs"][0][2]
        if best and (len(best) >= MIN_QURAN or ((cued or again) and len(best) >= 2) or (basmala and len(best) >= 4)):
            sp = _quran_span(toks, best)
            if places > 1 and not again:
                sp["ref"] = "~" + sp["ref"]  # Quran, but which surah/ayah can't be told
                sp["places"] = places
                sp["url"] = None
                sp["keep_spoken"] = not same
            if any(sp["w0"] - 10 <= c <= sp["w1"] for c in qiraat_at):
                sp["keep_spoken"] = True
            out.append(sp)
            i = best[-1][1]
        else:
            i += 1
    return _merge_runs(toks, out)


# ---------------- Hadith ----------------

COMMON_GRAM = 300  # a 3-word phrase in this many hadith says nothing about which one


@lru_cache(maxsize=1)
def _hadith():
    import pandas as pd

    df = pd.read_parquet(_fetch(HADITH_URL, TEXTS / "hadith_six_books.parquet"))
    rows, index = [], defaultdict(set)
    for r in df.itertuples():
        text = r.Arabic_Text or ""
        ws = [norm(w) for w in text.split()]
        ws = [w for w in ws if w]
        k = len(rows)
        rows.append({"book": r.Book, "url": r.Reference, "grade": r.Grade or "", "text": text,
                     "english": r.English_Text or ""})
        for g in zip(ws, ws[1:], ws[2:]):
            index[g].add(k)
    # drop formulas (صلى الله عليه وسلم, رضي الله عنه, حدثنا فلان ...) that match everything
    index = {g: ks for g, ks in index.items() if len(ks) < COMMON_GRAM}
    return rows, index


def _cue_positions(nw: list[str], cues: list[str]) -> list[int]:
    """Word index right after each cue phrase."""
    seqs = [[norm(w) for w in c.split()] for c in cues]
    out = []
    for i in range(len(nw)):
        for sq in seqs:
            if nw[i:i + len(sq)] == sq:
                out.append(i + len(sq))
    return sorted(set(out))


def _gram_weight(n: int) -> float:
    """A 3-word phrase found in n hadith: the rarer, the more it says about which one."""
    return 1.0 if n <= 5 else 0.5 if n <= 50 else 0.2


def find_hadith(words: list[str], quran: list[dict] | None = None,
                alts: list[list[str]] | None = None) -> list[dict]:
    """Hadith quotations: after a cue, or a strong match to the collections.
    alts[i]: other readings of word i, also tried (a misheard word shouldn't
    hide a hadith)."""
    from itertools import product as _product

    rows, index = _hadith()
    nw = [norm(w) for w in words]
    cands = [[n] + [x for x in (norm(a) for a in (alts[k] if alts else [])) if x and x != n][:2] for k, n in enumerate(nw)]
    taken = set()
    for q in quran or []:
        taken.update(range(q["w0"], q["w1"]))

    def best_match(a: int, b: int):
        score: dict[int, float] = defaultdict(float)
        for i in range(a, min(b, len(nw)) - 2):
            if taken.intersection((i, i + 1, i + 2)):  # Quran words: hadith often quote verses
                continue
            seen = set()
            for g in _product(cands[i], cands[i + 1], cands[i + 2]):
                for k in index.get(g, ()):
                    if k not in seen:  # one phrase position counts once per hadith
                        seen.add(k)
                        score[k] += _gram_weight(len(index[g]))
        if not score:
            return None, 0.0
        k = max(score, key=score.get)
        return k, score[k]

    def inside(k: int, j: int) -> bool:
        hw = _hadith_words(k)
        return j not in taken and any(c in hw for c in cands[j])

    def _span_end(k: int, a: int, b: int) -> int:
        """End of the quotation: the last word in the hadith before 3 in a row
        that aren't (attribution such as «ومسلم في صحيحيهما عن» doesn't count)."""
        last, miss = a, 0
        for j in range(a, b):
            if inside(k, j) and nw[j] not in _FRAME:
                last, miss = j, 0
            elif nw[j] not in _FRAME and nw[j] not in _ATTRIBUTION:
                miss += 1
                if miss >= 3:
                    break
        return last + 1

    def content(k: int, a: int, b: int) -> int:  # words of the hadith itself, not its frame
        return sum(1 for j in range(a, b) if nw[j] not in _FRAME and inside(k, j))

    out, starts = [], _cue_positions(nw, HADITH_CUES)
    for st in starts:
        if st in taken:
            continue
        e = min(len(nw), st + 40)
        k, sc = best_match(max(0, st - 12), e)
        end = _span_end(k, st, e) if k is not None else st
        if k is not None and sc >= 2.0 and content(k, st, end) >= 2:
            out.append(_hadith_span(rows[k], st, end, round(sc, 1), True))
        else:
            out.append({"type": "hadith", "w0": st, "w1": min(len(nw), st + 15), "ref": None, "url": None,
                        "grade": None, "text": None, "matched": 0, "cued": True})
    # strong matches without a cue
    i = 0
    while i < len(nw) - 12:
        if i in taken or any(o["w0"] <= i < o["w1"] for o in out):
            i += 1
            continue
        k, sc = best_match(i, i + 14)
        if k is not None and sc >= 5.0:
            j = _span_end(k, i, min(len(nw), i + 60))
            if content(k, i, j) >= 2:
                out.append(_hadith_span(rows[k], i, j, round(sc, 1), False))
            i = j + 1
        else:
            i += 4
    # merge overlapping / adjacent spans; keep the better-matched reference
    out.sort(key=lambda o: o["w0"])
    merged: list[dict] = []
    for o in out:
        if merged and o["w0"] <= merged[-1]["w1"] + 3 and (o["ref"] == merged[-1]["ref"] or not o["ref"] or not merged[-1]["ref"]):
            m = merged[-1]
            keep = m if m["matched"] >= o["matched"] else o
            merged[-1] = {**keep, "w0": min(m["w0"], o["w0"]), "w1": max(m["w1"], o["w1"])}
        else:
            merged.append(o)
    return [o for o in merged if o["w0"] not in taken]


@lru_cache(maxsize=4096)
def _hadith_words(k: int) -> frozenset:
    return frozenset(n for n in (norm(w) for w in _hadith()[0][k]["text"].split()) if n)


def _align_into(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """Pairs (i, j) of a (spoken words) aligned into a stretch of b (a hadith
    text, much longer): b's words before and after the stretch cost nothing."""
    import difflib

    def sub(x: str, y: str) -> float:
        return 0.0 if x == y else 1.0 - 0.8 * difflib.SequenceMatcher(None, x, y, autojunk=False).ratio()

    GAP = 0.6
    n, m = len(a), len(b)
    cost = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        cost[i][0] = i * GAP
        for j in range(1, m + 1):
            cost[i][j] = min(cost[i - 1][j - 1] + sub(a[i - 1], b[j - 1]), cost[i - 1][j] + GAP,
                             cost[i][j - 1] + (0.0 if i == n else GAP))
    pairs, i, j = [], n, min(range(m + 1), key=lambda j: cost[n][j])
    while i and j:
        if abs(cost[i][j] - (cost[i - 1][j - 1] + sub(a[i - 1], b[j - 1]))) < 1e-9:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif abs(cost[i][j] - (cost[i - 1][j] + GAP)) < 1e-9:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


# words of a hadith's frame (narrators, formulas, attribution), never "corrected" from its text
# how a lecturer introduces a hadith: part of the quotation's span, not of the hadith's text
_ATTRIBUTION = {norm(w) for w in "صحيحه صحيحهما صحيحيهما الصحيح الصحيحين في وفي رواه روى البخاري ومسلم "
                "مسلم الترمذي النسائي داود ماجه احمد اخرجه اخرج قال وقال".split()}
_FRAME = {norm(w) for w in "صلى الله عليه وسلم ومسلم مسلم البخاري رضي عنه عنها قال وقال فقال عن حدثنا اخبرنا "
          "رواه روى ابن ابو ابي بن النبي رسول".split()}


def apply_hadith(words: list[dict], spans: list[dict]) -> int:
    """Inside a recognised hadith, correct a word to the collection's wording
    (with its harakat), but only where a recogniser actually heard that word,
    or the word was already doubtful and is one letter off. Lecturers
    paraphrase hadith, so nothing else is touched. Returns words corrected."""
    n = 0
    for sp in spans:
        if sp["type"] != "hadith" or not sp.get("text"):
            continue
        hw = [w for w in sp["text"].split() if norm(w)]
        span = words[sp["w0"]:sp["w1"]]
        for i, j in _align_into([norm(w["w"]) for w in span], [norm(w) for w in hw]):
            w, h = span[i], hw[j]
            nh, nwd = norm(h), norm(w["w"])
            if nh == nwd or w.get("quran") or nh in _FRAME or nwd in _FRAME:
                continue
            heard = {norm(x) for x in w.get("alts", []) + [w.get("asr", "")] if x}
            if nh in heard or (w.get("flag") and _close(nwd, nh)):
                w.setdefault("spoken", w["w"])
                w["w"] = h.strip("،,.؛:\"‏")
                w["hadith"] = sp["ref"]
                w.pop("flag", None)
                n += 1
    return n


def _hadith_span(row: dict, w0: int, w1: int, score: int, cued: bool) -> dict:
    num = row["url"].rsplit(":", 1)[-1] if row["url"] else ""
    return {"type": "hadith", "w0": w0, "w1": w1, "ref": f"{row['book']} {num}".strip(), "url": row["url"],
            "grade": row["grade"], "text": row["text"], "english": row["english"][:600], "matched": score,
            "cued": cued}


def find_sources(words: list[str], alts: list[list[str]] | None = None) -> list[dict]:
    quran = find_quran(words, alts)
    return sorted(quran + find_hadith(words, quran, alts), key=lambda o: o["w0"])


def apply_quran(words: list[dict], spans: list[dict]) -> int:
    """Replace recognised Quran quotations with the exact mushaf text (word for
    word, keeping timings). Where two spoken words make one mushaf word, the
    second is marked "_drop" (see annotate). Returns the number of words replaced."""
    n = 0
    for sp in spans:
        if sp["type"] != "quran":
            continue
        for a, b, tok in sp["map"]:
            if sp.get("keep_spoken"):  # a reading the lecturer chose, or text that differs between places
                for x in words[a:b]:
                    x["quran"] = sp["ref"]
                    x.pop("flag", None)
                continue
            w = words[a]
            spoken = " ".join(x.get("spoken", x["w"]) for x in words[a:b])
            if w["w"] != tok or b - a > 1:
                w.setdefault("spoken", spoken)
                w["w"] = tok
                n += 1
            if b - a > 1:
                # keep every reading of the joined words, so checking again finds the same match
                readings = [[x.get("spoken", x["w"])] + x.get("alts", []) + ([x["asr"]] if x.get("asr") else [])
                            for x in words[a:b]]
                w["alts"] = list(dict.fromkeys(" ".join(c) for c in product(*readings)))[:12]
                w.pop("asr", None)
                w["e"] = words[b - 1]["e"]
                for x in words[a + 1:b]:
                    x["_drop"] = True
            w["quran"] = sp["ref"]
            w.pop("flag", None)  # mushaf text: nothing left to doubt (other readings stay in "alts")
    return n


_CLITICS = ("وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ل", "ك")
_STOP = {norm(w) for w in "الشيخ الدكتور مع في من على عن الى ما هل كيف لماذا هذا هذه ذلك التي الذي قد لا لن ان او ثم "
         "بين حتى عند كل بعض نفسك".split()}


def _core(n: str) -> tuple[str, str]:
    """(prefix, stem) of a normalised word: والرجز -> (وال, رجز)."""
    for c in _CLITICS:
        if n.startswith(c) and len(n) - len(c) >= 3:
            return c, n[len(c):]
    return "", n


def vocabulary(title: str | None) -> dict[str, str]:
    """Stems of the title's content words -> how the title writes them."""
    out = {}
    for w in (title or "").split():
        n = norm(w)
        if len(n) >= 3 and n not in _STOP:
            out.setdefault(_core(n)[1], w.strip("؟?!.،,:«»\"'()|"))
    return out


def _letters(surface: str, k: int) -> tuple[str, str]:
    """Split a written word after its first k letters (harakat stay with their letter)."""
    seen = 0
    for idx, ch in enumerate(surface):
        if norm(ch):
            if seen == k:
                return surface[:idx], surface[idx:]
            seen += 1
    return surface, ""


def apply_vocab(words: list[dict], title: str | None) -> int:
    """A doubtful word one letter away from a word of the lecture's title
    (prefixes like و/ف/ب/ال aside) becomes the title's word: the topic tells
    which of two similar sounding words is meant (والرجل -> والرجز in a lecture
    on الرجز). If it is near two title words, the one another recogniser heard,
    or else the one used more nearby, wins. Marked "voted" with the old reading
    in alts. Returns words changed."""
    vocab = vocabulary(title)
    stems = [_core(norm(w["w"]))[1] for w in words]
    n = 0
    for i, w in enumerate(words):
        if w.get("flag") != "doubt" or w.get("quran") or w.get("hadith"):
            continue
        pre, stem = _core(norm(w["w"]))
        if len(stem) < 3 or stem in vocab:
            continue
        hits = [v for v in vocab if len(v) >= 3 and (_close(stem, v) or (
            len(stem) == len(v) and sum(a != b for a, b in zip(stem, v)) == 1))]
        if len(hits) > 1:
            heard = {_core(norm(a))[1] for a in w.get("alts", []) + [w.get("asr", "")] if a}
            hits = [v for v in hits if v in heard] or hits
        if len(hits) > 1:
            near = stems[max(0, i - 40):i + 40]
            count = {v: near.count(v) for v in hits}
            top = max(count.values())
            hits = [v for v in hits if count[v] == top]
        if len(hits) != 1:
            continue
        title_word = vocab[hits[0]]
        title_pre, _ = _core(norm(title_word))
        stem_surface = _letters(title_word, len(title_pre))[1]
        pre_surface = _letters(w["w"], len(pre))[0]
        w.setdefault("spoken", w["w"])
        w["alts"] = [w["w"]] + [a for a in w.get("alts", []) if a != w["w"]]
        w["w"], w["flag"], w["vocab"] = pre_surface + stem_surface, "voted", True
        n += 1
    return n


def _drop_words(data: dict, spans: list[dict]) -> None:
    """Remove words marked "_drop" and shift sentence and span indices to match."""
    words = data["words"]
    if not any(w.get("_drop") for w in words):
        return
    new_index, kept = [], []
    for w in words:
        new_index.append(len(kept))
        if not w.get("_drop"):
            kept.append(w)
    new_index.append(len(kept))
    data["words"] = kept
    for g in data.get("segments", []) + spans:
        g["w0"], g["w1"] = new_index[g["w0"]], new_index[g["w1"]]


SOURCES_VERSION = 6  # bump when matching improves: older transcripts are checked again when opened


def annotate(data: dict) -> dict:
    """Find Quran/hadith in a transcript dict (words.json) and apply the Quran text.
    Safe to run again: earlier Quran replacements are undone first."""
    for w in data["words"]:
        if "quran" in w or "hadith" in w or "vocab" in w:
            w["w"] = w.pop("spoken", w["w"])
            if w.pop("vocab", None):
                w["flag"] = "doubt"
            w.pop("quran", None)
            w.pop("hadith", None)
    words = data["words"]
    alts = [list(w.get("alts", [])) + ([w["asr"]] if w.get("asr") and " " not in w["asr"] else []) for w in words]
    spans = find_sources([w.get("spoken", w["w"]) for w in words], alts)
    apply_quran(words, spans)
    _drop_words(data, spans)
    apply_hadith(data["words"], spans)
    apply_vocab(data["words"], data.get("title"))
    data["sources"] = [{k: v for k, v in sp.items() if k not in ("tokens", "map", "_pairs")} for sp in spans]
    data["sources_version"] = SOURCES_VERSION
    return data


# ---------------- on-screen reference ----------------

_AR_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")


SURAH_NAMES_EN = (
    "Al-Fatihah Al-Baqarah Aal_Imran An-Nisa Al-Ma'idah Al-An'am Al-A'raf Al-Anfal At-Tawbah Yunus Hud Yusuf "
    "Ar-Ra'd Ibrahim Al-Hijr An-Nahl Al-Isra Al-Kahf Maryam Ta-Ha Al-Anbiya Al-Hajj Al-Mu'minun An-Nur Al-Furqan "
    "Ash-Shu'ara An-Naml Al-Qasas Al-Ankabut Ar-Rum Luqman As-Sajdah Al-Ahzab Saba Fatir Ya-Sin As-Saffat Sad "
    "Az-Zumar Ghafir Fussilat Ash-Shura Az-Zukhruf Ad-Dukhan Al-Jathiyah Al-Ahqaf Muhammad Al-Fath Al-Hujurat "
    "Qaf Adh-Dhariyat At-Tur An-Najm Al-Qamar Ar-Rahman Al-Waqi'ah Al-Hadid Al-Mujadilah Al-Hashr Al-Mumtahanah "
    "As-Saff Al-Jumu'ah Al-Munafiqun At-Taghabun At-Talaq At-Tahrim Al-Mulk Al-Qalam Al-Haqqah Al-Ma'arij Nuh "
    "Al-Jinn Al-Muzzammil Al-Muddaththir Al-Qiyamah Al-Insan Al-Mursalat An-Naba An-Nazi'at Abasa At-Takwir "
    "Al-Infitar Al-Mutaffifin Al-Inshiqaq Al-Buruj At-Tariq Al-A'la Al-Ghashiyah Al-Fajr Al-Balad Ash-Shams "
    "Al-Layl Ad-Duha Ash-Sharh At-Tin Al-Alaq Al-Qadr Al-Bayyinah Az-Zalzalah Al-Adiyat Al-Qari'ah At-Takathur "
    "Al-Asr Al-Humazah Al-Fil Quraysh Al-Ma'un Al-Kawthar Al-Kafirun An-Nasr Al-Masad Al-Ikhlas Al-Falaq "
    "An-Nas").split()


def quran_label(ref: str, lang: str = "ar") -> str:
    """'البقرة 2:93' -> 'سورة البقرة، الآية ٩٣' (or 'Quran · Al-Baqarah 2:93').
    A ref starting with "~" (words found in several places) names no surah."""
    if ref.startswith("~"):
        return "من القرآن الكريم" if lang == "ar" else "Quran"
    name, _, num = ref.rpartition(" ")
    surah, _, ayat = num.partition(":")
    if lang != "ar":
        k = int(surah) if surah.isdigit() else 0
        return f"Quran · {SURAH_NAMES_EN[k - 1].replace('_', ' ')} {num}" if 1 <= k <= 114 else f"Quran {num}"
    many = "–" in ayat
    return f"سورة {name}، {'الآيات' if many else 'الآية'} {ayat.translate(_AR_DIGITS)}"
