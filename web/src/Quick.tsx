import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Range, type TextStyle, type Transcript, type Translation, type Word } from "./api";
import type { Ed } from "./Editor";
import { effectiveCaption } from "./panels";
import { VolumeControl } from "./Volume";
import { clamp, fmt } from "./util";

/**
 * In-browser preview of the cut: plays only the kept segments, cropped to 9:16
 * around the speaker, with captions drawn on top. Two <video> elements take
 * turns so each cut can crossfade without waiting for a seek. It updates the
 * moment a setting changes; morphs are shown as fades (use "Render exactly"
 * to see the real transition).
 */

export type Track = [number, number, number, number?, (number | null)?][];
const tracks = new Map<string, Promise<Track>>();
export const trackFor = (id: string, fresh = false) => {
  if (fresh || !tracks.has(id)) tracks.set(id, api.speaker(id).catch(() => []));
  return tracks.get(id)!;
};

/** The camera's own zoom at time t (nearest analysed sample), if it has one. */
export function zoomAt(track: Track, t: number): number | null {
  if (!track.length) return null;
  let best = track[0];
  for (const p of track) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  return best[4] ?? null;
}

/** Framing at time t: within one camera interpolate, across a camera change hold. */
export function at(track: Track, t: number): [number, number] {
  if (!track.length) return [0.5, 0.36];
  let lo = 0, hi = track.length - 1;
  if (t <= track[0][0]) return [track[0][1], track[0][2]];
  if (t >= track[hi][0]) return [track[hi][1], track[hi][2]];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m][0] <= t) lo = m; else hi = m; }
  const [t0, x0, y0, c0] = track[lo], [t1, x1, y1, c1] = track[hi];
  if (c0 !== c1) return t - t0 < t1 - t ? [x0, y0] : [x1, y1];
  const f = (t - t0) / (t1 - t0 || 1);
  return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
}

/** Translated sentences as caption words: each sentence's words share its
 * time span by length (same as the server's translate.timed_words). */
function translatedWords(tr: Transcript, t: Translation): Word[] {
  const out: Word[] = [];
  tr.segments.forEach((g, k) => {
    const toks = (t.segments[k]?.text ?? "").split(/\s+/).filter(Boolean);
    const total = toks.reduce((a, w) => a + w.length + 1, 0);
    let at = g.s;
    for (const w of toks) {
      const dur = ((g.e - g.s) * (w.length + 1)) / total;
      out.push({ w, s: at, e: at + dur * 0.95 });
      at += dur;
    }
  });
  return out;
}

