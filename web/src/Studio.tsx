import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Range } from "./api";
import { TopBar, type Ed } from "./Editor";
import { CaptionsPanel, ClipList, CutsPanel, FramingPanel, Preview, Stats, cropWidth } from "./panels";
import { at, trackFor } from "./Quick";
import { Timeline } from "./Timeline";
import { clamp, fmt } from "./util";

type Tab = "cuts" | "captions" | "framing";

export function Studio({ ed }: { ed: Ed }) {
  const video = useRef<HTMLVideoElement>(null);
  const duration = ed.lecture.duration ?? 0;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Range | null>(null);
  const [view, setView] = useState<Range>([0, Math.min(duration || 120, 120)]);
  const [tab, setTab] = useState<Tab>("cuts");
  const stopAt = useRef<number | null>(null);
  const [track, setTrack] = useState<[number, number, number, number?][]>([]);
  const [guideDrag, setGuideDragState] = useState<number | null>(null);
  const guideRef = useRef<number | null>(null);
  const setGuideDrag = (v: number | null) => { guideRef.current = v; setGuideDragState(v); };
  useEffect(() => { trackFor(ed.lecture.id, ed.framingVersion > 0).then(setTrack); }, [ed.lecture.id, ed.framingVersion]);

  // smooth playhead while playing
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

  // keep the playhead in view
  useEffect(() => {
    const span = view[1] - view[0];
    if (time < view[0] || time > view[1]) {
      const a = clamp(time - span * 0.1, 0, Math.max(0, duration - span));
      setView([a, a + span]);
    }
  }, [time, view, duration]);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = clamp(t, 0, duration);
    setTime(v.currentTime);
  }, [duration]);

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
  const markIn = () => setSel((s) => [time, s && s[1] > time ? s[1] : Math.min(duration, time + 15)]);
  const markOut = () => setSel((s) => [s && s[0] < time ? s[0] : Math.max(0, time - 15), time]);
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

  const s = ed.short;
  const cw = cropWidth(ed, s?.zoom ?? 1);
  // which camera is on screen now, and how it is framed
  const near = track.length ? track.reduce((b, p) => (Math.abs(p[0] - time) < Math.abs(b[0] - time) ? p : b)) : null;
  const camId = near?.[3];
  const cam = ed.cameras?.cameras.find((c) => c.id === camId) ?? null;
  const fx = guideDrag ?? (track.length ? at(track, time)[0] : 0.5);
  const guideLeft = Math.min(1 - cw, Math.max(0, fx - cw / 2)) * 100;
  const camIndex = cam ? [...(ed.cameras?.cameras ?? [])].filter((c) => c.share >= 0.02).sort((a, b) => b.share - a.share).findIndex((c) => c.id === cam.id) : -1;
  const guideLabel = cam
    ? `${camIndex >= 0 ? `Camera ${camIndex + 1}` : "Cutaway"} · ${cam.manual ? "manual" : cam.has_speaker ? "on the lecturer" : "centred"} · drag to adjust`
    : "9:16 · follows the lecturer";
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
    <div className="app studio">
      <TopBar ed={ed} mode="studio" />
      <div className="studio-grid">
        <section className="source" aria-label="Source and timeline">
          <div className="player">
            <video ref={video} src={api.videoUrl(ed.lecture.id)} preload="auto" playsInline
              onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); setTime(video.current?.currentTime ?? 0); }}
              onSeeked={() => setTime(video.current?.currentTime ?? 0)} onClick={toggle} />
            <div className={`crop-guide ${cam ? "draggable" : ""} ${cam?.manual ? "manual" : ""}`}
              style={{ width: `${cw * 100}%`, left: `${guideLeft}%` }}
              onPointerDown={(e) => { if (!cam) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setGuideDrag(guideX(e)); }}
              onPointerMove={(e) => guideRef.current != null && setGuideDrag(guideX(e))}
              onPointerUp={(e) => {
                if (guideRef.current == null || !cam) return;
                const x = guideX(e);
                ed.setFraming(cam.id, { x: Math.round(x * 1000) / 1000, y: cam.manual?.y ?? cam.auto?.y ?? 0.36 });
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
            <span className="tc">{fmt(time, 2)}</span>
            <span className="tc dim">/ {fmt(duration, 2)}</span>
            <button type="button" className="btn small" onClick={() => seek(time - 5)} aria-label="Back 5 seconds">−5s</button>
            <button type="button" className="btn small" onClick={() => seek(time + 5)} aria-label="Forward 5 seconds">+5s</button>
            <span className="grow" />
            {sel && <span className="sel-info tc">{fmt(sel[0], 1)} – {fmt(sel[1], 1)} · {(sel[1] - sel[0]).toFixed(1)}s</span>}
            {sel && <button type="button" className="btn small" onClick={() => playRange(sel)}>Play selection</button>}
            <button type="button" className="btn small" onClick={markIn}><kbd>I</kbd> Mark in</button>
            <button type="button" className="btn small" onClick={markOut}><kbd>O</kbd> Mark out</button>
            <button type="button" className="btn small accent" disabled={!sel} onClick={add}>+ Add to short <kbd>↵</kbd></button>
          </div>

          <div className="tl-head">
            <b>Timeline</b>
            <span className="legend"><i className="lg-sel" />Short</span>
            <span className="legend"><i className="lg-new" />Selection</span>
            <span className="legend"><i className="lg-pause" />Pause (cut)</span>
            <span className="grow" />
            <span className="muted small">Drag to select · click to seek · Ctrl+scroll to zoom</span>
            <button type="button" className="btn small" aria-label="Zoom out" onClick={() => zoomTo(span * 1.6)}>−</button>
            <button type="button" className="btn small" aria-label="Zoom in" onClick={() => zoomTo(span / 1.6)}>+</button>
          </div>
          <Timeline duration={duration} peaks={ed.waveform} speech={ed.speech} minGap={s?.min_gap ?? 0.4}
            ranges={s?.ranges ?? []} selection={sel} time={time} view={view} onView={setView}
            onSeek={seek} onSelect={setSel} />
          <ClipList ed={ed} onPlay={playRange} />
        </section>

        <section className="preview-col" aria-label="Vertical preview">
          <Preview ed={ed} t={time} />
          <Stats ed={ed} />
        </section>

        <aside className="inspector" aria-label="Settings">
          <div className="tabs" role="tablist" aria-label="Settings sections">
            {(["cuts", "captions", "framing"] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === "cuts" ? "Cuts" : t === "captions" ? "Captions" : "Framing"}
              </button>
            ))}
          </div>
          {tab === "cuts" && <CutsPanel ed={ed} />}
          {tab === "captions" && <CaptionsPanel ed={ed} />}
          {tab === "framing" && <FramingPanel ed={ed} />}
          {!ed.lecture.has_transcript && tab === "captions" && (
            <p className="muted small pad">No full transcript: captions are transcribed from just your clips when you render.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
