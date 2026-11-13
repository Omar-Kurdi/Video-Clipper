import { useEffect, useRef, useState } from "react";
import type { Caption, Range } from "./api";
import { clamp, fmt, pausesIn } from "./util";

interface Props {
  duration: number;
  peaks: { rate: number; peaks: number[] } | null;
  speech: Range[];
  minGap: number;
  ranges: Range[];
  selection: Range | null;
  time: number;
  view: Range;
  onView: (v: Range) => void;
  onSeek: (t: number) => void;
  onSelect: (r: Range | null) => void;
  /** the short's captions, shown as a track under the waveform (lecture time) */
  captions?: Caption[];
  captionKey?: number | null;
  onCaption?: (c: Caption) => void;
  onCaptionOpen?: (c: Caption) => void;
  onCaptionTime?: (c: Caption, r: Range) => void;
  /** a clip of the short made longer or shorter by dragging its edge (once, when let go) */
  onRangeChange?: (i: number, r: Range) => void;
}

// the editor's inks (see styles.css): red is what's in the short, hatching is a selection not added yet
const C = {
  bg: "#141D19", wave: "#55625B", waveSel: "#EF5A43", pause: "#0F1613", range: "rgba(239,90,67,0.12)",
  rangeEdge: "#EF5A43", hatch: "rgba(227,232,228,0.16)", selEdge: "#E3E8E4", head: "#FFFFFF", tick: "#93A09A",
  rulerBg: "#1A2420", overBg: "#0F1613", overWave: "#2F3B36", overBox: "#C2CBC6",
};

