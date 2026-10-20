import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, defaultSettings, type Estimate, type Job, type Lecture, type Range, type Short,
  type ShortSettings, type Styles, type Transcript,
} from "./api";
import { go } from "./main";
import { Studio } from "./Studio";
import { Read } from "./Read";
import { useDebounced, useInterval } from "./util";

export type Mode = "studio" | "read";

export interface Ed {
  lecture: Lecture;
  shorts: Short[];
  short: Short | null;
  update: (patch: Partial<ShortSettings>) => void;
  addRange: (r: Range) => void;
  selectShort: (id: string) => void;
  newShort: (ranges?: Range[]) => Promise<void>;
  removeShort: (id: string) => Promise<void>;
  transcript: Transcript | null;
  waveform: { rate: number; peaks: number[] } | null;
  speech: Range[];
  styles: Styles | null;
  refreshStyles: () => void;
  estimate: Estimate | null;
  jobs: Job[];
  renderJob: Job | null;
  render: () => Promise<void>;
  transcribe: () => Promise<void>;
  transcribeJob: Job | null;
  renderedVersion: number;
  time: number;
  setTime: (t: number) => void;
}

const settingsOf = (s: Short): ShortSettings => ({
  name: s.name, ranges: s.ranges, title: s.title, style: s.style, style_data: s.style_data,
  min_gap: s.min_gap, transition: s.transition, transition_frames: s.transition_frames,
  zoom: s.zoom, grade: s.grade, captions: s.captions,
});

export function Editor({ lectureId, mode, shortId }: { lectureId: string; mode: Mode; shortId?: string }) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [shorts, setShorts] = useState<Short[]>([]);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [waveform, setWaveform] = useState<Ed["waveform"]>(null);
  const [speech, setSpeech] = useState<Range[]>([]);
  const [styles, setStyles] = useState<Styles | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [renderedVersion, setRenderedVersion] = useState(Date.now());
  const dirty = useRef<Set<string>>(new Set());

  const current = shorts.find((s) => s.id === shortId) ?? shorts[0] ?? null;

  const loadTranscript = useCallback(() => api.transcript(lectureId).then(setTranscript).catch(() => setTranscript(null)), [lectureId]);
  const refreshStyles = useCallback(() => { api.styles().then(setStyles).catch(() => {}); }, []);

  useEffect(() => {
    api.lecture(lectureId).then(setLecture).catch((e) => setError(e.message));
    api.waveform(lectureId).then(setWaveform).catch(() => {});
    api.speech(lectureId).then(setSpeech).catch(() => {});
    loadTranscript();
    refreshStyles();
    api.shorts(lectureId).then(async (list) => {
      if (!list.length) list = [await api.createShort(lectureId, defaultSettings())];
      setShorts(list);
    });
  }, [lectureId, loadTranscript, refreshStyles]);

  // ----- jobs -----
  const pollJobs = useCallback(async () => {
    const next = await api.jobs(lectureId).catch(() => null);
    if (!next) return;
    setJobs((prev) => {
      for (const j of next) {
        const before = prev.find((p) => p.id === j.id);
        if (j.status === "done" && before && before.status !== "done") {
          if (j.kind === "transcribe") { loadTranscript(); api.lecture(lectureId).then(setLecture); }
          if (j.kind === "render") {
            setRenderedVersion(Date.now());
            api.shorts(lectureId).then((list) => setShorts((cur) => cur.map((c) => {
              const fresh = list.find((l) => l.id === c.id);
              return fresh && !dirty.current.has(c.id) ? fresh : fresh ? { ...c, rendered: fresh.rendered, last_render: fresh.last_render } : c;
            })));
          }
        }
      }
      return next;
    });
  }, [lectureId, loadTranscript]);
  useEffect(() => { pollJobs(); }, [pollJobs]);
  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
  useInterval(pollJobs, busy ? 1000 : 6000);

  // ----- editing the current short (optimistic + debounced save) -----
  const update = useCallback((patch: Partial<ShortSettings>) => {
    if (!current) return;
    dirty.current.add(current.id);
    setShorts((list) => list.map((s) => (s.id === current.id ? { ...s, ...patch } : s)));
  }, [current]);

  const settingsKey = current ? JSON.stringify(settingsOf(current)) : "";
  const debouncedKey = useDebounced(settingsKey, 500);
  useEffect(() => {
    if (!current || !debouncedKey || !dirty.current.has(current.id)) return;
    dirty.current.delete(current.id);
    api.updateShort(lectureId, current.id, JSON.parse(debouncedKey)).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedKey]);

  // estimate follows the cut-relevant settings only
  const estKey = current ? JSON.stringify([current.ranges, current.min_gap, current.transition_frames]) : "";
  const debouncedEst = useDebounced(estKey, 400);
  useEffect(() => {
    if (!current) return;
    if (!current.ranges.length) { setEstimate(null); return; }
    let live = true;
    api.estimate(lectureId, settingsOf(current)).then((e) => live && setEstimate(e)).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedEst, lectureId]);

  const ed = useMemo<Ed | null>(() => {
    if (!lecture) return null;
    const renderJob = current ? jobs.find((j) => j.short_id === current.id && (j.status === "queued" || j.status === "running")) ?? null : null;
    return {
      lecture, shorts, short: current, update,
      addRange: (r) => {
        if (!current) return;
        const ranges = [...current.ranges, r].sort((a, b) => a[0] - b[0]);
        update({ ranges });
      },
      selectShort: (id) => go({ page: "editor", lecture: lectureId, mode, short: id }),
      newShort: async (ranges = []) => {
        const s = await api.createShort(lectureId, { ...defaultSettings(`Short ${shorts.length + 1}`), ranges,
          ...(current ? { style: current.style, style_data: current.style_data, title: current.title } : {}) });
        setShorts((l) => [...l, s]);
        go({ page: "editor", lecture: lectureId, mode, short: s.id });
      },
      removeShort: async (id) => {
        await api.deleteShort(lectureId, id);
        setShorts((l) => l.filter((s) => s.id !== id));
        go({ page: "editor", lecture: lectureId, mode });
      },
      transcript, waveform, speech, styles, refreshStyles, estimate, jobs, renderJob,
      render: async () => {
        if (!current) return;
        // save pending edits first so the render uses them
        dirty.current.delete(current.id);
        await api.updateShort(lectureId, current.id, settingsOf(current));
        await api.render(lectureId, current.id).catch((e) => setError(e.message));
        pollJobs();
      },
      transcribe: async () => { await api.transcribe(lectureId).catch((e) => setError(e.message)); pollJobs(); },
      transcribeJob: jobs.find((j) => j.kind === "transcribe" && (j.status === "queued" || j.status === "running")) ?? null,
      renderedVersion, time, setTime,
    };
  }, [lecture, shorts, current, update, transcript, waveform, speech, styles, refreshStyles, estimate, jobs,
    renderedVersion, time, lectureId, mode, pollJobs]);

  if (error && !lecture) return <div className="fatal"><p>{error}</p><a href="#/">Back to library</a></div>;
  if (!ed) return <div className="fatal"><p>Loading…</p></div>;

  return (
    <>
      {error && <div className="toast" role="alert" onClick={() => setError(null)}>{error} <button type="button" aria-label="Dismiss">✕</button></div>}
      {mode === "studio" ? <Studio ed={ed} /> : <Read ed={ed} />}
    </>
  );
}

