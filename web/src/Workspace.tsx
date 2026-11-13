import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type Moment, type Range, type Word } from "./api";
import { Confirm } from "./Confirm";
import { TopBar, type Ed } from "./Editor";
import { CaptionTextPanel, CaptionsPanel, ClipStrip, captionEdit, ExportPanel, FramingPanel, PausesPanel, PostPanel, Preview, Stats, cropWidth, sortedCameras, summary, type Section } from "./panels";
import { VolumeControl } from "./Volume";
import { SpeedPicker, at, previewCommand, trackFor, type Track } from "./Quick";
import { Timeline } from "./Timeline";
import { clamp, fmt, normalize, storage, store } from "./util";

const SECTIONS: Section[] = ["pauses", "look", "text", "framing", "export", "post"];
const SECTION_NAME: Record<Section, string> = { pauses: "Pauses", look: "Captions & look", text: "Caption text", framing: "Framing", export: "Export", post: "Post" };
const SECTION_SHORT: Record<Section, string> = { pauses: "Pauses", look: "Look", text: "Text", framing: "Frame", export: "Export", post: "Post" };
const SECTION_ICON: Record<Section, string> = {
  pauses: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12",
  look: "M4 7V4h16v3M9 20h6M12 4v16",
  text: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  framing: "M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2",
  export: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  post: "m22 2-7 20-4-9-9-4zM22 2 11 13",
};
const SECTION_KEY = "settings-section";
const WORD_LEN_KEY = "word-lengths";
/** A word said for this long (seconds) or longer is drawn-out: its bar is full width and marked. */
const LONG_WORD = 1;
const FOLD_KEY = "folded-sections";

function storedSection(): Section {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    return SECTIONS.includes(v as Section) ? (v as Section) : "look";
  } catch { return "look"; }
}

/** The parts of the editor that fold away to give the others their room. */
type Part = "transcript" | "source" | "timeline" | "preview" | "side";
const PART_NAME: Record<Part, string> = { transcript: "Transcript", source: "Video", timeline: "Timeline", preview: "Preview", side: "Settings" };
const NONE_FOLDED: Record<Part, boolean> = { transcript: false, source: false, timeline: false, preview: false, side: false };