function chunks(words: Word[], ranges: Range[], ts: TextStyle): Word[][] {
  const inside = words.filter((w) => ranges.some(([a, b]) => w.e > a && w.s < b));
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of inside) {
    const text = [...cur, w].map((x) => x.w).join(" ");
    if (cur.length && (cur.length >= ts.max_words || text.length > ts.max_chars || w.s - cur[cur.length - 1].e > 0.3)) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

const rtl = (s: string) => /[֐-ࣿיִ-ﻼ]/.test(s);

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const SURAH_EN = ("Al-Fatihah Al-Baqarah Aal_Imran An-Nisa Al-Ma'idah Al-An'am Al-A'raf Al-Anfal At-Tawbah Yunus Hud Yusuf " +
  "Ar-Ra'd Ibrahim Al-Hijr An-Nahl Al-Isra Al-Kahf Maryam Ta-Ha Al-Anbiya Al-Hajj Al-Mu'minun An-Nur Al-Furqan " +
  "Ash-Shu'ara An-Naml Al-Qasas Al-Ankabut Ar-Rum Luqman As-Sajdah Al-Ahzab Saba Fatir Ya-Sin As-Saffat Sad " +
  "Az-Zumar Ghafir Fussilat Ash-Shura Az-Zukhruf Ad-Dukhan Al-Jathiyah Al-Ahqaf Muhammad Al-Fath Al-Hujurat " +
  "Qaf Adh-Dhariyat At-Tur An-Najm Al-Qamar Ar-Rahman Al-Waqi'ah Al-Hadid Al-Mujadilah Al-Hashr Al-Mumtahanah " +
  "As-Saff Al-Jumu'ah Al-Munafiqun At-Taghabun At-Talaq At-Tahrim Al-Mulk Al-Qalam Al-Haqqah Al-Ma'arij Nuh " +
  "Al-Jinn Al-Muzzammil Al-Muddaththir Al-Qiyamah Al-Insan Al-Mursalat An-Naba An-Nazi'at Abasa At-Takwir " +
  "Al-Infitar Al-Mutaffifin Al-Inshiqaq Al-Buruj At-Tariq Al-A'la Al-Ghashiyah Al-Fajr Al-Balad Ash-Shams " +
  "Al-Layl Ad-Duha Ash-Sharh At-Tin Al-Alaq Al-Qadr Al-Bayyinah Az-Zalzalah Al-Adiyat Al-Qari'ah At-Takathur " +
  "Al-Asr Al-Humazah Al-Fil Quraysh Al-Ma'un Al-Kawthar Al-Kafirun An-Nasr Al-Masad Al-Ikhlas Al-Falaq An-Nas").split(" ");

/** Same text as the render's tag (shorts/sources.py quran_label). */
function quranLabel(ref: string, lang: string): string {
  if (ref.startsWith("~")) return lang === "ar" ? "من القرآن الكريم" : "Quran";  // fits several places
  const cut = ref.lastIndexOf(" ");
  const name = ref.slice(0, cut), num = ref.slice(cut + 1);
  const [surah, ayat = ""] = num.split(":");
  if (lang !== "ar") {
    const en = SURAH_EN[+surah - 1];
    return en ? `Quran · ${en.replace("_", " ")} ${num}` : `Quran ${num}`;
  }
  const digits = ayat.replace(/[0-9]/g, (d) => AR_DIGITS[+d]);
  return `سورة ${name}، ${ayat.includes("–") ? "الآيات" : "الآية"} ${digits}`;
}

function textCss(ts: TextStyle, k: number): React.CSSProperties {
  const [family, rest = ""] = ts.font.split(":");
  const hex = ts.box_color.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
  return {
    top: `${ts.y * 100}%`,
    fontFamily: `"${family}", "Noto Sans Arabic", sans-serif`,
    fontWeight: /bold/i.test(rest) ? 700 : 400,
    fontSize: ts.size * k,
    color: ts.color,
    background: ts.box ? `rgba(${rgb},${ts.box_opacity})` : "transparent",
    borderRadius: ts.radius * k,
    padding: `${ts.pad_y * k}px ${ts.pad_x * k}px`,
    WebkitTextStroke: ts.outline ? `${ts.outline * k * 2}px ${ts.outline_color}` : undefined,
    paintOrder: "stroke fill",
    textShadow: ts.shadow ? `0 ${ts.shadow * k * 0.3}px ${ts.shadow * k}px rgba(0,0,0,0.85)` : undefined,
  };
}

export function QuickPlayer({ ed, width }: { ed: Ed; width: number }) {
  const s = ed.short!;
  const height = Math.round((width * 16) / 9);
  const segs = useMemo(() => ed.estimate?.segments ?? [], [ed.estimate]);
  const fps = ed.lecture.fps || 25;
  const fade = s.transition === "cut" ? 0 : s.transition_frames / fps;
  // preview speed: follows the export speed unless picked here (watching only)
  const [rateChoice, setRateChoice] = useState<number | null>(null);
  const rate = rateChoice ?? (s.speed ?? 1);
  const W = ed.lecture.width ?? 1920, H = ed.lecture.height ?? 1080;

  const v0 = useRef<HTMLVideoElement>(null), v1 = useRef<HTMLVideoElement>(null);
  const run = useRef({ k: 0, active: 0, fadeStart: null as number | null, started: false });
  const [track, setTrack] = useState<Track>([]);
  const [playing, setPlaying] = useState(false);
  const [outT, setOutT] = useState(0);
  const [srcT, setSrcT] = useState(segs[0]?.[0] ?? 0);
  const [cut, setCut] = useState(0);
  const [exact, setExact] = useState<string | null>(null);
  const [exactBusy, setExactBusy] = useState(false);

  useEffect(() => { trackFor(ed.lecture.id, ed.framingVersion > 0).then(setTrack); }, [ed.lecture.id, ed.framingVersion]);

  const total = segs.reduce((acc, [a, b]) => acc + (b - a), 0) - fade * Math.max(0, segs.length - 1);
  const capStyle = effectiveCaption(ed);
  const titleStyle = effectiveCaption(ed, "title");
  const capChunks = useMemo(() => {
    if (!capStyle || !ed.transcript || !s.captions) return [];
    const lang = s.caption_lang ?? "original";
    if (lang !== "original") return ed.translation?.lang === lang ? chunks(translatedWords(ed.transcript, ed.translation), s.ranges, capStyle) : [];
    const h = s.harakat ?? "all";
    const strip = (t: string) => t.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "");
    const words = h === "all" ? ed.transcript.words
      : ed.transcript.words.map((w) => (h === "quran" && w.quran ? w : { ...w, w: strip(w.w) }));
    return chunks(words, s.ranges, capStyle);
  }, [ed.transcript, ed.translation, s.ranges, s.captions, s.harakat, s.caption_lang, capStyle?.max_words, capStyle?.max_chars]); // eslint-disable-line react-hooks/exhaustive-deps

  const place = (v: HTMLVideoElement | null) => {
    if (!v) return;
    const z = zoomAt(track, v.currentTime) ?? s.zoom;
    const scale = (height * z) / H;
    const vw = W * scale, vh = H * scale;
    const [x, y] = at(track, v.currentTime);
    const left = clamp(width / 2 - x * vw, width - vw, 0);
    // zoomed out (< 1x): the picture is shorter than the phone screen, centre it
    const top = vh < height ? (height - vh) / 2 : clamp(height * 0.36 - y * vh, height - vh, 0);
    v.style.width = `${vw}px`;
    v.style.height = `${vh}px`;
    v.style.transform = `translate(${left}px, ${top}px)`;
  };
  const vids = () => [v0.current!, v1.current!];

  const reset = () => {
    const [a, b] = vids();
    if (!a || !b) return;
    a.pause(); b.pause();
    run.current = { k: 0, active: 0, fadeStart: null, started: false };
    a.style.opacity = "1"; b.style.opacity = "0";
    if (segs.length) {
      a.currentTime = segs[0][0];
      if (segs[1]) b.currentTime = segs[1][0];
      setSrcT(segs[0][0]);
    }
    setPlaying(false);
    setOutT(0);
  };
  // any change to the cut restarts the preview
  useEffect(() => { reset(); setExact(null); setCut(0); }, [JSON.stringify(segs), fade]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { vids().forEach(place); }, [track, s.zoom, width]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { vids().forEach((v) => { if (v) { v.playbackRate = rate; v.preservesPitch = true; } }); }, [rate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    let raf = 0, lastUi = 0;
    const tick = (now: number) => {
      const r = run.current;
      const [A, B] = r.active === 0 ? vids() : vids().reverse();
      place(A); place(B);
      const t = A.currentTime;
      const n = segs.length;
      if (r.fadeStart == null) {
        if (r.k < n - 1 && t >= segs[r.k][1] - fade && B.readyState >= 2) {
          B.play();
          r.fadeStart = now;
        } else if (r.k === n - 1 && t >= segs[r.k][1]) {
          A.pause();
          setPlaying(false);
          r.started = false;
          return;
        }
      }
      if (r.fadeStart != null) {
        const e = fade ? Math.min(1, (now - r.fadeStart) / 1000 / (fade / rate)) : 1;
        B.style.opacity = String(e);
        A.style.opacity = String(1 - e);
        B.volume = e; A.volume = 1 - e;
        if (e >= 1) {
          A.pause();
          r.active = 1 - r.active;
          r.k += 1;
          r.fadeStart = null;
          setCut(r.k - 1);
          if (segs[r.k + 1]) A.currentTime = segs[r.k + 1][0];
        }
      }
      if (now - lastUi > 80) {
        lastUi = now;
        const cur = (r.active === 0 ? v0 : v1).current!;
        let o = 0;
        for (let j = 0; j < r.k; j++) o += segs[j][1] - segs[j][0] - fade;
        setOutT(o + (cur.currentTime - segs[r.k][0]));
        setSrcT(cur.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, segs, fade]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Jump to a time in the short (output time), mid-play or paused. */
  const seekOut = (target: number) => {
    const [a, b] = vids();
    if (!a || !b || !segs.length) return;
    target = clamp(target, 0, Math.max(0, total - 0.05));
    let k = 0, o = 0;
    while (k < segs.length - 1 && target >= o + (segs[k][1] - segs[k][0] - fade)) {
      o += segs[k][1] - segs[k][0] - fade;
      k += 1;
    }
    const wasPlaying = playing;
    a.pause(); b.pause();
    run.current = { k, active: 0, fadeStart: null, started: true };
    a.style.opacity = "1"; b.style.opacity = "0";
    a.volume = 1;
    a.currentTime = segs[k][0] + (target - o);
    if (segs[k + 1]) b.currentTime = segs[k + 1][0];
    setCut(Math.max(0, k - 1));
    setOutT(target);
    setSrcT(a.currentTime);
    if (wasPlaying) a.play().catch(() => {});
  };

  const toggle = () => {
    if (playing) { vids().forEach((v) => v.pause()); setPlaying(false); return; }
    if (!run.current.started) { reset(); run.current.started = true; }
    (run.current.active === 0 ? v0 : v1).current!.play().then(() => setPlaying(true)).catch(() => {});
  };

  const renderExact = async () => {
    if (segs.length < 2) return;
    const j = clamp(cut, 0, segs.length - 2);
    setExactBusy(true);
    vids().forEach((v) => v.pause());
    setPlaying(false);
    try {
      const { id: _i, lecture_id: _l, created: _c, rendered: _r, job: _j, last_render: _lr, ...settings } = s;
      void _i; void _l; void _c; void _r; void _j; void _lr;
      const url = await api.previewCut(ed.lecture.id, settings, [segs[j][1], segs[j + 1][0]]);
      setExact((old) => { if (old) URL.revokeObjectURL(old); return url; });
    } finally {
      setExactBusy(false);
    }
  };

  // captions at the current source time
  const chunkIdx = capChunks.findIndex((c, i) => c[0].s <= srcT && srcT < (capChunks[i + 1]?.[0].s ?? Infinity) && srcT < c[c.length - 1].e + 0.3);
  const chunk = chunkIdx >= 0 ? capChunks[chunkIdx] : null;
  const k = width / 1080;
  // surah/ayah tag while a Quran verse is quoted (as in the render)
  const qSpan = s.quran_tag === false || !ed.transcript ? null : (ed.transcript.sources ?? []).find((sp) => {
    if (sp.type !== "quran" || !sp.ref) return false;
    const ws = ed.transcript!.words;
    return ws[sp.w0].s - 0.25 <= srcT && srcT < ws[sp.w1 - 1].e + 0.25;
  }) ?? null;
  const tagLang = (s.caption_lang ?? "original") === "original" ? "ar" : s.caption_lang!;

  if (!segs.length) return <div className="phone-frame" style={{ width, height }}><div className="ph">Add a clip to preview the cut</div></div>;

  return (
    <div className="quick">
      <div className="phone-frame quick-frame" style={{ width, height }} onClick={toggle}>
        <video ref={v0} src={api.videoUrl(ed.lecture.id)} preload="auto" playsInline onLoadedMetadata={(e) => { place(e.currentTarget); e.currentTarget.playbackRate = rate; }} />
        <video ref={v1} src={api.videoUrl(ed.lecture.id)} preload="auto" playsInline style={{ opacity: 0 }} onLoadedMetadata={(e) => { place(e.currentTarget); e.currentTarget.playbackRate = rate; }} />
        {chunk && capStyle && (
          <div className="q-cap" dir={rtl(chunk[0].w) ? "rtl" : "ltr"} style={textCss(capStyle, k)}>
            {chunk.map((w, i) => (
              <span key={i} style={capStyle.highlight && w.s <= srcT && (chunk[i + 1]?.s ?? Infinity) > srcT ? { color: capStyle.highlight } : undefined}>
                {w.w}{i < chunk.length - 1 ? " " : ""}
              </span>
            ))}
          </div>
        )}
        {qSpan && capStyle && (
          <div className="q-cap q-tag" dir={tagLang === "ar" ? "rtl" : "ltr"} style={{
            top: `calc(${capStyle.y * 100}% - ${(capStyle.size * 0.95 + capStyle.pad_y + 30) * k}px)`,
            fontFamily: `"${capStyle.font.split(":")[0]}", "Noto Sans Arabic", sans-serif`,
            fontSize: Math.max(26, capStyle.size * 0.5) * k,
          }}>{quranLabel(qSpan.ref!, tagLang)}</div>
        )}
        {s.title && titleStyle && <div className="q-cap" dir="auto" style={textCss(titleStyle, k)}>{s.title}</div>}
        {!playing && <div className="q-play" aria-hidden="true">▶</div>}
        {exact && (
          <div className="q-exact">
            <video src={exact} autoPlay loop playsInline muted={false} />
            <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); setExact(null); }}>Close exact view</button>
          </div>
        )}
      </div>
      <input className="q-scrub" type="range" min={0} max={Math.max(0.1, total)} step={0.04} value={Math.min(outT, total)}
        aria-label="Position in the short" onChange={(e) => seekOut(+e.target.value)} />
      <div className="q-bar">
        <button type="button" className="icon" aria-label="Restart" onClick={reset}>⏮</button>
        <button type="button" className="btn small" aria-label="Back 5 seconds" onClick={() => seekOut(outT - 5)}>−5s</button>
        <button type="button" className="btn small" onClick={toggle}>{playing ? "Pause" : run.current.started ? "Resume" : "Play cut"}</button>
        <button type="button" className="btn small" aria-label="Forward 5 seconds" onClick={() => seekOut(outT + 5)}>+5s</button>
        <span className="tc small">{fmt(outT, 1)} / {fmt(total, 1)}</span>
      </div>
      <VolumeControl getMedia={() => [v0.current, v1.current]} />
      <SpeedPicker value={rate} onChange={(r) => setRateChoice(r === (s.speed ?? 1) ? null : r)}
        note={rateChoice == null && (s.speed ?? 1) !== 1 ? "export speed" : rateChoice != null ? "preview only" : undefined} />
      {segs.length > 1 && (
        <div className="q-exact-row">
          <label className="small" htmlFor="cutpick" title="The instant preview only approximates morph cuts. Pick a pause that was cut out and render just that moment exactly as the export will look.">Check a cut exactly</label>
          <select id="cutpick" title="Each cut is a pause removed from your clip: its number, where it is in the short, and how long the removed pause was" value={clamp(cut, 0, segs.length - 2)} onChange={(e) => setCut(+e.target.value)}>
            {segs.slice(0, -1).map((g, j) => (
              <option key={j} value={j}>Cut {j + 1} · {fmt(g[1], 1)} ({(segs[j + 1][0] - g[1] + fade).toFixed(1)}s pause)</option>
            ))}
          </select>
          <button type="button" className="btn small" disabled={exactBusy} onClick={renderExact}>
            {exactBusy ? "Rendering…" : "Render this cut exactly"}
          </button>
        </div>
      )}
      <p className="muted small q-note">Instant preview: {s.transition === "morph" ? "morphs show as fades here" : s.transition === "fade" ? "fades as rendered" : "jump cuts as rendered"}; framing is approximate.</p>
    </div>
  );
}

export function SpeedPicker({ value, onChange, note }: { value: number; onChange: (r: number) => void; note?: string }) {
  return (
    <div className="speed-pick" role="group" aria-label="Playback speed">
      {[1, 1.25, 1.5, 2].map((r) => (
        <button key={r} type="button" aria-pressed={Math.abs(value - r) < 0.01} onClick={() => onChange(r)}>{r}×</button>
      ))}
      {![1, 1.25, 1.5, 2].some((r) => Math.abs(value - r) < 0.01) && <span className="small">{value.toFixed(2)}×</span>}
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}
