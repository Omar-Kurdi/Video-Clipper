import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Range, type Word } from "./api";
import { Confirm } from "./Confirm";
import { TopBar, type Ed } from "./Editor";
import { CaptionsPanel, ClipStrip, ExportPanel, FramingPanel, PausesPanel, Preview, Stats, cropWidth, sortedCameras, summary, type Section } from "./panels";
import { VolumeControl } from "./Volume";
import { SpeedPicker, at, trackFor, type Track } from "./Quick";
import { Timeline } from "./Timeline";
import { clamp, fmt, normalize } from "./util";

const SECTIONS: Section[] = ["pauses", "look", "framing", "export"];
const SECTION_NAME: Record<Section, string> = { pauses: "Pauses", look: "Captions & look", framing: "Framing", export: "Export" };
const SECTION_KEY = "settings-section";

function storedSection(): Section | null {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    return v === "" ? null : SECTIONS.includes(v as Section) ? (v as Section) : "look";
  } catch { return "look"; }
}

/** Preview width that leaves room for the settings under it on short screens. */
function usePreviewWidth() {
  const calc = () => Math.round(Math.min(200, Math.max(140, ((window.innerHeight - 520) * 9) / 16)));
  const [w, setW] = useState(calc);
  useEffect(() => {
    const on = () => setW(calc());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/**
 * The editor, input to output from left to right: transcript (read, search,
 * select, edit), the video, then preview and settings. The timeline runs under
 * the transcript and video. One selection, in seconds, is shared by the
 * transcript and the timeline.
 */
export function Workspace({ ed }: { ed: Ed }) {
  const video = useRef<HTMLVideoElement>(null);
  const duration = ed.lecture.duration ?? 0;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Range | null>(null);
  const [view, setView] = useState<Range>([0, Math.min(duration || 120, 120)]);
  const [open, setOpenState] = useState<Section | null>(storedSection);
  const setOpen = (v: Section | null) => {
    setOpenState(v);
    try { localStorage.setItem(SECTION_KEY, v ?? ""); } catch { /* storage unavailable */ }
  };
  const previewWidth = usePreviewWidth();
  const [rate, setRate] = useState(1);
  useEffect(() => { if (video.current) { video.current.playbackRate = rate; video.current.preservesPitch = true; } }, [rate]);
  const stopAt = useRef<number | null>(null);

  // ----- playback -----
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        setTime(v.currentTime);
        if (stopAt.current != null && v.currentTime >= stopAt.current) {
          v.pause();
          stopAt.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const show = useCallback((a: number, b: number) => {
    const [a0, b0] = viewRef.current;
    const span = b0 - a0;
    if (a < a0 || b > b0) {
      const ns = Math.max(span, Math.min(duration, (b - a) * 1.2));
      const na = clamp(a - (ns - (b - a)) / 2, 0, Math.max(0, duration - ns));
      setView([na, na + ns]);
    }
  }, [duration]);
  // keep the playhead in view when it moves, without fighting manual scrolling
  useEffect(() => { show(time, time); }, [time, show]);

  // One seek at a time: while the video is still decoding a frame, only the
  // latest target waits (scrubbing would otherwise queue up a backlog of seeks).
  const pendingSeek = useRef<number | null>(null);
  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v) return;
    t = clamp(t, 0, duration);
    setTime(t);
    if (v.seeking) { pendingSeek.current = t; return; }
    v.currentTime = t;
  }, [duration]);
  const onSeeked = () => {
    const v = video.current;
    if (!v) return;
    if (pendingSeek.current != null) { v.currentTime = pendingSeek.current; pendingSeek.current = null; }
    else setTime(v.currentTime);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) { stopAt.current = null; v.play(); } else v.pause();
  };
  const playRange = (r: Range) => {
    seek(r[0]);
    stopAt.current = r[1];
    video.current?.play();
  };
  const select = (r: Range | null) => {
    setSel(r);
    if (r) show(r[0], r[1]);
  };
  const markIn = () => select([time, sel && sel[1] > time ? sel[1] : Math.min(duration, time + 15)]);
  const markOut = () => select([sel && sel[0] < time ? sel[0] : Math.max(0, time - 15), time]);
  const add = () => {
    if (!sel || sel[1] - sel[0] < 0.5) return;
    ed.addRange(sel);
    setSel(null);
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === " ") { e.preventDefault(); toggle(); }
      else if (e.key === "i" || e.key === "I") markIn();
      else if (e.key === "o" || e.key === "O") markOut();
      else if (e.key === "Enter") add();
      else if (e.key === "ArrowLeft") seek(time - (e.shiftKey ? 5 : 1));
      else if (e.key === "ArrowRight") seek(time + (e.shiftKey ? 5 : 1));
      else if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  // ----- 9:16 frame on the video -----
  const s = ed.short;
  const [track, setTrack] = useState<Track>([]);
  useEffect(() => { trackFor(ed.lecture.id, ed.framingVersion > 0).then(setTrack); }, [ed.lecture.id, ed.framingVersion]);
  const [guideDrag, setGuideDragState] = useState<number | null>(null);
  const guideRef = useRef<number | null>(null);
  const setGuideDrag = (v: number | null) => { guideRef.current = v; setGuideDragState(v); };
  // While paused, ask the server which angle is on screen and how the render
  // frames it (exact). While playing, use the analysed samples (approximate).
  const [exact, setExact] = useState<{ t: number; camera: number | null; mode: string; x: number; zoom: number | null } | null>(null);
  useEffect(() => {
    if (playing) return;
    const t = time;
    const id = setTimeout(() => {
      api.framingAt(ed.lecture.id, t).then((r) => setExact({ t, ...r })).catch(() => {});
    }, 200);
    return () => clearTimeout(id);
  }, [time, playing, ed.lecture.id, ed.framingVersion]);
  const useExact = !playing && exact && Math.abs(exact.t - time) < 0.05;
  const near = track.length ? track.reduce((b, p) => (Math.abs(p[0] - time) < Math.abs(b[0] - time) ? p : b)) : null;
  const camId = useExact ? exact!.camera : near?.[3];
  const cam = ed.cameras?.cameras.find((c) => c.id === camId) ?? null;
  const cw = Math.min(1, cropWidth(ed, cam?.zoom ?? s?.zoom ?? 1));
  const fx = guideDrag ?? (useExact ? exact!.x : track.length ? at(track, time)[0] : 0.5);
  const guideLeft = Math.min(1 - cw, Math.max(0, fx - cw / 2)) * 100;
  const camIndex = cam ? sortedCameras(ed).findIndex((c) => c.id === cam.id) : -1;
  const how = (useExact ? exact!.mode : cam?.manual ? "manual" : "lecturer");
  const guideLabel = cam
    ? `${camIndex >= 0 ? `Camera ${camIndex + 1}${cam.count < 2 ? " (one-off)" : ""}` : "9:16 frame"} · ${how === "manual" ? "your framing" : how === "lecturer" ? "on the speaker" : how === "camera" ? "usual position" : "centred"}${playing ? "" : " · drag to adjust"}`
    : "9:16 frame";
  const guideX = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    return Math.min(1 - cw / 2, Math.max(cw / 2, (e.clientX - r.left) / r.width));
  };

  const span = view[1] - view[0];
  const zoomTo = (ns: number) => {
    ns = clamp(ns, 5, duration);
    const c = clamp(time, view[0], view[1]);
    const a = clamp(c - (c - view[0]) * (ns / span), 0, Math.max(0, duration - ns));
    setView([a, a + ns]);
  };

  return (
    <div className="app ws">
      <TopBar ed={ed} />
      <div className="ws-grid">
        <TranscriptPanel ed={ed} time={time} playing={playing} sel={sel} onSelect={select} seek={seek}
          play={() => video.current?.play()} />

        <section className="source" aria-label="Video">
          <div className="player" style={{
            // exactly the video's shape, so the 9:16 frame lines up with the picture
            aspectRatio: `${ed.lecture.width ?? 16} / ${ed.lecture.height ?? 9}`,
            width: `min(100%, calc((100vh - 460px) * ${(ed.lecture.width ?? 16) / (ed.lecture.height ?? 9)}))`,
          }}>
            <video ref={video} src={api.videoUrl(ed.lecture.id)} poster={api.thumbUrl(ed.lecture.id)} preload="auto" playsInline
              onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); setTime(video.current?.currentTime ?? 0); }}
              onSeeked={onSeeked} onClick={toggle} />
            <div className={`crop-guide ${cam ? "draggable" : ""} ${cam?.manual ? "manual" : ""}`}
              style={{ width: `${cw * 100}%`, left: `${guideLeft}%` }}
              onPointerDown={(e) => {
                if (!cam) return;
                e.stopPropagation();
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
                setGuideDrag(guideX(e));
              }}
              onPointerMove={(e) => guideRef.current != null && setGuideDrag(guideX(e))}
              onPointerUp={(e) => {
                if (guideRef.current == null || !cam) return;
                const x = guideX(e);
                // set the angle on screen now, mapped onto its reference frame by the server
                ed.setFramingAt(video.current?.currentTime ?? time, Math.round(x * 1000) / 1000);
                setGuideDrag(null);
              }}>
              <span>{guideLabel}</span>
            </div>
          </div>
          <div className="transport">
            <button type="button" className="round" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
              {playing ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>}
            </button>
            <span className="tc now-tc">{fmt(time, 2)}</span>
            <span className="tc dim small">/ {fmt(duration, 0)}</span>
            <button type="button" className="btn small" onClick={() => seek(time - 5)} aria-label="Back 5 seconds">−5s</button>
            <button type="button" className="btn small" onClick={() => seek(time + 5)} aria-label="Forward 5 seconds">+5s</button>
            <SpeedPicker value={rate} onChange={setRate} />
            <VolumeControl getMedia={() => [video.current]} />
            <span className="grow" />
            <button type="button" className="btn small" title="Mark in (I): start the selection here" onClick={markIn}><kbd>I</kbd> In</button>
            <button type="button" className="btn small" title="Mark out (O): end the selection here" onClick={markOut}><kbd>O</kbd> Out</button>
          </div>
        </section>

        <section className="tl" aria-label="Timeline">
          <div className="tl-head">
            <b title="Drag to select · click to seek · drag along the times at the top to scrub · scroll to move · Ctrl+scroll to zoom">Timeline</b>
            {/* always here, so selecting never moves the layout */}
            <div className={`sel-slot ${sel ? "on" : ""}`} role="toolbar" aria-label="Selection">
              <span className="tc sel-time">{sel ? `${fmt(sel[0], 1)} – ${fmt(sel[1], 1)} · ${(sel[1] - sel[0]).toFixed(1)} s` : "Nothing selected"}</span>
              <button type="button" className="btn small" disabled={!sel} onClick={() => sel && playRange(sel)}>Play</button>
              <button type="button" className="btn small accent" disabled={!sel} onClick={add}>Add to {s?.name ?? "short"} <kbd>↵</kbd></button>
              <button type="button" className="btn small" disabled={!sel} onClick={() => { if (sel) { ed.newShort([sel]); setSel(null); } }}>New short</button>
              <button type="button" className="icon" aria-label="Clear selection" disabled={!sel} onClick={() => setSel(null)}>✕</button>
            </div>
            <span className="grow" />
            <span className="legend"><i className="lg-sel" />In {s?.name ?? "the short"}</span>
            <span className="legend"><i className="lg-new" />Selection</span>
            <span className="legend"><i className="lg-pause" />Pause, cut</span>
            <button type="button" className="btn small sq" aria-label="Zoom out" onClick={() => zoomTo(span * 1.6)}>−</button>
            <button type="button" className="btn small sq" aria-label="Zoom in" onClick={() => zoomTo(span / 1.6)}>+</button>
          </div>
          <Timeline duration={duration} peaks={ed.waveform} speech={ed.speech} minGap={s?.min_gap ?? 0.4}
            ranges={s?.ranges ?? []} selection={sel} time={time} view={view} onView={setView}
            onSeek={seek} onSelect={setSel} />
          <ClipStrip ed={ed} onPlay={playRange} />
        </section>

        <aside className="side" aria-label="Preview and settings">
          <div className="side-head">
            <Preview ed={ed} t={time} width={previewWidth} />
            <Stats ed={ed} />
          </div>
          <div className="side-body">
            {SECTIONS.map((sec) => (
              <section key={sec} className={`acc ${open === sec ? "open" : ""}`}>
                <h3>
                  <button type="button" aria-expanded={open === sec} aria-controls={`acc-${sec}`} onClick={() => setOpen(open === sec ? null : sec)}>
                    <span className="acc-name">{SECTION_NAME[sec]}</span>
                    <span className="acc-sum" dir="auto">{summary(ed, sec)}</span>
                  </button>
                </h3>
                <div id={`acc-${sec}`} role="region" aria-label={SECTION_NAME[sec]} hidden={open !== sec}>
                  {sec === "pauses" && <PausesPanel ed={ed} />}
                  {sec === "look" && <CaptionsPanel ed={ed} />}
                  {sec === "framing" && <FramingPanel ed={ed} />}
                  {sec === "export" && <ExportPanel ed={ed} />}
                </div>
              </section>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- transcript ---------------- */

function TranscriptPanel({ ed, time, playing, sel, onSelect, seek, play }: {
  ed: Ed; time: number; playing: boolean; sel: Range | null; onSelect: (r: Range | null) => void;
  seek: (t: number) => void; play: () => void;
}) {
  const tr = ed.transcript;
  const s = ed.short;
  const article = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const [follow, setFollow] = useState(true);
  const [showTr, setShowTr] = useState(true);
  const [showDoubt, setShowDoubt] = useState(true);
  const [editingTr, setEditingTr] = useState<number | null>(null);
  const [trDraft, setTrDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [fixing, setFixing] = useState<number | null>(null);

  const words = useMemo(() => tr?.words ?? [], [tr]);
  const wordSeg = useMemo(() => {
    const m = new Int32Array(words.length);
    tr?.segments.forEach((g, k) => { for (let i = g.w0; i < g.w1; i++) m[i] = k; });
    return m;
  }, [tr, words.length]);
  const segRange = (k: number): Range => {
    const g = tr!.segments[k];
    return [words[g.w0]?.s ?? g.s, words[g.w1 - 1]?.e ?? g.e];
  };
  const norm = useMemo(() => words.map((w) => normalize(w.w)), [words]);

  // search
  const hits = useMemo(() => {
    const toks = query.trim().split(/\s+/).map(normalize).filter(Boolean);
    if (!toks.length) return [] as [number, number][];
    const out: [number, number][] = [];
    for (let i = 0; i + toks.length <= norm.length; i++) {
      if (toks.every((t, k) => norm[i + k].includes(t))) out.push([i, i + toks.length - 1]);
    }
    return out;
  }, [query, norm]);
  const hitSet = useMemo(() => {
    const set = new Set<number>();
    for (const [a, b] of hits) for (let i = a; i <= b; i++) set.add(i);
    return set;
  }, [hits]);
  useEffect(() => setHitIdx(0), [query]);
  const jump = (k: number) => {
    if (!hits.length) return;
    const n = (k + hits.length) % hits.length;
    setHitIdx(n);
    article.current?.querySelector(`[data-i="${hits[n][0]}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    seek(words[hits[n][0]].s);
  };

  // spoken word (DOM class only, no re-render of the whole text)
  const nowIdx = useMemo(() => {
    let lo = 0, hi = words.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].s <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }, [time, words]);
  useEffect(() => {
    const root = article.current;
    if (!root) return;
    root.querySelector(".now")?.classList.remove("now");
    if (nowIdx < 0) return;
    const el = root.querySelector(`[data-i="${nowIdx}"]`);
    el?.classList.add("now");
    if (playing && follow && el) {
      const r = el.getBoundingClientRect(), b = root.getBoundingClientRect();
      if (r.top < b.top + 40 || r.bottom > b.bottom - 40) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [nowIdx, playing, follow]);

  // selection: click = sentence, shift+click = extend, drag = sentences touched
  const onMouseUp = (e: React.MouseEvent) => {
    if (!tr || editing != null) return;
    const target = e.target as HTMLElement;
    if (target.closest(".ts, .para-tools, .seg-edit, .word-fix")) return;
    const sx = window.getSelection();
    if (sx && !sx.isCollapsed && sx.rangeCount) {
      const inside = [...(article.current?.querySelectorAll("[data-i]") ?? [])].filter((el) => sx.containsNode(el, true));
      sx.removeAllRanges();
      if (!inside.length) return;
      const a = wordSeg[Number(inside[0].getAttribute("data-i"))];
      const b = wordSeg[Number(inside[inside.length - 1].getAttribute("data-i"))];
      onSelect([segRange(Math.min(a, b))[0], segRange(Math.max(a, b))[1]]);
      return;
    }
    const wEl = target.closest("[data-i]");
    const pEl = target.closest("[data-seg]");
    // a doubtful word: also offer the other readings
    const wi = wEl ? Number(wEl.getAttribute("data-i")) : null;
    setFixing(wi != null && showDoubt && words[wi]?.flag ? wi : null);
    const k = wEl ? wordSeg[Number(wEl.getAttribute("data-i"))] : pEl ? Number(pEl.getAttribute("data-seg")) : null;
    if (k == null) return;
    const r = segRange(k);
    if (e.shiftKey && sel) onSelect([Math.min(sel[0], r[0]), Math.max(sel[1], r[1])]);
    else { onSelect(r); seek(r[0]); }
  };

  // editing a sentence
  const startEdit = (k: number) => {
    const g = tr!.segments[k];
    setDraft(words.slice(g.w0, g.w1).map((w) => w.w).join(" "));
    setEditing(k);
  };
  const save = async (k: number, text: string | null) => {
    setSaving(true);
    try {
      await ed.editSegment(k, text);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const ranges = s?.ranges ?? [];
  const minGap = s?.min_gap ?? 0.4;
  // Quran / hadith marks: word index -> kind, and the span starting at a word
  const marks = useMemo(() => {
    const kind = new Map<number, "quran" | "hadith">();
    const starts = new Map<number, import("./api").Source>();
    for (const sp of tr?.sources ?? []) {
      for (let i = sp.w0; i < sp.w1; i++) kind.set(i, sp.type);
      starts.set(sp.w0, sp);
    }
    return { kind, starts };
  }, [tr]);
  const body = useMemo(() => {
    if (!tr) return null;
    const inShort = (t: number) => ranges.some(([a, b]) => t >= a && t <= b);
    const inSel = (t: number) => sel != null && t >= sel[0] && t <= sel[1];
    return tr.segments.map((seg, k) => {
      if (editing === k) {
        return (
          <div className="para editing" key={k} data-seg={k}>
            <span className="ts" dir="ltr">{fmt(seg.s)}</span>
            <div className="seg-edit">
              <textarea dir="auto" value={draft} autoFocus rows={Math.max(2, Math.ceil(draft.length / 48))}
                aria-label="Edit sentence" onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(k, draft); }
                  if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                }} />
              <div className="seg-edit-bar">
                <button type="button" className="btn small accent" disabled={saving || !draft.trim()} onClick={() => save(k, draft)}>Save <kbd>↵</kbd></button>
                <button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel <kbd>Esc</kbd></button>
                {seg.edited && <button type="button" className="link small" onClick={() => save(k, null)}>Revert to recognised text</button>}
              </div>
            </div>
          </div>
        );
      }
      const parts: React.ReactNode[] = [];
      for (let i = seg.w0; i < seg.w1; i++) {
        const w = tr.words[i];
        if (i > seg.w0) {
          const gap = w.s - tr.words[i - 1].e;
          parts.push(gap > minGap
            ? <span key={`g${i}`} className={`pause ${inShort(w.s) ? "cut" : ""}`} dir="ltr">{gap.toFixed(1)}s</span>
            : " ");
        }
        const mid = (w.s + w.e) / 2;
        const src = marks.starts.get(i);
        if (src) parts.push(<SourceBadge key={`b${i}`} src={src} />);
        const mk = marks.kind.get(i);
        const cls = [inShort(mid) ? "in" : "", hitSet.has(i) ? "hit" : "", inSel(mid) ? "picked" : "",
          mk === "quran" ? "qw" : mk === "hadith" ? "hw" : "", showDoubt && w.flag ? `fl-${w.flag}` : ""].join(" ").trim();
        const tip = w.spoken ? `heard as: ${w.spoken}`
          : showDoubt && w.flag === "doubt" ? `Likely wrong: the other recognisers heard ${(w.alts ?? []).join(" / ") || "nothing here"}. Click to fix`
          : showDoubt && w.flag === "voted" ? `Changed: two recognisers agreed on this; the first reading was ${(w.alts ?? []).join(" / ")}. Click to check`
          : showDoubt && w.flag === "gemini" ? `Changed by Gemini (${w.why ?? "proofreading"}); was ${(w.alts ?? [])[0] ?? "?"}`
          : undefined;
        parts.push(<span key={i} data-i={i} className={(fixing === i ? `${cls} fixing` : cls) || undefined} title={fixing === i ? undefined : tip}>{w.w}</span>);

      }
      const whole = sel && segRange(k)[0] >= sel[0] - 0.01 && segRange(k)[1] <= sel[1] + 0.01;
      const [ga, gb] = segRange(k);
      const paraIn = ranges.some(([a, b]) => a < gb && b > ga);
      const trSeg = showTr ? ed.translation?.segments[k] : undefined;
      const stale = trSeg && trSeg.source !== tr.words.slice(seg.w0, seg.w1).map((w) => w.w).join(" ");
      return (
        <div className={`para ${whole ? "picked" : ""}`} key={k} data-seg={k} onDoubleClick={() => startEdit(k)}>
          <button type="button" className={`ts ${whole ? "sel" : paraIn ? "in" : ""}`} dir="ltr" onClick={() => { seek(seg.s); play(); }} aria-label={`Play from ${fmt(seg.s)}`}>{fmt(seg.s)}</button>
          <div className="para-body">
          <p>{parts}{seg.edited && <span className="edited-tag" dir="ltr">edited</span>}</p>
          {fixing != null && fixing >= seg.w0 && fixing < seg.w1 && tr.words[fixing].flag && (
            <WordFix word={tr.words[fixing]} onClose={() => setFixing(null)}
              onPick={(text) => { const i = fixing; setFixing(null); ed.editWord(i, text); }} />
          )}
          {trSeg && (editingTr === k ? (
            <div className="seg-edit tr-edit" onDoubleClick={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
              <textarea dir={ed.translationLang === "ar" ? "rtl" : "ltr"} lang={ed.translationLang} value={trDraft} autoFocus
                rows={Math.max(2, Math.ceil(trDraft.length / 60))} aria-label="Edit translation"
                onChange={(e) => setTrDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (trDraft.trim()) ed.editTranslation(k, trDraft).then(() => setEditingTr(null)); }
                  if (e.key === "Escape") { e.preventDefault(); setEditingTr(null); }
                }} />
              <div className="seg-edit-bar">
                <button type="button" className="btn small accent" disabled={!trDraft.trim()} onClick={() => ed.editTranslation(k, trDraft).then(() => setEditingTr(null))}>Save <kbd>↵</kbd></button>
                <button type="button" className="btn small" onClick={() => setEditingTr(null)}>Cancel <kbd>Esc</kbd></button>
              </div>
            </div>
          ) : (
            <p className="para-tr" lang={ed.translationLang} dir={ed.translationLang === "ar" ? "rtl" : "ltr"} title="Double-click to edit the translation"
              onDoubleClick={(e) => { e.stopPropagation(); setTrDraft(trSeg.text); setEditingTr(k); }}>
              {trSeg.text}
              {trSeg.edited && <span className="edited-tag" dir="ltr">edited</span>}
              {stale && <span className="edited-tag" dir="ltr" title="This sentence was edited after it was translated. Translate again to update.">out of date</span>}
              <button type="button" className="icon tr-pen" aria-label="Edit this translation" title="Edit translation (or double-click)"
                onClick={(e) => { e.stopPropagation(); setTrDraft(trSeg.text); setEditingTr(k); }}>✎</button>
            </p>
          ))}
          </div>
          <span className="para-tools">
            <button type="button" className="icon" aria-label="Edit this sentence" title="Edit text (or double-click)" onClick={() => startEdit(k)}>✎</button>
          </span>
        </div>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr, JSON.stringify(ranges), minGap, hitSet, sel, editing, draft, saving, marks, showTr, ed.translation, editingTr, trDraft, showDoubt, fixing]);

  const lang = tr?.language ?? ed.lecture.language ?? "ar";
  const rtl = ["ar", "fa", "ur", "he"].includes(lang);

  return (
    <section className="transcript-panel" aria-label="Transcript">
      {!tr ? (
        <div className="no-transcript">
          <h2>No transcript yet</h2>
          <p>Transcribing lets you read the video, search it, select by sentence and correct the text. It runs on your GPU, roughly a minute or two per hour of video.</p>
          {ed.transcribeJob ? (
            <div className="render-progress block" role="status">
              <span>Transcribing… {Math.round(ed.transcribeJob.progress * 100)}%</span>
              <progress max={1} value={ed.transcribeJob.progress} />
            </div>
          ) : (
            <button type="button" className="btn primary" onClick={() => ed.transcribe()}>Transcribe video</button>
          )}
          <p className="muted small">You can already pick moments on the timeline; captions for your clips are transcribed when you render.</p>
        </div>
      ) : (
        <>
          <div className="search-row">
            <label className="search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <span className="sr">Search the transcript</span>
              <input type="search" dir="auto" value={query} placeholder="Search the transcript" onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") jump(hitIdx + (e.shiftKey ? -1 : 1)); }} />
              {query && <span className="count">{hits.length ? `${hitIdx + 1} / ${hits.length}` : "no matches"}</span>}
            </label>
            <button type="button" className="btn small" disabled={!hits.length} onClick={() => jump(hitIdx - 1)} aria-label="Previous match">↑</button>
            <button type="button" className="btn small" disabled={!hits.length} onClick={() => jump(hitIdx + 1)} aria-label="Next match">↓</button>
            <ViewMenu>
              {ed.translation && <label className="check"><input type="checkbox" checked={showTr} onChange={(e) => setShowTr(e.target.checked)} />Show {LANG_NAME[ed.translationLang]}</label>}
              {tr.words.some((w) => w.flag) && (
                <label className="check">
                  <input type="checkbox" checked={showDoubt} onChange={(e) => setShowDoubt(e.target.checked)} />
                  Mark <span className="fl-doubt">doubtful</span> words
                </label>
              )}
              {tr.words.some((w) => w.flag) && (
                <span className="view-key small">
                  <span className="fl-doubt">Red</span>: likely wrong · <span className="fl-voted">amber</span>: changed by majority · <span className="fl-gemini">blue</span>: changed by Gemini. Hover a word to see what else was heard. Not every mistake is caught.
                </span>
              )}
              <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow playback</label>
              <span className="view-key small">
                <b>Click</b> a sentence to select · <b>Shift+click</b> to extend · <b>Double-click</b> to fix text{ed.translation && showTr ? " or translation" : ""}
              </span>
            </ViewMenu>
          </div>
          <TranscriptInfo ed={ed} />
          <article ref={article} lang={lang} dir={rtl ? "rtl" : "ltr"} className={`transcript ${rtl ? "rtl" : ""}`} onMouseUp={onMouseUp}>
            {body}
          </article>
        </>
      )}
    </section>
  );
}


/**
 * The other readings of a word the recognisers disagreed on, one click each,
 * or keep it as it is. Shown under the word when it's clicked.
 */
function WordFix({ word, onPick, onClose }: { word: Word; onPick: (text: string | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);
  const alts = (word.alts ?? []).filter((a) => a.trim() && a !== word.w);
  const doubt = word.flag === "doubt";
  const gemini = word.flag === "gemini";
  return (
    <span className="word-fix" ref={ref} dir="ltr" role="group" aria-label={`Fix “${word.w}”`}
      onMouseUp={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <b className={doubt ? "bad-reading" : "voted-reading"}>
        {doubt ? "Likely wrong" : gemini ? "Changed by Gemini" : "Changed by majority"}: <span className="reading" dir="auto">{word.w}</span>
      </b>
      <span>
        {doubt
          ? alts.length ? "The other recognisers heard:" : "The other recognisers heard nothing here."
          : gemini ? `${word.why ?? "Proofreading"}. It was:`
          : "Two recognisers agreed on this. The first reading was:"}
      </span>
      <span className="word-fix-picks">
        {alts.map((a) => (
          <button key={a} type="button" className="btn small reading" dir="auto" onClick={() => onPick(a)}>{a}</button>
        ))}
        {doubt && !alts.length && <button type="button" className="btn small" onClick={() => onPick("")}>Remove this word</button>}
        <button type="button" className="btn small ghost" onClick={() => onPick(null)}>Keep <span className="reading" dir="auto">{word.w}</span></button>
      </span>
    </span>
  );
}

function SourceBadge({ src }: { src: import("./api").Source }) {
  const [open, setOpen] = useState(false);
  if (src.type === "quran") {
    const where = src.ref?.startsWith("~");
    const title = where ? `Quran: these words appear in ${src.places ?? "several"} places, so no surah/ayah is shown`
      : src.keep_spoken ? "Quran: the speaker's own harakat are kept (they are discussing a reading)"
      : "Quran: replaced with the exact mushaf text";
    return (
      <a className="src-badge quran" href={src.url ?? undefined} target="_blank" rel="noreferrer" dir="rtl"
        title={title} onMouseUp={(e) => e.stopPropagation()}>
        ﴿ {where ? "قرآن" : src.ref} ﴾
      </a>
    );
  }
  return (
    <span className="src-badge hadith" dir="ltr" onMouseUp={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        Hadith{src.ref ? ` · ${src.ref}` : " · source not found"}{src.grade ? ` · ${src.grade}` : ""}
      </button>
      {open && (
        <span className="src-pop" dir="auto">
          {src.text ? <span className="src-ar" dir="rtl" lang="ar">{src.text.length > 600 ? src.text.slice(0, 600) + "…" : src.text}</span>
            : <span>This sounds like a hadith (it follows a phrase like «قال رسول الله ﷺ»), but it wasn't found in the six books.</span>}
          {src.english && <span className="src-en">{src.english.length > 400 ? src.english.slice(0, 400) + "…" : src.english}</span>}
          {src.url && <a href={src.url} target="_blank" rel="noreferrer">Open on sunnah.com</a>}
        </span>
      )}
    </span>
  );
}

const LANG_NAME: Record<string, string> = { en: "English", ar: "Arabic" };

/** The transcript's display options and how-to, folded into one menu. */
function ViewMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  return (
    <details className="view-menu" ref={ref}>
      <summary className="btn small">View</summary>
      <div className="view-pop">{children}</div>
    </details>
  );
}

function TranscriptInfo({ ed }: { ed: Ed }) {
  const tr = ed.transcript!;
  const q = (tr.sources ?? []).filter((s) => s.type === "quran").length;
  const h = (tr.sources ?? []).filter((s) => s.type === "hadith").length;
  const arabic = (tr.language ?? ed.lecture.language) === "ar";
  const [upgrading, setUpgrading] = useState(false);
  return (
    <div className="tr-info">
      <span className="muted small">
        {tr.engine === "tashkeel" ? "Accurate Arabic with harakat" : "Standard transcript"}
        {(q || h) ? ` · ${q} Quran quotation${q === 1 ? "" : "s"} · ${h} hadith` : ""}
      </span>
      {arabic && tr.engine !== "tashkeel" && !ed.transcribeJob && (
        <button type="button" className="btn small" onClick={() => setUpgrading(true)}>Upgrade to accurate Arabic</button>
      )}
      {upgrading && (
        <Confirm action="Transcribe again" onCancel={() => setUpgrading(false)}
          onConfirm={() => { setUpgrading(false); ed.transcribe("tashkeel"); }}>
          Transcribe again with accurate Arabic (with harakat)? Your text corrections in this video will be replaced.
        </Confirm>
      )}
      {ed.transcribeJob && <span className="small">Transcribing… {Math.round(ed.transcribeJob.progress * 100)}%</span>}
      {ed.gemini && !ed.transcribeJob && tr.words.some((w) => w.flag === "doubt" || w.flag === "voted") && (
        ed.proofreadJob ? <span className="small">Gemini is proofreading…</span> : (
          <button type="button" className="btn small" title="Send the audio and the transcript to Gemini (Google), which checks only the underlined words. On Google's free tier, what you send may be used to improve Google's products."
            onClick={() => ed.proofread()}>Proofread doubtful words with Gemini</button>
        ))}
      {ed.proofreadFailed && !ed.proofreadJob && <span className="small err-text" title={ed.proofreadFailed.message}>Gemini: {ed.proofreadFailed.message.slice(0, 80)}</span>}
      <span className="tr-translate">
        {ed.translateJob ? (
          <span className="small">Translating… {Math.round(ed.translateJob.progress * 100)}%</span>
        ) : ed.translation ? (
          <button type="button" className="link small" title="Translate again (e.g. after editing sentences)" onClick={() => ed.translate()}>Re-translate {LANG_NAME[ed.translationLang]}</button>
        ) : (
          <button type="button" className="btn small" disabled={!!ed.transcribeJob}
            title={`Translate every sentence into ${LANG_NAME[ed.translationLang]} on your GPU. Quran verses use the ${ed.translationLang === "en" ? "Saheeh International" : "published"} translation.`}
            onClick={() => ed.translate()}>Translate to {LANG_NAME[ed.translationLang]}</button>
        )}
      </span>
    </div>
  );
}
