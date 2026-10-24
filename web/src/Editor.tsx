import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, defaultSettings, type Cameras, type Estimate, type Job, type Lecture, type Range, type Short,
  type ShortSettings, type Styles, type Transcript, type Translation,
} from "./api";
import { go } from "./main";
import { Workspace } from "./Workspace";
import { useDebounced, useInterval } from "./util";

export type Mode = "edit";

// lectures opened since this page loaded; a reload starts every editor fresh
const opened = new Set<string>();

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
  transcribe: (engine?: string) => Promise<void>;
  transcribeJob: Job | null;
  /** the other language: English for an Arabic lecture, Arabic for an English one */
  translationLang: string;
  translation: Translation | null;
  translate: () => Promise<void>;
  editTranslation: (k: number, text: string) => Promise<void>;
  translateJob: Job | null;
  renderedVersion: number;
  cameras: Cameras | null;
  framingVersion: number;
  setFraming: (cid: number, manual: { x: number; y: number } | null) => Promise<void>;
  setCameraZoom: (cid: number, zoom: number | null) => Promise<void>;
  setFramingAt: (t: number, x: number) => Promise<void>;
  editSegment: (k: number, text: string | null) => Promise<void>;
  time: number;
  setTime: (t: number) => void;
}

const settingsOf = (s: Short): ShortSettings => ({
  name: s.name, ranges: s.ranges, title: s.title, style: s.style, style_data: s.style_data,
  min_gap: s.min_gap, transition: s.transition, transition_frames: s.transition_frames,
  zoom: s.zoom, grade: s.grade, captions: s.captions, speed: s.speed ?? 1, harakat: s.harakat ?? "all",
  caption_lang: s.caption_lang ?? "original", quran_tag: s.quran_tag ?? true,
});

export function Editor({ lectureId, mode, shortId }: { lectureId: string; mode: Mode; shortId?: string }) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [shorts, setShorts] = useState<Short[]>([]);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [waveform, setWaveform] = useState<Ed["waveform"]>(null);
  const [speech, setSpeech] = useState<Range[]>([]);
  const [styles, setStyles] = useState<Styles | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [renderedVersion, setRenderedVersion] = useState(Date.now());
  const [cameras, setCameras] = useState<Cameras | null>(null);
  const [framingVersion, setFramingVersion] = useState(0);
  const loadCameras = useCallback(() => api.cameras(lectureId).then(setCameras).catch(() => {}), [lectureId]);
  const dirty = useRef<Set<string>>(new Set());
  // previous session's shorts, hidden after a reload until restored or discarded
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visible = shorts.filter((s) => !hidden.has(s.id));
  const current = visible.find((s) => s.id === shortId) ?? visible[0] ?? null;

  const loadTranscript = useCallback(() => api.transcript(lectureId).then(setTranscript).catch(() => setTranscript(null)), [lectureId]);
  const translationLang = (transcript?.language ?? lecture?.language ?? "ar") === "en" ? "ar" : "en";
  const loadTranslation = useCallback(() => api.translation(lectureId, translationLang).then(setTranslation).catch(() => setTranslation(null)),
    [lectureId, translationLang]);
  useEffect(() => { loadTranslation(); }, [loadTranslation]);
  const refreshStyles = useCallback(() => { api.styles().then(setStyles).catch(() => {}); }, []);

  useEffect(() => {
    api.lecture(lectureId).then(setLecture).catch((e) => setError(e.message));
    api.waveform(lectureId).then(setWaveform).catch(() => {});
    api.speech(lectureId).then(setSpeech).catch(() => {});
    loadTranscript();
    refreshStyles();
    loadCameras();
    api.shorts(lectureId).then(async (list) => {
      const fresh = !opened.has(lectureId);
      opened.add(lectureId);
      const previous = fresh ? list.filter((s) => s.ranges.length || s.rendered) : [];
      let draft = list.find((s) => !s.ranges.length && !s.rendered);
      if (fresh && draft) draft = await api.updateShort(lectureId, draft.id, defaultSettings(draft.name));
      if (!draft) {
        draft = await api.createShort(lectureId, defaultSettings(`Short ${list.length + 1}`));
        list = [...list, draft];
      } else {
        list = list.map((s) => (s.id === draft!.id ? draft! : s));
      }
      setShorts(list);
      if (previous.length) {
        setHidden(new Set(previous.map((s) => s.id)));
        history.replaceState(null, "", `#/l/${lectureId}/${mode}/${draft.id}`);
        dispatchEvent(new HashChangeEvent("hashchange"));
      }
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
          if (j.kind === "translate") loadTranslation();
          if (j.kind === "cameras") { loadCameras(); setFramingVersion((v) => v + 1); }
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
  }, [lectureId, loadTranscript, loadCameras, loadTranslation]);
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
      lecture, shorts: visible, short: current, update,
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
      transcribe: async (engine = "tashkeel") => { await api.transcribe(lectureId, engine).catch((e) => setError(e.message)); pollJobs(); },
      transcribeJob: jobs.find((j) => j.kind === "transcribe" && (j.status === "queued" || j.status === "running")) ?? null,
      translationLang, translation,
      editTranslation: async (k, text) => {
        const t = await api.editTranslation(lectureId, translationLang, k, text).catch((e) => { setError(e.message); return null; });
        if (t) setTranslation(t);
      },
      translate: async () => { await api.translate(lectureId, translationLang).catch((e) => setError(e.message)); pollJobs(); },
      translateJob: jobs.find((j) => j.kind === "translate" && (j.status === "queued" || j.status === "running")) ?? null,
      renderedVersion, time, setTime, cameras, framingVersion,
      setFramingAt: async (t, x) => {
        const cam = await api.setFramingAt(lectureId, t, x).catch((e) => { setError(e.message); return null; });
        if (!cam) return;
        setCameras((c) => c && { ...c, cameras: c.cameras.map((y) => (y.id === cam.id ? cam : y)) });
        setFramingVersion((v) => v + 1);
      },
      setCameraZoom: async (cid, zoom) => {
        const cam = await api.setCameraZoom(lectureId, cid, zoom).catch((e) => { setError(e.message); return null; });
        if (!cam) return;
        setCameras((c) => c && { ...c, cameras: c.cameras.map((x) => (x.id === cid ? cam : x)) });
        setFramingVersion((v) => v + 1);
      },
      setFraming: async (cid, manual) => {
        const cam = await api.setFraming(lectureId, cid, manual).catch((e) => { setError(e.message); return null; });
        if (!cam) return;
        setCameras((c) => c && { ...c, cameras: c.cameras.map((x) => (x.id === cid ? cam : x)) });
        setFramingVersion((v) => v + 1);
      },
      editSegment: async (k, text) => {
        const t = await api.editSegment(lectureId, k, text).catch((e) => { setError(e.message); return null; });
        if (t) setTranscript(t);
      },
    };
  }, [lecture, visible, current, update, transcript, waveform, speech, styles, refreshStyles, estimate, jobs,
    renderedVersion, time, lectureId, mode, pollJobs, cameras, framingVersion, translation, translationLang]);

  if (error && !lecture) return <div className="fatal"><p>{error}</p><a href="#/">Back to library</a></div>;
  if (!ed) return <div className="fatal"><p>Loading…</p></div>;

  const prev = shorts.filter((s) => hidden.has(s.id));
  const restore = () => {
    const last = [...prev].sort((a, b) => b.created - a.created)[0];
    setHidden(new Set());
    if (last) go({ page: "editor", lecture: lectureId, mode, short: last.id });
  };
  const discard = async () => {
    // drafts go; rendered shorts are finished work and stay
    for (const s of prev) if (!s.rendered) await api.deleteShort(lectureId, s.id).catch(() => {});
    setShorts((l) => l.filter((s) => !hidden.has(s.id) || s.rendered));
    setHidden(new Set());
  };

  return (
    <>
      {error && <div className="toast" role="alert" onClick={() => setError(null)}>{error} <button type="button" aria-label="Dismiss">✕</button></div>}
      {prev.length > 0 && (
        <div className="restore" role="status">
          <span>Started fresh. Your last session had <b>{prev.length} short{prev.length > 1 ? "s" : ""}</b>
            {" "}({prev.reduce((n, s) => n + s.ranges.length, 0)} clips{prev.some((s) => s.rendered) ? ", some rendered" : ""}).</span>
          <button type="button" className="btn small primary" onClick={restore}>Restore previous session</button>
          <button type="button" className="btn small" onClick={discard}
            title="Deletes unrendered drafts; rendered shorts are kept">Discard</button>
        </div>
      )}
      <Workspace ed={ed} />
    </>
  );
}

