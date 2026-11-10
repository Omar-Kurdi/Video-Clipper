"""Captions: map source word timings onto the cut timeline and draw them.

Captions are rendered with Pillow (raqm layout, so Arabic shapes and runs
right-to-left) as RGBA overlays and composited per frame. Looks are driven by
a style: a preset name (see PRESETS) or a JSON file such as

    {"base": "pill", "captions": {"size": 70, "highlight": "#7CF29C"},
     "title": {"color": "#FFFFFF"}}
"""
import json
import re
import subprocess
from dataclasses import dataclass, fields, replace
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .plan import Segment, output_starts

Word = tuple  # text, start, end (output seconds)[, transcript index, lecture start, lecture end]


@dataclass(frozen=True)
class TextStyle:
    font: str = "Noto Sans Arabic:style=Bold"  # fontconfig pattern or .ttf/.otf path
    size: int = 64
    color: str = "#FFFFFF"
    highlight: str | None = None    # colour of the word being spoken
    box: bool = True
    box_color: str = "#000000"
    box_opacity: float = 0.6
    radius: int = 14
    pad_x: int = 30
    pad_y: int = 16
    outline: int = 0
    outline_color: str = "#000000"
    shadow: int = 0                 # blur radius of a soft drop shadow
    y: float = 0.52                 # vertical centre, fraction of frame height (above every app's bottom bar)
    max_words: int = 3
    max_chars: int = 22
    max_seconds: float = 0.0        # longest a caption stays up (0: no limit); longer ones are split
    fade_ms: int = 90


@dataclass(frozen=True)
class Style:
    captions: TextStyle
    title: TextStyle


PRESETS: dict[str, Style] = {
    # dark translucent box, like the reference short
    "box": Style(TextStyle(),
                 TextStyle(size=44, color="#FFD54A", box_opacity=0.55, radius=10,
                           pad_x=22, pad_y=10, y=0.60)),
    # rounded pill, spoken word highlighted
    "pill": Style(TextStyle(radius=40, box_opacity=0.72, pad_x=40, pad_y=18, highlight="#FFD54A"),
                  TextStyle(size=42, color="#111111", box_color="#FFD54A", box_opacity=1.0,
                            radius=30, pad_x=28, pad_y=10, y=0.60)),
    # no box, thick outline (classic shorts look)
    "outline": Style(TextStyle(size=76, box=False, outline=7, shadow=6, highlight="#FFD54A",
                               max_words=2, max_chars=16),
                     TextStyle(size=44, color="#FFD54A", box=False, outline=5, y=0.60)),
    # quiet: soft shadow only
    "minimal": Style(TextStyle(size=60, box=False, shadow=10),
                     TextStyle(size=40, color="#E8E8E8", box=False, shadow=8, y=0.60)),
}


def load_style(spec: str) -> Style:
    if spec in PRESETS:
        return PRESETS[spec]
    return style_from_dict(json.loads(Path(spec).read_text(encoding="utf-8")))


def style_from_dict(data: dict) -> Style:
    """{"base": preset, "captions": {...overrides}, "title": {...overrides}}"""
    base = PRESETS[data.get("base", "box")]
    known = {f.name for f in fields(TextStyle)}

    def merge(ts: TextStyle, over: dict) -> TextStyle:
        bad = set(over) - known
        if bad:
            raise ValueError(f"unknown style keys {sorted(bad)}; valid: {sorted(known)}")
        return replace(ts, **over)

    return Style(merge(base.captions, data.get("captions", {})),
                 merge(base.title, data.get("title", {})))


# ---------- timing ----------

# the surah/ayah tag shown while a Quran verse is quoted: small, gold, no box
TAG_STYLE = TextStyle(size=32, color="#FFD54A", box=False, shadow=6, outline=0, pad_x=8, pad_y=4)
TAG_FADE = 0.25