/** Shared top bar: brand, lecture, mode switch, short picker, render. */
export function TopBar({ ed, mode }: { ed: Ed; mode: Mode }) {
  const { lecture, shorts, short } = ed;
  const failed = ed.jobs.find((j) => j.short_id === short?.id && j.status === "error" && j.kind === "render");
  return (
    <header className="topbar">
      <a href="#/" className="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10 9.5l4 2.5-4 2.5z" fill="currentColor" /></svg>
        Lecture Shorts
      </a>
      <span className="crumb" dir="auto">{lecture.title}</span>
      <div className="seg" role="group" aria-label="Editing mode">
        <a href={`#/l/${lecture.id}/studio${short ? `/${short.id}` : ""}`} aria-current={mode === "studio" ? "page" : undefined}>Studio</a>
        <a href={`#/l/${lecture.id}/read${short ? `/${short.id}` : ""}`} aria-current={mode === "read" ? "page" : undefined}>Transcript</a>
      </div>
      <span className="grow" />
      <label className="short-pick">
        <span className="sr">Current short</span>
        <select value={short?.id ?? ""} onChange={(e) => (e.target.value === "__new" ? ed.newShort() : ed.selectShort(e.target.value))}>
          {shorts.map((s) => <option key={s.id} value={s.id}>{s.name} {s.rendered ? "✓" : ""}</option>)}
          <option value="__new">+ New short</option>
        </select>
      </label>
      {failed && <span className="bad" title={failed.message}>Last render failed</span>}
      <RenderButton ed={ed} />
    </header>
  );
}

export function RenderButton({ ed, block }: { ed: Ed; block?: boolean }) {
  const j = ed.renderJob;
  if (j) {
    return (
      <div className={`render-progress ${block ? "block" : ""}`} role="status">
        <span>{j.status === "queued" ? "Queued…" : `${j.stage || "rendering"} ${Math.round(j.progress * 100)}%`}</span>
        <progress max={1} value={j.progress} />
      </div>
    );
  }
  return (
    <button type="button" className={`btn primary ${block ? "block" : ""}`} disabled={!ed.short?.ranges.length} onClick={ed.render}>
      Render {ed.short?.name ?? "short"}
    </button>
  );
}