/** Top bar: brand, lecture, short picker, render. */
export function TopBar({ ed }: { ed: Ed }) {
  const { lecture, shorts, short } = ed;
  const failed = ed.jobs.find((j) => j.short_id === short?.id && j.status === "error" && j.kind === "render");
  return (
    <header className="topbar">
      <a href="#/" className="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10 9.5l4 2.5-4 2.5z" fill="currentColor" /></svg>
        Lecture Shorts
      </a>
      <span className="crumb" dir="auto">{lecture.title}</span>
      <span className="grow" />
      <label className="short-pick">
        <span className="sr">Current short</span>
        <select value={short?.id ?? ""} onChange={(e) => (e.target.value === "__new" ? ed.newShort() : ed.selectShort(e.target.value))}>
          {shorts.map((s) => <option key={s.id} value={s.id}>{s.name} {s.rendered ? "✓" : ""}</option>)}
          <option value="__new">+ New short</option>
        </select>
      </label>
      {short && shorts.length > 1 && (
        <button type="button" className="btn small ghost" onClick={() => { if (confirm(`Delete ${short.name}?`)) ed.removeShort(short.id); }}>Delete short</button>
      )}
      {failed && <span className="bad" title={failed.message}>Last render failed: {failed.message}</span>}
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
    <button type="button" className={`btn primary ${block ? "block" : ""}`} disabled={!ed.short?.ranges.length}
      onClick={() => {
        const dur = ed.estimate?.duration ?? 0;
        if (dur > 180 && !confirm(`This short will be ${Math.round(dur / 60)} minutes long. Shorts are usually under 3 minutes, `
          + `and long ones take a while to render (roughly a third of their length). Render anyway?`)) return;
        ed.render();
      }}>
      Render {ed.short?.name ?? "short"}
    </button>
  );
}
