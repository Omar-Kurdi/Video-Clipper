import { useEffect, useState } from "react";
import { api, type Range, type StyleData, type TextStyle } from "./api";
import type { Ed } from "./Editor";
import { fmt, parseTime, useDebounced } from "./util";

/* ---------- live 9:16 preview / rendered video ---------- */

export function Preview({ ed, t: at, width = 270 }: { ed: Ed; t: number; width?: number }) {
  const s = ed.short;
  // preview a moment that is actually in the short when the playhead is elsewhere
  const inShort = s?.ranges.some(([a, b]) => at >= a && at <= b);
  const t = !s?.ranges.length || inShort ? at : s.ranges[0][0] + 0.5;
  const [tab, setTab] = useState<"look" | "rendered">(s?.rendered ? "rendered" : "look");
  const [img, setImg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = useDebounced(JSON.stringify({ t: Math.round(t * 4) / 4, style: s?.style, style_data: s?.style_data,
    title: s?.title, zoom: s?.zoom, captions: s?.captions }), 350);

  const sid = s?.id;
  useEffect(() => { setTab(s?.rendered ? "rendered" : "look"); }, [sid, ed.renderedVersion, s?.rendered]);
  useEffect(() => {
    if (tab !== "look" || !sid) return;
    let live = true;
    setLoading(true);
    api.preview(ed.lecture.id, JSON.parse(key)).then((url) => {
      if (!live) return URL.revokeObjectURL(url);
      setImg((old) => { if (old) URL.revokeObjectURL(old); return url; });
    }).catch(() => {}).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [key, tab, ed.lecture.id, sid]);

  const height = Math.round((width * 16) / 9);
  return (
    <div className="preview">
      <div className="seg small" role="tablist" aria-label="Preview">
        <button type="button" role="tab" aria-selected={tab === "look"} onClick={() => setTab("look")}>Look at {fmt(t, 0)}</button>
        <button type="button" role="tab" aria-selected={tab === "rendered"} disabled={!s?.rendered} onClick={() => setTab("rendered")}>Rendered</button>
      </div>
      <div className="phone-frame" style={{ width, height }}>
        {tab === "rendered" && s?.rendered ? (
          <video key={ed.renderedVersion} src={api.shortVideoUrl(ed.lecture.id, s.id, ed.renderedVersion)} controls playsInline />
        ) : img ? (
          <img src={img} alt="Preview of the short at the current time" className={loading ? "loading" : ""} />
        ) : (
          <div className="ph">Loading preview…</div>
        )}
      </div>
      {tab === "rendered" && s?.rendered && (
        <a className="btn block" href={api.shortVideoUrl(ed.lecture.id, s.id) + "?download=true"} download>Download MP4</a>
      )}
    </div>
  );
}

/* ---------- estimate tiles ---------- */

export function Stats({ ed }: { ed: Ed }) {
  const e = ed.estimate;
  return (
    <div className="stats">
      <div><b>{e ? fmt(e.selected, 0) : "0:00"}</b><span>selected</span></div>
      <div><b className="good">{e ? fmt(e.duration, 0) : "0:00"}</b><span>after cuts</span></div>
      <div><b>{e ? e.cuts : 0}</b><span>pause cuts</span></div>
    </div>
  );
}

/* ---------- ranges of the current short ---------- */

function TimeField({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState(fmt(value, 2));
  useEffect(() => setText(fmt(value, 2)), [value]);
  return (
    <input className="time" aria-label={label} value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => { const v = parseTime(text); if (v != null) onChange(v); else setText(fmt(value, 2)); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

export function ClipList({ ed, onPlay }: { ed: Ed; onPlay: (r: Range) => void }) {
  const s = ed.short;
  if (!s) return null;
  const set = (i: number, r: Range) => {
    const ranges = s.ranges.map((x, k) => (k === i ? ([Math.min(r[0], r[1]), Math.max(r[0], r[1])] as Range) : x));
    ed.update({ ranges });
  };
  return (
    <div className="clips">
      <div className="clips-head">
        <label className="name-edit">
          <span className="sr">Short name</span>
          <input value={s.name} onChange={(e) => ed.update({ name: e.target.value })} />
        </label>
        <span className="muted">{s.ranges.length} clip{s.ranges.length === 1 ? "" : "s"}</span>
      </div>
      {s.ranges.length === 0 && <p className="muted small">No clips yet. Select a moment and add it.</p>}
      <ol className="clip-list">
        {s.ranges.map((r, i) => (
          <li key={i}>
            <span className="idx">{i + 1}</span>
            <TimeField label={`Clip ${i + 1} start`} value={r[0]} onChange={(v) => set(i, [v, r[1]])} />
            <span aria-hidden="true">–</span>
            <TimeField label={`Clip ${i + 1} end`} value={r[1]} onChange={(v) => set(i, [r[0], v])} />
            <span className="muted">{(r[1] - r[0]).toFixed(1)}s</span>
            <button type="button" className="icon" aria-label={`Play clip ${i + 1}`} onClick={() => onPlay(r)}>▶</button>
            <button type="button" className="icon" aria-label={`Remove clip ${i + 1}`} onClick={() => ed.update({ ranges: s.ranges.filter((_, k) => k !== i) })}>✕</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- cuts ---------- */

export function CutsPanel({ ed }: { ed: Ed }) {
  const s = ed.short;
  if (!s) return null;
  const ms = Math.round((s.transition_frames / (ed.lecture.fps || 25)) * 1000);
  return (
    <div className="panel">
      <div className="row"><label htmlFor="gap">Cut pauses longer than</label><span className="val">{s.min_gap.toFixed(2)} s</span></div>
      <input id="gap" type="range" min={0.2} max={1.5} step={0.05} value={s.min_gap} onChange={(e) => ed.update({ min_gap: +e.target.value })} />
      <fieldset>
        <legend>Transition at each cut</legend>
        <div className="seg fill">
          {(["morph", "fade", "cut"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={s.transition === t} onClick={() => ed.update({ transition: t })}>
              {t === "morph" ? "Morph" : t === "fade" ? "Fade" : "Jump cut"}
            </button>
          ))}
        </div>
      </fieldset>
      {s.transition !== "cut" && <>
        <div className="row"><label htmlFor="len">Length</label><span className="val">{s.transition_frames} frames · {ms} ms</span></div>
        <input id="len" type="range" min={2} max={10} step={1} value={s.transition_frames} onChange={(e) => ed.update({ transition_frames: +e.target.value })} />
      </>}
      <p className="muted small">Camera changes are always clean hard cuts, with the crop switching on the exact frame.</p>
    </div>
  );
}

/* ---------- framing ---------- */

export function FramingPanel({ ed }: { ed: Ed }) {
  const s = ed.short;
  if (!s) return null;
  return (
    <div className="panel">
      <div className="row"><label htmlFor="zoom">Zoom</label><span className="val">{s.zoom.toFixed(2)}×</span></div>
      <input id="zoom" type="range" min={1} max={1.6} step={0.05} value={s.zoom} onChange={(e) => ed.update({ zoom: +e.target.value })} />
      <label className="check"><input type="checkbox" checked={s.grade} onChange={(e) => ed.update({ grade: e.target.checked })} />Colour grade (contrast, sharpen, vignette)</label>
      <p className="muted small">The 9:16 frame follows the speaker's face automatically.</p>
    </div>
  );
}

/* ---------- captions & name plate ---------- */

const PRESET_LABEL: Record<string, string> = { box: "Box", pill: "Pill", outline: "Outline", minimal: "Minimal" };

function effectiveData(ed: Ed): StyleData {
  const s = ed.short!;
  if (s.style_data) return s.style_data;
  const custom = ed.styles?.custom[s.style];
  return custom ?? { base: s.style };
}

function effectiveCaption(ed: Ed): TextStyle | null {
  if (!ed.styles) return null;
  const d = effectiveData(ed);
  const base = ed.styles.presets[d.base ?? "box"] ?? ed.styles.presets.box;
  return { ...base.captions, ...(d.captions ?? {}) };
}

export function CaptionsPanel({ ed, compact }: { ed: Ed; compact?: boolean }) {
  const s = ed.short;
  if (!s || !ed.styles) return null;
  const cap = effectiveCaption(ed)!;
  const data = effectiveData(ed);
  const names = [...Object.keys(ed.styles.presets), ...Object.keys(ed.styles.custom)];

  const patch = (p: Partial<TextStyle>) =>
    ed.update({ style_data: { ...data, base: data.base ?? (s.style in ed.styles!.presets ? s.style : "box"), captions: { ...(data.captions ?? {}), ...p } } });

  return (
    <div className="panel">
      <label className="check"><input type="checkbox" checked={s.captions} onChange={(e) => ed.update({ captions: e.target.checked })} />Burn in captions</label>
      <div className="presets" role="radiogroup" aria-label="Caption style">
        {names.map((n) => (
          <button key={n} type="button" role="radio" aria-label={`${PRESET_LABEL[n] ?? n} style`} aria-checked={s.style === n && !s.style_data}
            className={`preset preset-${n in PRESET_LABEL ? n : "custom"}`} onClick={() => ed.update({ style: n, style_data: null })}>
            <span>{PRESET_LABEL[n] ?? n}</span>
          </button>
        ))}
      </div>
      {s.style_data && <p className="muted small">Customised from {PRESET_LABEL[data.base ?? "box"] ?? data.base}. <button type="button" className="link" onClick={() => ed.update({ style_data: null })}>Reset</button></p>}
      <label className="field">Name plate
        <input dir="auto" value={s.title ?? ""} placeholder="e.g. speaker name" onChange={(e) => ed.update({ title: e.target.value || null })} />
      </label>
      {(
        <details open={!compact}>
          <summary>Customise look</summary>
          <div className="grid2">
            <label className="field">Text<input type="color" value={cap.color} onChange={(e) => patch({ color: e.target.value })} /></label>
            <label className="field">Spoken word
              <span className="inline">
                <input type="checkbox" aria-label="Highlight the spoken word" checked={!!cap.highlight} onChange={(e) => patch({ highlight: e.target.checked ? "#FFD54A" : null })} />
                <input type="color" disabled={!cap.highlight} value={cap.highlight ?? "#FFD54A"} onChange={(e) => patch({ highlight: e.target.value })} />
              </span>
            </label>
            <label className="field">Background
              <span className="inline">
                <input type="checkbox" aria-label="Show background box" checked={cap.box} onChange={(e) => patch({ box: e.target.checked })} />
                <input type="color" disabled={!cap.box} value={cap.box_color} onChange={(e) => patch({ box_color: e.target.value })} />
              </span>
            </label>
            <label className="field">Opacity {Math.round(cap.box_opacity * 100)}%<input type="range" min={0} max={1} step={0.05} value={cap.box_opacity} disabled={!cap.box} onChange={(e) => patch({ box_opacity: +e.target.value })} /></label>
            <label className="field">Size {cap.size}<input type="range" min={36} max={110} step={2} value={cap.size} onChange={(e) => patch({ size: +e.target.value })} /></label>
            <label className="field">Corners {cap.radius}<input type="range" min={0} max={60} step={2} value={cap.radius} onChange={(e) => patch({ radius: +e.target.value })} /></label>
            <label className="field">Outline {cap.outline}<input type="range" min={0} max={12} step={1} value={cap.outline} onChange={(e) => patch({ outline: +e.target.value })} /></label>
            <label className="field">Position {Math.round(cap.y * 100)}%<input type="range" min={0.3} max={0.9} step={0.01} value={cap.y} onChange={(e) => patch({ y: +e.target.value })} /></label>
            <label className="field">Words per caption {cap.max_words}<input type="range" min={1} max={6} step={1} value={cap.max_words} onChange={(e) => patch({ max_words: +e.target.value, max_chars: 8 * +e.target.value })} /></label>
            <label className="field">Font
              <select value={cap.font} onChange={(e) => { patch({ font: e.target.value }); }}>
                <option value="Noto Sans Arabic:style=Bold">Noto Sans Arabic Bold</option>
                <option value="Noto Naskh Arabic:style=Bold">Noto Naskh Arabic Bold</option>
                <option value="Vazirmatn:style=Bold">Vazirmatn Bold</option>
                <option value="Amiri:style=Bold">Amiri Bold</option>
              </select>
            </label>
          </div>
          <button type="button" className="btn small" disabled={!s.style_data} onClick={async () => {
            const name = prompt("Save this look as (letters, digits, - and _):", "my-style");
            if (!name) return;
            await api.saveStyle(name, effectiveData(ed));
            ed.refreshStyles();
            ed.update({ style: name, style_data: null });
          }}>Save as my style</button>
        </details>
      )}
    </div>
  );
}