def map_words(words: list[dict], segs: list[Segment], fps: Fraction, d: int,
              keep_all: bool = False) -> list[Word]:
    """Each word goes to the segment it overlaps most, clipped to that segment.
    With `keep_all` (the words are already the ones the user chose), a word that
    lands in a removed pause, or has no length, goes to the nearest cut instead
    of being dropped: the transcript is what the captions must show."""
    starts = output_starts(segs, d)
    bounds = [(float(s.f0 / fps), float(s.f1 / fps)) for s in segs]
    out = []
    for w in words:
        best, best_ov = None, 0.0
        for i, (a, b) in enumerate(bounds):
            ov = min(b, w["e"]) - max(a, w["s"])
            if ov > best_ov:
                best, best_ov = i, ov
        if best is None and keep_all and bounds:
            mid = (w["s"] + w["e"]) / 2
            best = min(range(len(bounds)), key=lambda i: max(bounds[i][0] - mid, mid - bounds[i][1], 0))
            a, b = bounds[best]
            t = float(starts[best] / fps) + min(max(mid, a), b) - a
            out.append((w["w"], t, t, w.get("_i"), w["s"], w["e"]))
            continue
        if best is None:
            continue
        a, b = bounds[best]
        base = float(starts[best] / fps)
        out.append((w["w"], base + max(w["s"], a) - a, base + min(w["e"], b) - a, w.get("_i"), w["s"], w["e"]))
    out.sort(key=lambda x: x[1])
    return out


def to_output(t: float, segs: list[Segment], fps: Fraction, d: int) -> float:
    """A lecture time in output seconds (a time in a removed pause goes to the nearest cut)."""
    starts = output_starts(segs, d)
    bounds = [(float(s.f0 / fps), float(s.f1 / fps)) for s in segs]
    k = min(range(len(bounds)), key=lambda i: max(bounds[i][0] - t, t - bounds[i][1], 0))
    a, b = bounds[k]
    return float(starts[k] / fps) + min(max(t, a), b) - a


def word_key(w) -> float:
    """How a caption word is named in a short's caption edits: its start in the
    lecture. Indices shift when a sentence gains or loses words; times don't."""
    return round(w[4], 2)


def chunk(mapped: list[Word], ts: TextStyle, break_gap: float = 0.3,
          starts: set | None = None, joins: set | None = None) -> list[list[Word]]:
    """Words into captions. `starts`/`joins` (word keys, see word_key) are the
    user's own splits: a word in `starts` always begins a caption, one in
    `joins` never does."""
    starts, joins = starts or set(), joins or set()
    chunks, cur = [], []
    for w in mapped:
        key = word_key(w) if len(w) > 4 else None
        if cur and key in starts or cur and key not in joins and (
                len(cur) >= ts.max_words
                or len(" ".join(x[0] for x in cur + [w])) > ts.max_chars
                or (ts.max_seconds > 0 and w[2] - cur[0][1] > ts.max_seconds)
                or w[1] - cur[-1][2] > break_gap):
            chunks.append(cur)
            cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


# ---------- drawing ----------

def _rgba(hex_color: str, opacity: float = 1.0) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), round(255 * opacity)


def _is_rtl(text: str) -> bool:
    return any("֐" <= ch <= "ࣿ" or "יִ" <= ch <= "ﻼ" for ch in text)


@lru_cache(maxsize=None)
def _font_file(pattern: str) -> str:
    if Path(pattern).suffix.lower() in (".ttf", ".otf", ".ttc"):
        return pattern
    return subprocess.run(["fc-match", "-f", "%{file}", pattern],
                          check=True, capture_output=True, text=True).stdout


