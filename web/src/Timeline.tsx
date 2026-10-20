import { useEffect, useRef, useState } from "react";
import type { Range } from "./api";
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
}

const C = {
  bg: "#15181B", wave: "#5D6670", waveSel: "#F2B544", pause: "#2A2F35", range: "rgba(242,181,68,0.22)",
  rangeEdge: "#F2B544", sel: "rgba(111,182,255,0.22)", selEdge: "#6FB6FF", head: "#FFFFFF", tick: "#6E7680",
};

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
  const H = 120, OH = 26;
  const [v0, v1] = p.view;
  const xOf = (t: number) => ((t - v0) / (v1 - v0)) * W;
  const tOf = (x: number) => v0 + (x / W) * (v1 - v0);

  // ----- draw main -----
  useEffect(() => {
    const cv = main.current;
    if (!cv) return;
    const ctx = setup(cv, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const top = 18, bot = H - 6, mid = (top + bot) / 2, amp = (bot - top) / 2;

    // ruler
    const step = tickStep(v1 - v0, W);
    ctx.fillStyle = C.tick;
    ctx.font = "11px 'IBM Plex Mono', monospace";
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
    // short's ranges
    for (const [a, b] of p.ranges) {
      if (b < v0 || a > v1) continue;
      ctx.fillStyle = C.range;
      ctx.fillRect(xOf(a), top, xOf(b) - xOf(a), bot - top);
      ctx.fillStyle = C.rangeEdge;
      ctx.fillRect(xOf(a), top, 2, bot - top);
      ctx.fillRect(xOf(b) - 2, top, 2, bot - top);
    }
    // waveform
    if (p.peaks) {
      const { rate, peaks } = p.peaks;
      for (let x = 0; x < W; x += 2) {
        const i0 = Math.floor(tOf(x) * rate), i1 = Math.max(i0 + 1, Math.ceil(tOf(x + 2) * rate));
        let m = 0;
        for (let i = Math.max(0, i0); i < Math.min(peaks.length, i1); i++) m = Math.max(m, peaks[i]);
        const t = tOf(x + 1);
        const inRange = p.ranges.some(([a, b]) => t >= a && t <= b);
        ctx.fillStyle = inRange ? C.waveSel : C.wave;
        const h = Math.max(1, (m / 100) * amp);
        ctx.fillRect(x, mid - h, 1.4, h * 2);
      }
    }
    // pending selection
    if (p.selection) {
      const [a, b] = p.selection;
      ctx.fillStyle = C.sel;
      ctx.fillRect(xOf(a), top - 4, xOf(b) - xOf(a), bot - top + 8);
      ctx.fillStyle = C.selEdge;
      ctx.fillRect(xOf(a) - 1, top - 4, 3, bot - top + 8);
      ctx.fillRect(xOf(b) - 2, top - 4, 3, bot - top + 8);
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
    ctx.fillStyle = "#101214";
    ctx.fillRect(0, 0, W, OH);
    const X = (t: number) => (t / p.duration) * W;
    if (p.peaks) {
      const { rate, peaks } = p.peaks;
      const per = peaks.length / W;
      ctx.fillStyle = "#3A4148";
      for (let x = 0; x < W; x++) {
        let m = 0;
        for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) m = Math.max(m, peaks[i] ?? 0);
        const h = (m / 100) * (OH / 2 - 2);
        ctx.fillRect(x, OH / 2 - h, 1, h * 2);
      }
      void rate;
    }
    ctx.fillStyle = C.rangeEdge;
    for (const [a, b] of p.ranges) ctx.fillRect(X(a), OH - 4, Math.max(2, X(b) - X(a)), 4);
    ctx.strokeStyle = "#C9CED4";
    ctx.lineWidth = 1;
    ctx.strokeRect(X(v0) + 0.5, 0.5, Math.max(4, X(v1) - X(v0)) - 1, OH - 1);
    ctx.fillStyle = C.head;
    ctx.fillRect(X(p.time), 0, 1, OH);
  });

  // ----- interaction -----
  const localX = (e: { clientX: number; currentTarget: Element }) =>
    e.clientX - e.currentTarget.getBoundingClientRect().left;
  const drag = useRef<{ kind: "new" | "start" | "end"; anchor: number; x0: number; moved: boolean } | null>(null);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const t = tOf(x);
    let kind: "new" | "start" | "end" = "new";
    if (p.selection) {
      if (Math.abs(x - xOf(p.selection[0])) < 7) kind = "start";
      else if (Math.abs(x - xOf(p.selection[1])) < 7) kind = "end";
    }
    drag.current = { kind, anchor: kind === "start" ? p.selection![1] : kind === "end" ? p.selection![0] : t, x0: x, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const x = localX(e);
    if (!d) {
      const near = p.selection && (Math.abs(x - xOf(p.selection[0])) < 7 || Math.abs(x - xOf(p.selection[1])) < 7);
      e.currentTarget.style.cursor = near ? "ew-resize" : "crosshair";
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
    if (!d) return;
    const x = localX(e);
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
  const overDrag = useRef(false);
  const overSet = (x: number) => {
    const span = v1 - v0;
    const c = (x / W) * p.duration;
    const a = clamp(c - span / 2, 0, Math.max(0, p.duration - span));
    p.onView([a, a + span]);
  };

  return (
    <div ref={wrap} className="timeline">
      <canvas ref={over} className="overview" aria-label="Whole lecture overview"
        onPointerDown={(e) => { overDrag.current = true; e.currentTarget.setPointerCapture(e.pointerId); overSet(localX(e)); }}
        onPointerMove={(e) => overDrag.current && overSet(localX(e))}
        onPointerUp={() => { overDrag.current = false; }} />
      <canvas ref={main} className="wave" aria-label="Timeline: drag to select, click to seek, Ctrl+scroll to zoom"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
    </div>
  );
}