/** Pencil hatching for the pending selection. */
let hatchTile: HTMLCanvasElement | null = null;
function hatch(ctx: CanvasRenderingContext2D) {
  if (!hatchTile) {
    hatchTile = document.createElement("canvas");
    hatchTile.width = hatchTile.height = 6;
    const t = hatchTile.getContext("2d")!;
    t.strokeStyle = C.hatch;
    t.lineWidth = 1.5;
    t.beginPath();
    t.moveTo(0, 6); t.lineTo(6, 0);
    t.moveTo(-1, 1); t.lineTo(1, -1);
    t.moveTo(5, 7); t.lineTo(7, 5);
    t.stroke();
  }
  return ctx.createPattern(hatchTile, "repeat")!;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function setup(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function tickStep(span: number, w: number) {
  const target = span / (w / 90);
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].find((s) => s >= target) ?? 3600;
}

export function Timeline(p: Props) {
  const [wrap, W] = useWidth<HTMLDivElement>();
  const main = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const H = 132, OH = 24;
  const [v0, v1] = p.view;
  const xOf = (t: number) => ((t - v0) / (v1 - v0)) * W;
  const tOf = (x: number) => v0 + (x / W) * (v1 - v0);
  // a clip's edge being dragged: drawn from here until it's let go and saved
  const [live, setLive] = useState<Range[] | null>(null);
  const ranges = live ?? p.ranges;

  // ----- draw main -----
  useEffect(() => {
    const cv = main.current;
    if (!cv) return;
    const ctx = setup(cv, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const top = 32, bot = H - 6, mid = (top + bot) / 2, amp = (bot - top) / 2;

    // ruler
    const step = tickStep(v1 - v0, W);
    ctx.fillStyle = C.rulerBg;
    ctx.fillRect(0, 0, W, 17);
    ctx.fillStyle = C.tick;
    ctx.font = "10px 'Spline Sans Mono', monospace";
    for (let t = Math.ceil(v0 / step) * step; t < v1; t += step) {
      const x = xOf(t);
      ctx.fillRect(x, 0, 1, 6);
      ctx.fillText(fmt(t, step < 1 ? 1 : 0), x + 3, 12);
    }

    // pauses that would be cut
    for (const [a, b] of pausesIn(p.speech, p.minGap, v0, v1)) {
      ctx.fillStyle = C.pause;
      ctx.fillRect(xOf(a), top, Math.max(1, xOf(b) - xOf(a)), bot - top);
    }
    // short's ranges: a faint wash and a red track along the top, numbered in order
    ctx.font = "500 10px 'Spline Sans Mono', monospace";
    ranges.forEach(([a, b], i) => {
      if (b < v0 || a > v1) return;
      ctx.fillStyle = C.range;
      ctx.fillRect(xOf(a), top, xOf(b) - xOf(a), bot - top);
      ctx.fillStyle = C.rangeEdge;
      ctx.fillRect(xOf(a), top - 14, Math.max(2, xOf(b) - xOf(a)), 11);
      if (xOf(b) - xOf(a) > 16) {
        ctx.fillStyle = "#1A0703";
        ctx.fillText(String(i + 1), Math.max(0, xOf(a)) + 4, top - 5);
      }
    });
    ctx.font = "10px 'Spline Sans Mono', monospace";
    // waveform
    if (p.peaks) {
      const { rate, peaks } = p.peaks;
      for (let x = 0; x < W; x += 2) {
        const i0 = Math.floor(tOf(x) * rate), i1 = Math.max(i0 + 1, Math.ceil(tOf(x + 2) * rate));
        let m = 0;
        for (let i = Math.max(0, i0); i < Math.min(peaks.length, i1); i++) m = Math.max(m, peaks[i]);
        const t = tOf(x + 1);
        const inRange = ranges.some(([a, b]) => t >= a && t <= b);
        ctx.fillStyle = inRange ? C.waveSel : C.wave;
        const h = Math.max(1, (m / 100) * amp);
        ctx.fillRect(x, mid - h, 1.4, h * 2);
      }
    }
    // pending selection
    if (p.selection) {
      const [a, b] = p.selection;
      ctx.fillStyle = hatch(ctx);
      ctx.fillRect(xOf(a), top - 4, xOf(b) - xOf(a), bot - top + 8);
      ctx.strokeStyle = C.selEdge;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(xOf(a) + 0.5, top - 3.5, xOf(b) - xOf(a) - 1, bot - top + 7);
      ctx.setLineDash([]);
      ctx.fillStyle = C.selEdge;
      ctx.fillRect(xOf(a) - 1, mid - 8, 3, 16);
      ctx.fillRect(xOf(b) - 2, mid - 8, 3, 16);
    }
    // playhead
    ctx.fillStyle = C.head;
    ctx.fillRect(xOf(p.time) - 1, 0, 2, H);
  });

  // ----- draw overview -----
  useEffect(() => {
    const cv = over.current;
    if (!cv || !p.duration) return;
    const ctx = setup(cv, W, OH);
    ctx.fillStyle = C.overBg;
    ctx.fillRect(0, 0, W, OH);
    const X = (t: number) => (t / p.duration) * W;
    if (p.peaks) {
      const { rate, peaks } = p.peaks;
      const per = peaks.length / W;
      ctx.fillStyle = C.overWave;
      for (let x = 0; x < W; x++) {
        let m = 0;
        for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) m = Math.max(m, peaks[i] ?? 0);
        const h = (m / 100) * (OH / 2 - 2);
        ctx.fillRect(x, OH / 2 - h, 1, h * 2);
      }
      void rate;
    }
    ctx.fillStyle = C.rangeEdge;
    for (const [a, b] of ranges) ctx.fillRect(X(a), OH - 4, Math.max(2, X(b) - X(a)), 4);
    ctx.strokeStyle = C.overBox;
    ctx.lineWidth = 1;
    ctx.strokeRect(X(v0) + 0.5, 0.5, Math.max(4, X(v1) - X(v0)) - 1, OH - 1);
    ctx.fillStyle = C.head;
    ctx.fillRect(X(p.time), 0, 1, OH);
  });

  // ----- interaction -----
  const localX = (e: { clientX: number; currentTarget: Element }) =>
    e.clientX - e.currentTarget.getBoundingClientRect().left;
  // the ruler (the times along the top) scrubs: press and move to show that moment, nothing is selected
  const RULER = 18;
  const inRuler = (e: { clientY: number; currentTarget: Element }) =>
    e.clientY - e.currentTarget.getBoundingClientRect().top < RULER;
  const drag = useRef<{ kind: "new" | "start" | "end" | "scrub" | "clipStart" | "clipEnd"; anchor: number; x0: number;
    moved: boolean; clip?: number } | null>(null);
  const EDGE = 7;  // px from an edge that grabs it
  /** The clip edge under x, if any: [clip, which end]. */
  const clipEdge = (x: number): [number, "clipStart" | "clipEnd"] | null => {
    if (!p.onRangeChange) return null;
    let best: [number, "clipStart" | "clipEnd"] | null = null, dist = EDGE;
    p.ranges.forEach(([a, b], i) => {
      if (Math.abs(x - xOf(a)) < dist) { dist = Math.abs(x - xOf(a)); best = [i, "clipStart"]; }
      if (Math.abs(x - xOf(b)) < dist) { dist = Math.abs(x - xOf(b)); best = [i, "clipEnd"]; }
    });
    return best;
  };
  /** Clip i with one end moved to t: at least half a second long, never across its neighbours. */
  const moved = (i: number, end: "clipStart" | "clipEnd", t: number): Range => {
    const [a, b] = p.ranges[i];
    const lo = i > 0 ? p.ranges[i - 1][1] : 0, hi = i < p.ranges.length - 1 ? p.ranges[i + 1][0] : p.duration;
    const r = (x: number) => Math.round(x * 100) / 100;
    return end === "clipStart" ? [r(clamp(t, lo, b - 0.5)), b] : [a, r(clamp(t, a + 0.5, hi))];
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const t = tOf(x);
    if (inRuler(e)) {
      drag.current = { kind: "scrub", anchor: t, x0: x, moved: false };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      p.onSeek(clamp(t, 0, p.duration));
      return;
    }
    let kind: "new" | "start" | "end" = "new";
    if (p.selection) {
      if (Math.abs(x - xOf(p.selection[0])) < EDGE) kind = "start";
      else if (Math.abs(x - xOf(p.selection[1])) < EDGE) kind = "end";
    }
    const edge = kind === "new" ? clipEdge(x) : null;
    if (edge) {
      drag.current = { kind: edge[1], anchor: t, x0: x, moved: false, clip: edge[0] };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      return;
    }
    drag.current = { kind, anchor: kind === "start" ? p.selection![1] : kind === "end" ? p.selection![0] : t, x0: x, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const x = localX(e);
    if (!d) {
      const near = p.selection && (Math.abs(x - xOf(p.selection[0])) < EDGE || Math.abs(x - xOf(p.selection[1])) < EDGE);
      const edge = !near && clipEdge(x);
      e.currentTarget.style.cursor = inRuler(e) ? "col-resize" : near || edge ? "ew-resize" : "crosshair";
      e.currentTarget.title = edge ? `Drag to make clip ${edge[0] + 1} ${edge[1] === "clipStart" ? "start" : "end"} earlier or later` : "";
      return;
    }
    if (d.kind === "scrub") { p.onSeek(clamp(tOf(x), 0, p.duration)); return; }
    if (d.kind === "clipStart" || d.kind === "clipEnd") {
      if (Math.abs(x - d.x0) > 2) d.moved = true;
      if (!d.moved) return;
      const r = moved(d.clip!, d.kind, tOf(x));
      setLive(p.ranges.map((x, k) => (k === d.clip ? r : x)));
      p.onSeek(d.kind === "clipStart" ? r[0] : r[1]);  // the video shows where the edge is
      return;
    }
    if (Math.abs(x - d.x0) > 3) d.moved = true;
    if (!d.moved) return;
    const t = clamp(tOf(x), 0, p.duration);
    p.onSelect([Math.min(d.anchor, t), Math.max(d.anchor, t)]);
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind === "scrub") return;
    const x = localX(e);
    if (d.kind === "clipStart" || d.kind === "clipEnd") {
      setLive(null);
      if (d.moved) p.onRangeChange?.(d.clip!, moved(d.clip!, d.kind, tOf(x)));
      else p.onSeek(clamp(tOf(x), 0, p.duration));
      return;
    }
    if (Math.abs(x - d.x0) > 3) d.moved = true;
    const t = clamp(tOf(x), 0, p.duration);
    if (d.moved) p.onSelect([Math.min(d.anchor, t), Math.max(d.anchor, t)]);
    else p.onSeek(t);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const span = v1 - v0;
    if (e.ctrlKey || e.metaKey) {
      const at = tOf(e.clientX - (e.currentTarget as Element).getBoundingClientRect().left);
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      const ns = clamp(span * f, 5, p.duration);
      const a = clamp(at - (at - v0) * (ns / span), 0, p.duration - ns);
      p.onView([a, a + ns]);
    } else {
      const dt = ((e.deltaX || e.deltaY) / W) * span;
      const a = clamp(v0 + dt, 0, Math.max(0, p.duration - span));
      p.onView([a, a + span]);
    }
  };
  // native listener: React's wheel handler is passive and can't stop page zoom/scroll
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const cv = main.current;
    if (!cv) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    cv.addEventListener("wheel", h, { passive: false });
    return () => cv.removeEventListener("wheel", h);
  }, []);
  // overview: click to jump there, drag the box to scroll the timeline
  const overDrag = useRef<{ x0: number; a0: number; moved: boolean; t: number; inBox: boolean } | null>(null);
  const overDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const x = localX(e);
    const t = clamp((x / W) * p.duration, 0, p.duration);
    const span = v1 - v0;
    const inBox = t >= v0 && t <= v1;
    let a = v0;
    if (!inBox) {
      p.onSeek(t);
      a = clamp(t - span / 2, 0, Math.max(0, p.duration - span));
      p.onView([a, a + span]);
    }
    overDrag.current = { x0: x, a0: a, moved: false, t, inBox };
  };
  const overMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = overDrag.current;
    if (!d) return;
    const x = localX(e);
    if (Math.abs(x - d.x0) > 3) d.moved = true;
    if (!d.moved) return;
    const span = v1 - v0;
    const a = clamp(d.a0 + ((x - d.x0) / W) * p.duration, 0, Math.max(0, p.duration - span));
    p.onView([a, a + span]);
  };
  const overUp = () => {
    const d = overDrag.current;
    overDrag.current = null;
    if (d && !d.moved && d.inBox) p.onSeek(d.t);
  };

  // ----- caption track: click to pick, double-click to edit, drag an edge to retime -----
  const [capDrag, setCapDrag] = useState<{ key: number; edge: 0 | 1; r: Range } | null>(null);
  const capRef = useRef(capDrag);
  capRef.current = capDrag;
  const shown = (p.captions ?? []).filter((c) => c.src[1] >= v0 && c.src[0] <= v1);

  return (
    <div ref={wrap} className="timeline">
      <canvas ref={over} className="overview" aria-label="Whole video overview"
        onPointerDown={overDown} onPointerMove={overMove} onPointerUp={overUp} />
      <canvas ref={main} className="wave" aria-label="Timeline: drag to select, drag a clip's edge to make it longer or shorter, click to seek, drag along the times at the top to scrub, Ctrl+scroll to zoom"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
      {!!p.captions?.length && (
        <div className="cap-track" aria-label="Captions: click to pick, double-click to edit, drag an edge to change when it shows">
          {shown.map((c, n) => {
            const r = capDrag?.key === c.key ? capDrag.r : c.src;
            const left = xOf(r[0]), width = Math.max(4, xOf(r[1]) - xOf(r[0]));
            const grab = (edge: 0 | 1) => (e: React.PointerEvent<HTMLSpanElement>) => {
              e.stopPropagation();
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
              setCapDrag({ key: c.key, edge, r: [...c.src] as Range });
            };
            const move = (e: React.PointerEvent<HTMLSpanElement>) => {
              const d = capRef.current;
              if (!d || d.key !== c.key) return;
              const box = (e.currentTarget.closest(".cap-track") as HTMLElement).getBoundingClientRect();
              const t = clamp(tOf(e.clientX - box.left), 0, p.duration);
              // stay between the neighbours: two captions never show at once
              const all = p.captions ?? [];
              const k = all.findIndex((x) => x.key === c.key);
              const lo = k > 0 ? all[k - 1].src[1] : 0, hi = k + 1 < all.length ? all[k + 1].src[0] : p.duration;
              const nr: Range = d.edge === 0 ? [clamp(t, lo, d.r[1] - 0.2), d.r[1]] : [d.r[0], clamp(t, d.r[0] + 0.2, hi)];
              setCapDrag({ ...d, r: nr });
            };
            const drop = () => {
              const d = capRef.current;
              setCapDrag(null);
              if (d && d.key === c.key && (d.r[0] !== c.src[0] || d.r[1] !== c.src[1])) p.onCaptionTime?.(c, d.r);
            };
            return (
              <div key={`${c.key}-${n}`} className={`cap-block ${c.key === p.captionKey ? "sel" : ""} ${c.timed ? "timed" : ""}`}
                style={{ left, width }} dir="auto" title={c.words.map((w) => w.w).join(" ")}
                onClick={() => p.onCaption?.(c)} onDoubleClick={() => p.onCaptionOpen?.(c)}>
                <span className="cap-edge l" onPointerDown={grab(0)} onPointerMove={move} onPointerUp={drop} />
                <span className="cap-words">{c.words.map((w) => w.w).join(" ")}</span>
                <span className="cap-edge r" onPointerDown={grab(1)} onPointerMove={move} onPointerUp={drop} />
              </div>
            );
          })}
          <i className="cap-head" style={{ left: xOf(p.time) }} />
        </div>
      )}
    </div>
  );
}