@lru_cache(maxsize=None)
def _font(pattern: str, size: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(_font_file(pattern), size, layout_engine=ImageFont.Layout.RAQM)
    if ":style=" in pattern:  # variable fonts need the weight picked explicitly
        want = pattern.split(":style=", 1)[1].split(":")[0].encode()
        try:
            if want in font.get_variation_names():
                font.set_variation_by_name(want)
        except OSError:
            pass  # not a variable font
    return font


def _latin(pattern: str) -> str:
    """The same font for Latin text, or the closest one that has Latin letters
    (Arabic fonts such as Noto Sans Arabic have none)."""
    if Path(pattern).suffix.lower() in (".ttf", ".otf", ".ttc"):
        return pattern
    return pattern + ":charset=41-5a 61-7a"


HARAKAT = re.compile("[\u064B-\u0652\u0670]")


@lru_cache(maxsize=None)
def _ink_extent(pattern: str, size: int, rtl: bool, marks: bool = False) -> tuple[int, int]:
    """Top/bottom of the inked pixels of typical text drawn at y=0 (tall
    letters and descenders; with marks: harakat, shadda stacked with fatha
    above and with kasra below)."""
    ref = ("إِنِّي لَّهُ كُلِّ الْجَيْبُ" if marks else "الجيب كلمة") if rtl else "Hgjy"
    font = _font(pattern, size)
    img = Image.new("L", (size * 12, size * 4), 0)
    ImageDraw.Draw(img).text((size, size), ref, font=font, fill=255,
                             direction="rtl" if rtl else "ltr")
    rows = np.where(np.asarray(img).max(axis=1) > 0)[0]
    return int(rows[0]) - size, int(rows[-1]) - size + 1


def render_text(words: tuple[str, ...], ts: TextStyle, active: int = -1,
                max_width: int = 800) -> np.ndarray:
    """RGBA image of one caption line. Words are laid out right-to-left for
    RTL scripts, so punctuation stays at the end of the sentence."""
    rtl = _is_rtl(" ".join(words))
    direction = "rtl" if rtl else "ltr"
    pattern = ts.font if rtl else _latin(ts.font)
    size = ts.size
    while True:
        font = _font(pattern, size)
        space = font.getlength(" ", direction=direction)
        widths = [font.getlength(w, direction=direction) for w in words]
        text_w = sum(widths) + space * (len(words) - 1)
        if text_w + 2 * ts.pad_x <= max_width or size <= 24:
            break
        size = int(size * 0.92)
    # size the box from real glyph ink of a fixed reference string, so text is
    # optically centred and caption boxes share one height (a taller one with
    # harakat, so the marks stay inside the box)
    top, bottom = _ink_extent(pattern, size, rtl, bool(rtl and HARAKAT.search("".join(words))))
    margin = ts.shadow * 2 + ts.outline
    W = int(text_w + 2 * ts.pad_x + 2 * margin)

    # word positions, in reading order
    x = W - margin - ts.pad_x if rtl else margin + ts.pad_x
    placed = []
    for w, wd in zip(words, widths):
        if rtl:
            x -= wd
            placed.append((x, w))
            x -= space
        else:
            placed.append((x, w))
            x += wd + space

    # this caption's own ink (drawn at y=0): the box is never shorter than it
    probe = Image.new("L", (W, 6 * size), 0)
    pd = ImageDraw.Draw(probe)
    for px, w in placed:
        pd.text((px, 2 * size), w, font=font, fill=255, direction=direction, stroke_width=ts.outline)
    rows = np.where(np.asarray(probe).max(axis=1) > 0)[0]
    ink_top, ink_bottom = (int(rows[0]) - 2 * size, int(rows[-1]) - 2 * size + 1) if len(rows) else (top, bottom)
    H = int(max(bottom - top, ink_bottom - ink_top) + 2 * ts.pad_y + 2 * margin)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if ts.box:
        box = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(box).rounded_rectangle(
            (margin, margin, W - margin - 1, H - margin - 1),
            radius=min(ts.radius, (H - 2 * margin) // 2), fill=_rgba(ts.box_color, ts.box_opacity))
        img = Image.alpha_composite(img, box)
    # centre this caption's ink in the box
    y = round(H / 2 - (ink_top + ink_bottom) / 2)

    if ts.shadow:
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        for px, w in placed:
            sd.text((px, y + ts.shadow // 3), w, font=font, fill=(0, 0, 0, 200),
                    direction=direction, stroke_width=ts.outline, stroke_fill=(0, 0, 0, 200))
        img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(ts.shadow)))

    draw = ImageDraw.Draw(img)
    for k, (px, w) in enumerate(placed):
        color = ts.highlight if (ts.highlight and k == active) else ts.color
        draw.text((px, y), w, font=font, fill=_rgba(color), direction=direction,
                  stroke_width=ts.outline, stroke_fill=_rgba(ts.outline_color))
    return np.asarray(img)


def sub_style(ts: TextStyle) -> TextStyle:
    """The second caption line (a translation under the original): smaller,
    longer lines, no word highlight."""
    return replace(ts, size=max(30, int(ts.size * 0.6)), max_words=7, max_chars=42, max_seconds=0,
                   highlight=None, pad_x=max(10, int(ts.pad_x * 0.8)), pad_y=max(6, int(ts.pad_y * 0.7)))


def _windows(chunks: list[list[Word]]) -> tuple[list[float], list[float]]:
    """When each chunk shows: held until the next one if the gap is short."""
    starts, ends = [c[0][1] for c in chunks], []
    for i, c in enumerate(chunks):
        end = c[-1][2]
        if i + 1 < len(chunks) and chunks[i + 1][0][1] - end < 0.3:
            end = chunks[i + 1][0][1]
        ends.append(end)
    return starts, ends


class Overlay:
    """Per-frame caption + title compositor for a 1080x1920 BGR frame."""

    def __init__(self, chunks: list[list[Word]], style: Style, title: str | None,
                 tags: list[tuple[float, float, str]] | None = None, sub: list[list[Word]] | None = None):
        """tags: (start, end, text) shown small above the captions, e.g. the
        surah and ayah while a Quran verse is quoted. sub: a second caption
        line under the first (a translation), in sub_style."""
        self.chunks = chunks
        self.style = style
        self.tags = tags or []
        self.starts, self.ends = _windows(chunks)
        self.sub = sub or []
        self.sub_style = sub_style(style.captions)
        self.sub_starts, self.sub_ends = _windows(self.sub)
        self.title = render_text(tuple(title.split()), style.title) if title else None
        self._cache: dict = {}

    def _line(self, name, chunks, starts, ends, ts: TextStyle, t: float):
        for i, (s, e) in enumerate(zip(starts, ends)):
            if s <= t < e:
                c = chunks[i]
                active = max((k for k, w in enumerate(c) if w[1] <= t), default=0)
                key = (name, i, active if ts.highlight else -1)
                if key not in self._cache:
                    self._cache[key] = render_text(tuple(w[0] for w in c), ts, key[2])
                fade = ts.fade_ms / 1000
                return self._cache[key], min(1.0, (t - s) / fade) if fade else 1.0
        return None, 0.0

    def _caption(self, t: float):
        return self._line("cap", self.chunks, self.starts, self.ends, self.style.captions, t)

    def _sub_offset(self) -> float:
        """Pixels from the caption's centre down to the second line's centre."""
        if "sub_off" not in self._cache:
            cap_h = render_text(("كلمة",), self.style.captions).shape[0]
            sub_h = render_text(("Word",), self.sub_style).shape[0]
            self._cache["sub_off"] = cap_h / 2 + sub_h / 2 + 8
        return self._cache["sub_off"]

    @staticmethod
    def _blit(frame: np.ndarray, rgba: np.ndarray, cy: float, alpha: float) -> None:
        h, w = rgba.shape[:2]
        H, W = frame.shape[:2]
        x0, y0 = (W - w) // 2, int(cy * H - h / 2)
        x1, y1 = min(W, x0 + w), min(H, y0 + h)
        sx, sy = max(0, -x0), max(0, -y0)
        x0, y0 = max(0, x0), max(0, y0)
        src = rgba[sy:sy + y1 - y0, sx:sx + x1 - x0]
        a = src[..., 3:4].astype(np.float32) / 255 * alpha
        roi = frame[y0:y1, x0:x1]
        bgr = src[..., 2::-1].astype(np.float32)
        roi[:] = (roi * (1 - a) + bgr * a).astype(np.uint8)

    def _tag(self, t: float):
        for k, (s, e, text) in enumerate(self.tags):
            if s - TAG_FADE <= t < e + TAG_FADE:
                key = ("tag", k)
                if key not in self._cache:
                    cap = self.style.captions
                    ts = replace(TAG_STYLE, font=cap.font, size=max(26, int(cap.size * 0.5)))
                    img = render_text(tuple(text.split()), ts)
                    # just above the caption box (its height from a typical line)
                    cap_h = render_text(("كلمة",), cap).shape[0]
                    self._cache[key] = (img, cap_h / 2 + img.shape[0] / 2 + 6)
                img, above = self._cache[key]
                alpha = min(1.0, (t - (s - TAG_FADE)) / TAG_FADE, ((e + TAG_FADE) - t) / TAG_FADE)
                return img, above, max(0.0, alpha)
        return None, 0.0, 0.0

    def apply(self, frame: np.ndarray, t: float) -> None:
        if self.title is not None:
            self._blit(frame, self.title, self.style.title.y, 1.0)
        tag, above, ta = self._tag(t)
        if tag is not None:
            self._blit(frame, tag, self.style.captions.y - above / frame.shape[0], ta)
        img, alpha = self._caption(t)
        if img is not None:
            self._blit(frame, img, self.style.captions.y, alpha)
        if self.sub:
            img, alpha = self._line("sub", self.sub, self.sub_starts, self.sub_ends, self.sub_style, t)
            if img is not None:
                self._blit(frame, img, self.style.captions.y + self._sub_offset() / frame.shape[0], alpha)