/** The editor's height, for the preview's picture: as tall as it allows beside its controls. */
function useHeight(ref: React.RefObject<HTMLElement>) {
  const [h, setH] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.clientHeight);
    const ro = new ResizeObserver(([e]) => setH(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

/** Columns you can drag wider or narrower: their widths in pixels, kept between visits. */
type Sized = "transcript" | "preview" | "side";
const SIZE_KEY = "column-widths";
const SIZE_LIMIT: Record<Sized, [number, number]> = { transcript: [200, 900], preview: [220, 900], side: [300, 760] };
const SOURCE_MIN = 260;  // the video keeps at least this much

/** The handle on a column's edge: drag it, use the arrow keys, or double-click it to go back to the default width. */
function ColumnHandle({ part, edge, col, rows, grid, sizes, onSize }: {
  part: Sized; edge: "start" | "end"; col: number; rows: string; grid: React.RefObject<HTMLDivElement>;
  sizes: Partial<Record<Sized, number>>; onSize: (part: Sized, w: number | null) => void;
}) {
  const sel = { transcript: ".transcript-panel", preview: ".preview-col", side: ".side" }[part];
  const width = () => grid.current?.querySelector<HTMLElement>(sel)?.getBoundingClientRect().width ?? 0;
  // how wide it may get: its limit, and never squeezing the video below its minimum
  const max = () => {
    const room = (grid.current?.querySelector<HTMLElement>(".source")?.getBoundingClientRect().width ?? 0) - SOURCE_MIN;
    return Math.min(SIZE_LIMIT[part][1], width() + Math.max(0, room));
  };
  const set = (w: number) => onSize(part, Math.round(clamp(w, SIZE_LIMIT[part][0], Math.max(SIZE_LIMIT[part][0], max()))));
  const sign = edge === "end" ? 1 : -1;  // dragging away from the column widens it
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width(), top = max();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    document.body.classList.add("col-resizing");
    const move = (ev: PointerEvent) => onSize(part, Math.round(clamp(w0 + sign * (ev.clientX - x0), SIZE_LIMIT[part][0], Math.max(SIZE_LIMIT[part][0], top))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("active");
      document.body.classList.remove("col-resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div className={`col-resize ${edge}`} style={{ gridColumn: col, gridRow: rows }} role="separator" aria-orientation="vertical"
      aria-label={`Resize ${PART_NAME[part].toLowerCase()}`} aria-valuenow={Math.round(sizes[part] ?? width())} tabIndex={0}
      title="Drag to resize · double-click for the default width"
      onPointerDown={down} onDoubleClick={() => onSize(part, null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        set(width() + sign * (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 80 : 20));
      }} />
  );
}

/** The arrow that folds a section away. `to`: the side it folds towards. */
function FoldButton({ part, to, onFold }: { part: Part; to: "left" | "right"; onFold: () => void }) {
  return (
    <button type="button" className="icon fold" aria-label={`Hide ${PART_NAME[part].toLowerCase()}`}
      title={`Hide ${PART_NAME[part].toLowerCase()} to give the rest more room`} onClick={onFold}>
      {to === "left" ? "«" : "»"}
    </button>
  );
}

/** A folded section: a thin strip that brings it back. */
function FoldStrip({ part, from, onOpen }: { part: Part; from: "left" | "right"; onOpen: () => void }) {
  return (
    <button type="button" className="fold-strip" aria-label={`Show ${PART_NAME[part].toLowerCase()}`} title={`Show ${PART_NAME[part].toLowerCase()}`} onClick={onOpen}>
      <span aria-hidden="true">{from === "left" ? "»" : "«"}</span>
      <b>{PART_NAME[part]}</b>
    </button>
  );
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
  const [capKey, setCapKey] = useState<number | null>(null);  // the caption picked in the list or on the timeline
  const [section, setSection] = useState<Section>(storedSection);
  const foldedRef = useRef(NONE_FOLDED);
  const foldRef = useRef<(part: Part, v: boolean) => void>(() => {});
  const setOpen = (v: Section) => {
    setSection(v);
    if (foldedRef.current.side) foldRef.current("side", false);
    try { localStorage.setItem(SECTION_KEY, v); } catch { /* storage unavailable */ }
  };
  // any section folds away, and stays folded between visits
  const [folded, setFolded] = useState<Record<Part, boolean>>(() => ({ ...NONE_FOLDED, ...storage<Partial<Record<Part, boolean>>>(FOLD_KEY, {}) }));
  const fold = (part: Part, v: boolean) => {
    setFolded((now) => {
      const next = { ...now, [part]: v };
      store(FOLD_KEY, next);
      return next;
    });
    if (part === "source" && v) video.current?.pause();
  };
  foldedRef.current = folded;
  foldRef.current = fold;
  const gridRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Partial<Record<Sized, number>>>(() => storage(SIZE_KEY, {}));
  const setSize = (part: Sized, w: number | null) => setSizes((now) => {
    const next = { ...now };
    if (w == null) delete next[part]; else next[part] = w;
    store(SIZE_KEY, next);
    return next;
  });
  // the preview's picture: as tall as the editor allows, and no wider than its column when you've sized it
  const fitWidth = ((useHeight(gridRef) - 262) * 9) / 16;
  const previewWidth = Math.round(sizes.preview
    ? clamp(Math.min(fitWidth, sizes.preview - 32), 150, 900)
    : clamp(fitWidth, 150, Math.min(400, window.innerWidth * 0.22)));
  // the columns: a folded one is a strip; the room it leaves goes to the video, else the transcript, else the preview
  const strip = "30px";
  const cols = [
    folded.transcript ? strip : folded.source ? "minmax(0, 1fr)" : sizes.transcript ? `${sizes.transcript}px` : "minmax(260px, 22%)",
    folded.source ? strip : "minmax(0, 1fr)",
    folded.preview ? strip : folded.transcript && folded.source ? "minmax(0, 1fr)" : `${sizes.preview ?? Math.max(previewWidth + 32, 302)}px`,
    folded.side ? "62px" : folded.transcript && folded.source && folded.preview ? "minmax(384px, 1fr)" : `${sizes.side ?? 384}px`,
  ].join(" ");
  // a column has a handle while it is open and has a width of its own (not taking up the room left over)
  const sizable = {
    transcript: !folded.transcript && !folded.source,
    preview: !folded.preview && !(folded.transcript && folded.source),
    side: !folded.side && !(folded.transcript && folded.source && folded.preview),
  };
  const handle = { grid: gridRef, sizes, onSize: setSize };
  const ce = ed.short?.caption_edits;
  const captionsEdited = !!ce && (ce.starts.length > 0 || ce.joins.length > 0 || Object.keys(ce.times).length > 0);
  // a render just finished: show what to post it with
  const renderedAt = ed.short?.last_render?.at;
  const seenRender = useRef({ id: ed.short?.id, at: renderedAt });
  useEffect(() => {
    const seen = seenRender.current;
    if (renderedAt && seen.id === ed.short?.id && renderedAt !== seen.at) setOpen("post");
    seenRender.current = { id: ed.short?.id, at: renderedAt };
  }, [renderedAt, ed.short?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rate, setRate] = useState(1);
  useEffect(() => { if (video.current) { video.current.playbackRate = rate; video.current.preservesPitch = true; } }, [rate]);
  const stopAt = useRef<number | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  // where Space and the arrows go: the video, or the preview's player once you click in it or play a caption there
  const [keysTo, setKeysTo] = useState<"source" | "preview">("source");
  const playInPreview = (r: Range) => {
    setKeysTo("preview");
    if (folded.preview) fold("preview", false);
    previewCommand({ kind: "play", src: r });
  };

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
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // undo and redo only: Ctrl+I, Ctrl+O and the rest stay the browser's
        const k = e.key.toLowerCase();
        if (e.altKey || (k !== "z" && k !== "y")) return;
        e.preventDefault();
        if (k === "y" || e.shiftKey) ed.redo(); else ed.undo();
        return;
      }
      if (e.key === "?") { e.preventDefault(); setKeysOpen((v) => !v); return; }
      if (keysTo === "preview" && (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (el.closest("video[controls]")) return;  // the rendered video's own controls
        e.preventDefault();
        if (e.key === " ") previewCommand({ kind: "toggle" });
        else previewCommand({ kind: "seek", by: (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1) });
        return;
      }
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
    : `9:16 frame${playing ? "" : " · drag to adjust"}`;
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
      <div className="ws-grid" ref={gridRef} style={{ "--cols": cols } as CSSProperties}
        onPointerDownCapture={(e) => {
          const el = e.target as HTMLElement;
          if (el.closest(".preview-col")) setKeysTo("preview");
          else if (el.closest(".source, .transcript-panel, .tl")) setKeysTo("source");
        }}>
        <TranscriptPanel ed={ed} time={time} playing={playing} sel={sel} onSelect={select} seek={seek}
          play={() => video.current?.play()} folded={folded.transcript} onFold={(v) => fold("transcript", v)} />

        <section className={`source ${folded.source ? "folded" : ""}`} aria-label="Video">
          {folded.source && <FoldStrip part="source" from="left" onOpen={() => fold("source", false)} />}
          <div className="sec-head">
            <b>Video</b><span className="muted small">the source, with the 9:16 frame the short takes</span>
            <span className="grow" /><FoldButton part="source" to="left" onFold={() => fold("source", true)} />
          </div>
          <div className="player" style={{
            // exactly the video's shape, so the 9:16 frame lines up with the picture
            aspectRatio: `${ed.lecture.width ?? 16} / ${ed.lecture.height ?? 9}`,
            width: `min(100%, calc((100vh - 460px) * ${(ed.lecture.width ?? 16) / (ed.lecture.height ?? 9)}))`,
          }}>
            <video ref={video} src={api.videoUrl(ed.lecture.id)} poster={api.thumbUrl(ed.lecture.id)} preload="auto" playsInline
              onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); setTime(video.current?.currentTime ?? 0); }}
              onSeeked={onSeeked} onClick={toggle} />
            <div className={`crop-guide ${playing ? "" : "draggable"} ${cam?.manual ? "manual" : ""}`}
              style={{ width: `${cw * 100}%`, left: `${guideLeft}%` }}
              onPointerDown={(e) => {
                if (playing) return;
                e.stopPropagation();
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
                setGuideDrag(guideX(e));
              }}
              onPointerMove={(e) => guideRef.current != null && setGuideDrag(guideX(e))}
              onPointerUp={(e) => {
                if (guideRef.current == null) return;
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
            <Shortcuts open={keysOpen} onOpen={setKeysOpen} />
          </div>
        </section>

        <section className={`tl ${folded.timeline ? "folded" : ""}`} aria-label="Timeline">
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
            <button type="button" className="icon fold" aria-expanded={!folded.timeline} aria-label={folded.timeline ? "Show timeline" : "Hide timeline"}
              title={folded.timeline ? "Show the timeline" : "Hide the timeline to give the rest more room"}
              onClick={() => fold("timeline", !folded.timeline)}>{folded.timeline ? "⌃" : "⌄"}</button>
          </div>
          <Timeline duration={duration} peaks={ed.waveform} speech={ed.speech} minGap={ed.estimate?.fit?.min_gap ?? s?.min_gap ?? 0.4}
            ranges={s?.ranges ?? []} selection={sel} time={time} view={view} onView={setView}
            onSeek={seek} onSelect={setSel}
            captions={s?.captions ? ed.captions?.captions ?? [] : []} captionKey={capKey}
            onCaption={(c) => { setCapKey(c.key); seek(c.src[0]); }}
            onCaptionOpen={(c) => { setCapKey(c.key); setOpen("text"); playInPreview(c.src); }}
            onRangeChange={(i, r) => ed.update({ ranges: (ed.short?.ranges ?? []).map((x, k) => (k === i ? r : x)) })}
            onCaptionTime={(c, r) => captionEdit(ed, (e) => { e.times[String(c.key)] = [Math.round(r[0] * 100) / 100, Math.round(r[1] * 100) / 100]; })} />
          <ClipStrip ed={ed} onPlay={playRange} />
        </section>

        {sizable.transcript && <ColumnHandle part="transcript" edge="end" col={1} rows="1" {...handle} />}
        {sizable.preview && <ColumnHandle part="preview" edge="start" col={3} rows="1 / 3" {...handle} />}
        {sizable.side && <ColumnHandle part="side" edge="start" col={4} rows="1 / 3" {...handle} />}
        <section className={`preview-col ${folded.preview ? "folded" : ""} ${keysTo === "preview" ? "keys-here" : ""}`} aria-label="Preview">
          {folded.preview && <FoldStrip part="preview" from="right" onOpen={() => fold("preview", false)} />}
          <div className="sec-head">
            <b>Preview</b><span className="muted small">the short as it will look</span>
            <span className="grow" /><FoldButton part="preview" to="right" onFold={() => fold("preview", true)} />
          </div>
          {!folded.preview && <Preview ed={ed} t={time} width={previewWidth} />}
        </section>

        <aside className={`side ${folded.side ? "folded" : ""}`} aria-label="Settings">
          <nav className="rail" aria-label="Settings sections">
            {SECTIONS.map((sec) => (
              <button key={sec} type="button" aria-current={section === sec ? "true" : undefined} aria-controls="settings-panel"
                title={`${SECTION_NAME[sec]}: ${summary(ed, sec)}`} onClick={() => setOpen(sec)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={SECTION_ICON[sec]} /></svg>
                {SECTION_SHORT[sec]}
                {sec === "text" && captionsEdited && <i className="rail-dot" title="Has your own caption splits or timing" />}
              </button>
            ))}
            <span className="grow" />
            {folded.side && <button type="button" className="rail-fold" aria-label="Show settings" title="Show the settings" onClick={() => fold("side", false)}>«</button>}
          </nav>
          <div className="side-main">
            <div className="side-title">
              <h3>{SECTION_NAME[section]}</h3>
              <span dir="auto">{summary(ed, section)}</span>
              <FoldButton part="side" to="right" onFold={() => fold("side", true)} />
            </div>
            <div className="side-body" id="settings-panel" role="region" aria-label={SECTION_NAME[section]}>
              {section === "pauses" && <PausesPanel ed={ed} />}
              {section === "look" && <CaptionsPanel ed={ed} />}
              {section === "text" && <CaptionTextPanel ed={ed} time={time} onPlay={(r) => { show(r[0], r[1]); playInPreview(r); }} selKey={capKey} onSelKey={setCapKey} />}
              {section === "framing" && <FramingPanel ed={ed} />}
              {section === "export" && <ExportPanel ed={ed} />}
              {section === "post" && <PostPanel ed={ed} />}
            </div>
            <div className="dock">
              <Stats ed={ed} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- transcript ---------------- */

function TranscriptPanel({ ed, time, playing, sel, onSelect, seek, play, folded, onFold }: {
  ed: Ed; time: number; playing: boolean; sel: Range | null; onSelect: (r: Range | null) => void;
  seek: (t: number) => void; play: () => void; folded: boolean; onFold: (v: boolean) => void;
}) {
  const tr = ed.transcript;
  const s = ed.short;
  const article = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const [follow, setFollow] = useState(true);
  const [showTr, setShowTr] = useState(true);
  const [showDoubt, setShowDoubt] = useState(true);
  const [showLen, setShowLenState] = useState(() => storage(WORD_LEN_KEY, false));
  const setShowLen = (v: boolean) => { setShowLenState(v); store(WORD_LEN_KEY, v); };
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
    if (target.closest(".ts, .para-tools, .seg-edit, .word-fix, .miss")) return;
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
        // how long the word is said: a bar under it (full width at LONG_WORD seconds), the seconds on hover
        const said = Math.max(0, w.e - w.s);
        const len = showLen ? { "--len": `${Math.round(clamp(said / LONG_WORD, 0.08, 1) * 100)}%` } as CSSProperties : undefined;
        const lenTip = showLen ? `Said in ${said.toFixed(2)} s` : undefined;
        parts.push(<span key={i} data-i={i} style={len}
          className={[fixing === i ? `${cls} fixing` : cls, showLen && said >= LONG_WORD ? "long" : ""].join(" ").trim() || undefined}
          title={fixing === i ? undefined : tip && lenTip ? `${lenTip} · ${tip}` : tip ?? lenTip}>{w.w}</span>);
        if (w.missing) {
          parts.push(" ", <span key={`m${i}`} className="miss" onMouseUp={(e) => e.stopPropagation()}>
            <button type="button" dir="rtl" onClick={() => ed.missingWord(i, true)}
              title="In the hadith here, but the recognisers didn't hear it (quick words like this are often dropped). Click if he said it.">+ {w.missing}</button>
            <button type="button" className="miss-no" aria-label={`He didn't say ${w.missing}`} title="He didn't say it" onClick={() => ed.missingWord(i, false)}>×</button>
          </span>);
        }

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
  }, [tr, JSON.stringify(ranges), minGap, hitSet, sel, editing, draft, saving, marks, showTr, ed.translation, editingTr, trDraft, showDoubt, fixing, showLen]);

  const lang = tr?.language ?? ed.lecture.language ?? "ar";
  const rtl = ["ar", "fa", "ur", "he"].includes(lang);

  return (
    <section className={`transcript-panel ${folded ? "folded" : ""}`} aria-label="Transcript">
      {folded && <FoldStrip part="transcript" from="left" onOpen={() => onFold(false)} />}
      <div className="tr-top">
        <div className="sec-head">
          <b>Transcript</b>
          <span className="grow" /><FoldButton part="transcript" to="left" onFold={() => onFold(true)} />
        </div>
        {tr && (
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
                <label className="check" title="A bar under each word shows how long it is said; drawn-out words (a second or more) stand out. Hover a word for its seconds.">
                  <input type="checkbox" checked={showLen} onChange={(e) => setShowLen(e.target.checked)} />Show how long each word is said
                </label>
                <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow playback</label>
                <span className="view-key small">
                  <b>Click</b> a sentence to select · <b>Shift+click</b> to extend · <b>Double-click</b> to fix text{ed.translation && showTr ? " or translation" : ""}
                </span>
              </ViewMenu>
            </div>
        )}
      </div>
      {!tr ? (
        <div className="no-transcript">
          <h2>No transcript yet</h2>
          <p>Transcribing lets you read the video, search it, select by sentence and correct the text. It runs on your GPU, roughly a minute or two per hour of video.</p>
          {ed.transcribeJob ? (
            <div className="render-progress block" role="status">
              <span>Transcribing… {Math.round(ed.transcribeJob.progress * 100)}%</span>
              <progress max={1} value={ed.transcribeJob.progress} />
            </div>
          ) : (<>
            {ed.transcribeError && <p className="small err-text" role="alert">Transcription stopped. {ed.transcribeError}</p>}
            <button type="button" className="btn primary" onClick={() => ed.transcribe()}>{ed.transcribeError ? "Try again" : "Transcribe video"}</button>
          </>)}
          <p className="muted small">You can already pick moments on the timeline. {ed.short?.captions !== false
            ? <>Captions for your clips are transcribed when you render, or <button type="button" className="link" onClick={() => ed.update({ captions: false })}>render without captions</button> and no transcript is needed.</>
            : <>This short has no captions, so it renders without a transcript.</>}</p>
        </div>
      ) : (
        <>
          <TranscriptInfo ed={ed} />
          <Moments ed={ed} seek={seek} onSelect={(r) => {
            onSelect(r);
            // bring the moment's first sentence into view (below the header that stays on top)
            const i = r ? words.findIndex((w) => w.e > r[0]) : -1;
            if (i >= 0) article.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
          }} />
          <article ref={article} lang={lang} dir={rtl ? "rtl" : "ltr"} className={`transcript ${rtl ? "rtl" : ""} ${showLen ? "show-len" : ""}`} onMouseUp={onMouseUp}>
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
  // open the card towards the side of the transcript that has room for it
  const [pos, setPos] = useState<CSSProperties>({});
  const toggle = (e: { currentTarget: HTMLButtonElement }) => {
    if (!open) {
      const r = e.currentTarget.getBoundingClientRect();
      const box = e.currentTarget.closest(".transcript-panel")?.getBoundingClientRect();
      const left = box?.left ?? 0, right = box?.right ?? window.innerWidth;
      const w = Math.min(340, right - left - 16);
      const x = Math.min(Math.max(left + 8, r.left), right - 8 - w) - r.left;
      setPos({ width: w, insetInlineStart: x });  // the badge is dir="ltr": inline start is its left
    }
    setOpen(!open);
  };
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
      <button type="button" onClick={toggle} aria-expanded={open}>
        Hadith{src.ref ? ` · ${src.ref}` : " · source not found"}{src.grade ? ` · ${src.grade}` : ""}
      </button>
      {open && (
        <span className="src-pop" dir="auto" style={pos}>
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

const KEYS: [string, string][] = [
  ["Space", "Play or pause: the video, or the preview once you click in it or play a caption (click the video to switch back)"],
  ["← →", "Back or forward 1 second (with Shift, 5), in whichever is playing"],
  ["I", "Start the selection at the playhead"],
  ["O", "End the selection at the playhead"],
  ["Enter", "Add the selection to the short"],
  ["Esc", "Clear the selection"],
  ["Ctrl+Z", "Undo a change to the short"],
  ["Ctrl+Shift+Z", "Redo it"],
  ["Ctrl+scroll", "Zoom the timeline (scroll alone moves it)"],
  ["?", "Show or hide this list"],
];

/** Every keyboard shortcut, behind a small button beside the transport (or the ? key). */
function Shortcuts({ open, onOpen }: { open: boolean; onOpen: (v: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onOpen(false); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc, true); };
  }, [open, onOpen]);
  return (
    <div className="view-menu keys-menu" ref={ref}>
      <button type="button" className="btn small sq" aria-label="Keyboard shortcuts" aria-expanded={open} title="Keyboard shortcuts (?)"
        onClick={() => onOpen(!open)}>?</button>
      {open && (
        <div className="view-pop keys-pop" role="dialog" aria-label="Keyboard shortcuts">
          <b>Keyboard shortcuts</b>
          <dl>
            {KEYS.map(([k, what]) => (
              <div key={k}><dt>{k.split("+").map((part, i) => <span key={part}>{i > 0 && " + "}<kbd>{part}</kbd></span>)}</dt><dd>{what}</dd></div>
            ))}
          </dl>
          <span className="view-key small">They work anywhere except while typing in a text box. On a Mac, ⌘ works where Ctrl is listed.</span>
        </div>
      )}
    </div>
  );
}

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

/** Moments Gemini suggests as shorts on their own; one click selects one. */
function Moments({ ed, onSelect, seek }: { ed: Ed; onSelect: (r: Range | null) => void; seek: (t: number) => void }) {
  const [list, setList] = useState<Moment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const id = ed.lecture.id;
  useEffect(() => { setList(null); api.moments(id).then((m) => setList(m.moments)).catch(() => {}); }, [id]);
  if (!ed.gemini) return null;
  const suggest = async () => {
    setBusy(true); setErr(null);
    try { setList((await api.suggestMoments(id)).moments); setOpen(true); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const inShort = (m: Moment) => (ed.short?.ranges ?? []).some(([a, b]) => a < m.e && b > m.s);
  return (
    <div className="moments">
      <div className="moments-head">
        {list?.length ? (
          <button type="button" className="link small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} {list.length} suggested moment{list.length === 1 ? "" : "s"}
          </button>
        ) : <span className="small muted">{list ? "No moments found." : "Let Gemini find moments that work as shorts on their own."}</span>}
        <button type="button" className="btn small" disabled={busy} onClick={suggest}
          title="Sends the transcript text (not the audio) to Gemini (Google).">
          {busy ? "Reading the transcript…" : list ? "Suggest again" : "Suggest moments"}
        </button>
      </div>
      {err && <p className="small err-text">{err}</p>}
      {open && !!list?.length && (
        <ol className="moment-list">
          {list.map((m) => (
            <li key={`${m.s}-${m.e}`} className={inShort(m) ? "in" : ""}>
              <button type="button" className="moment" onClick={() => { onSelect([m.s, m.e]); seek(m.s); }}
                title="Select this moment (then Add to the short)">
                <span className="tc small">{fmt(m.s, 0)}–{fmt(m.e, 0)}</span>
                <b dir="auto">{m.title}</b>
                <span className="small muted">{m.reason} · {Math.round(m.e - m.s)} s</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** How long since `since` (seconds, as the server's jobs report it), ticking every second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tc">{fmt(Math.max(0, now - since), 0)}</span>;
}

function TranscriptInfo({ ed }: { ed: Ed }) {
  const tr = ed.transcript!;
  const q = (tr.sources ?? []).filter((s) => s.type === "quran").length;
  const h = (tr.sources ?? []).filter((s) => s.type === "hadith").length;
  const arabic = (tr.language ?? ed.lecture.language) === "ar";
  const left = tr.words.filter((w) => w.flag === "doubt" || w.flag === "voted").length;
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
      {!!tr.holes?.length && !ed.transcribeJob && (ed.fillJob
        ? <span className="small">Transcribing the skipped speech… {Math.round(ed.fillJob.progress * 100)}%</span>
        : <button type="button" className="btn small" title={`Whisper wrote nothing for ${tr.holes.length} stretch${tr.holes.length === 1 ? "" : "es"} where someone is talking (from ${tr.holes.slice(0, 3).map(([a]) => fmt(a, 0)).join(", ")}${tr.holes.length > 3 ? "…" : ""}). Transcribe just those; your corrections and translation stay.`}
            onClick={() => ed.fillHoles()}>
            Transcribe {Math.round(tr.holes.reduce((n, [a, b]) => n + b - a, 0))} s of skipped speech
          </button>)}
      {ed.fillFailed && !ed.fillJob && <span className="small err-text" title={ed.fillFailed.message}>Couldn't transcribe the skipped speech: {ed.fillFailed.message.slice(0, 80)}</span>}
      {tr.proofread && !ed.proofreadJob && <span className="muted small">· Proofread by Gemini, {tr.proofread.changed} word{tr.proofread.changed === 1 ? "" : "s"} changed
        {tr.proofread.skipped ? `; ${tr.proofread.skipped} part${tr.proofread.skipped === 1 ? "" : "s"} Gemini didn't answer in time` : ""}</span>}
      {ed.proofreadJob ? (
        <span className="small" role="status">
          Gemini is proofreading{ed.proofreadJob.message ? `: ${ed.proofreadJob.message}` : "…"}
          {ed.proofreadJob.started ? <> · <Elapsed since={ed.proofreadJob.started} /></> : " · waiting for another job to finish"}
        </span>
      ) : ed.gemini && !ed.transcribeJob && left > 0 && (
        <button type="button" className="btn small" title="Send the audio and the transcript to Gemini (Google), which checks only the underlined words, five minutes of audio at a time. On Google's free tier, what you send may be used to improve Google's products."
          onClick={() => ed.proofread()}>{ed.proofreadFailed ? "Try proofreading again" : tr.proofread ? `Proofread the ${left} doubtful word${left === 1 ? "" : "s"} left` : "Proofread doubtful words with Gemini"}</button>
      )}
      {ed.proofreadFailed && !ed.proofreadJob && <span className="small err-text" role="alert">Proofreading stopped: {ed.proofreadFailed.message}</span>}
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
