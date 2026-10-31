import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, defaultSettings, type Cameras, type Estimate, type Job, type Lecture, type Range, type Short,
  type ShortSettings, type Styles, type Transcript, type Translation,
} from "./api";
import { Confirm } from "./Confirm";
import { Mark } from "./Mark";
import { go } from "./main";
import { Workspace } from "./Workspace";
import { fmt, useDebounced, useInterval } from "./util";

export type Mode = "edit";

// the short last worked on in each lecture, reopened next time
const LAST_KEY = (lid: string) => `last-short:${lid}`;
function lastShort(lid: string): string | null {
  try { return localStorage.getItem(LAST_KEY(lid)); } catch { return null; }
}
const isEmpty = (s: Short) => !s.ranges.length && !s.rendered;

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
  gemini: boolean;  // a Gemini key is set on the server
  proofread: () => Promise<void>;
  proofreadJob: Job | null;
  proofreadFailed: Job | null;
  translateJob: Job | null;
  renderedVersion: number;
  cameras: Cameras | null;
  framingVersion: number;
  setFraming: (cid: number, manual: { x: number; y: number } | null) => Promise<void>;
  setCameraZoom: (cid: number, zoom: number | null) => Promise<void>;
  setFramingAt: (t: number, x: number) => Promise<void>;
  editSegment: (k: number, text: string | null) => Promise<void>;
  editWord: (i: number, text: string | null) => Promise<void>;
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
  const [gemini, setGemini] = useState(false);
  useEffect(() => { api.features().then((f) => setGemini(f.gemini)).catch(() => {}); }, []);
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
  const initialShort = useRef(shortId);

  const current = shorts.find((s) => s.id === shortId) ?? null;
  // empty drafts left from earlier visits aren't listed (they're reused for the next new short)
  const visible = shorts.filter((s) => !isEmpty(s) || s.id === current?.id);
  useEffect(() => {
    if (current) try { localStorage.setItem(LAST_KEY(lectureId), current.id); } catch { /* storage unavailable */ }
  }, [current?.id, lectureId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // reopen where you left off: the short asked for, else the last one worked on,
      // else the newest with clips; a new short only when the lecture has none
      const byId = (id: string | null | undefined) => list.find((s) => s.id === id);
      let pick = byId(initialShort.current) ?? byId(lastShort(lectureId))
        ?? [...list].filter((s) => !isEmpty(s)).sort((a, b) => b.created - a.created)[0] ?? list.find(isEmpty);
      if (!pick) {
        pick = await api.createShort(lectureId, defaultSettings("Short 1"));
        list = [...list, pick];
      }
      setShorts(list);
      if (pick.id !== initialShort.current) {
        history.replaceState(null, "", `#/l/${lectureId}/${mode}/${pick.id}`);
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
          if (j.kind === "proofread") loadTranscript();
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
        const settings = { ...defaultSettings(`Short ${visible.filter((s) => !isEmpty(s)).length + 1}`), ranges,
          ...(current ? { style: current.style, style_data: current.style_data, title: current.title } : {}) };
        // reuse an empty draft instead of piling up new ones
        const draft = shorts.find((s) => isEmpty(s) && s.id !== current?.id);
        const s = draft ? await api.updateShort(lectureId, draft.id, settings) : await api.createShort(lectureId, settings);
        setShorts((l) => (draft ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]));
        go({ page: "editor", lecture: lectureId, mode, short: s.id });
      },
      removeShort: async (id) => {
        await api.deleteShort(lectureId, id);
        const rest = shorts.filter((s) => s.id !== id);
        setShorts(rest);
        const next = rest.filter((s) => !isEmpty(s)).sort((a, b) => b.created - a.created)[0] ?? rest[0];
        go({ page: "editor", lecture: lectureId, mode, short: next?.id });
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
      gemini,
      proofread: async () => { await api.proofread(lectureId).catch((e) => setError(e.message)); pollJobs(); },
      proofreadJob: jobs.find((j) => j.kind === "proofread" && (j.status === "queued" || j.status === "running")) ?? null,
      proofreadFailed: jobs.find((j) => j.kind === "proofread")?.status === "error" ? jobs.find((j) => j.kind === "proofread")! : null,
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
      editWord: async (i, text) => {
        const t = await api.editWord(lectureId, i, text).catch((e) => { setError(e.message); return null; });
        if (t) setTranscript(t);
      },
    };
  }, [lecture, visible, shorts, current, update, transcript, waveform, speech, styles, refreshStyles, estimate, jobs,
    renderedVersion, time, lectureId, mode, pollJobs, cameras, framingVersion, translation, translationLang, gemini]);

  if (error && !lecture) return <div className="fatal"><p>{error}</p><a href="#/">Back to library</a></div>;
  if (!ed) return <div className="fatal"><p>Loading…</p></div>;

  return (
    <>
      {error && <div className="toast" role="alert">{error} <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>✕</button></div>}
      <Workspace ed={ed} />
    </>
  );
}

/** Top bar: brand, lecture, the lecture's shorts as tabs, render. */
export function TopBar({ ed }: { ed: Ed }) {
  const { lecture, shorts, short } = ed;
  const [deleting, setDeleting] = useState(false);
  const failed = ed.jobs.find((j) => j.short_id === short?.id && j.status === "error" && j.kind === "render");
  const e = ed.estimate;
  const n = short?.ranges.length ?? 0;
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand" title="Back to the library"><Mark size={20} /> Video Clipper</a>
        <span className="crumb-sep" aria-hidden="true">/</span>
        <span className="crumb" dir="auto">{lecture.title}</span>
        <nav className="short-tabs" aria-label="Shorts">
          {shorts.map((s) => (
            <span key={s.id} className={`short-tab ${s.id === short?.id ? "on" : ""}`}>
              <button type="button" aria-current={s.id === short?.id ? "page" : undefined} onClick={() => ed.selectShort(s.id)}>
                {s.name}{s.rendered && <span className="done" aria-label="rendered"> ✓</span>}
              </button>
              {s.id === short?.id && shorts.length > 1 && (
                <button type="button" className="icon tab-x" aria-label={`Delete ${s.name}`} title={`Delete ${s.name}`}
                  onClick={() => setDeleting(true)}>✕</button>
              )}
            </span>
          ))}
          <span className="short-tab"><button type="button" onClick={() => ed.newShort()}>+ New short</button></span>
        </nav>
        <span className="grow" />
        {failed && <span className="bad" title={failed.message}>Last render failed: {failed.message}</span>}
        {n > 0 && <span className="tc small dim">{n} clip{n === 1 ? "" : "s"}{e ? ` · ${fmt(e.duration / (short?.speed ?? 1), 0)} after cuts` : ""}</span>}
        <RenderButton ed={ed} />
      </header>
      {deleting && short && (
        <Confirm className="bar-confirm" action={`Delete ${short.name}`} cancel="Keep it" onCancel={() => setDeleting(false)}
          onConfirm={() => { setDeleting(false); ed.removeShort(short.id); }}>
          Delete {short.name}{short.rendered ? " and its rendered video" : ""}? Its {short.ranges.length} clip{short.ranges.length === 1 ? "" : "s"} go too.
        </Confirm>
      )}
    </>
  );
}

export function RenderButton({ ed }: { ed: Ed }) {
  const [asking, setAsking] = useState(false);
  const j = ed.renderJob;
  if (j) {
    const pct = Math.round(j.progress * 100);
    return (
      <div className="render-progress" role="status" aria-label={`Rendering ${ed.short?.name ?? "short"}`}>
        <span>{j.status === "queued" ? "Queued…" : `${j.stage || "Rendering"} · ${pct}%`}</span>
        <i style={{ width: `${j.status === "queued" ? 0 : pct}%` }} />
      </div>
    );
  }
  const dur = (ed.estimate?.duration ?? 0) / (ed.short?.speed ?? 1);
  return (
    <span className="render-wrap">
      <button type="button" className="btn primary" disabled={!ed.short?.ranges.length}
        onClick={() => (dur > 180 ? setAsking(true) : ed.render())}>
        {ed.short?.ranges.length ? `Render ${ed.short.name}` : "Add a clip to render"}
      </button>
      {asking && (
        <Confirm className="render-ask" tone="warn" action="Render anyway" cancel="Back to editing"
          onCancel={() => setAsking(false)} onConfirm={() => { setAsking(false); ed.render(); }}>
          <b>{ed.short?.name} will be {Math.round(dur / 60)} minutes long</b>
          <span>Shorts are usually under 3 minutes. Long ones take a while to render, roughly a third of their length.</span>
        </Confirm>
      )}
    </span>
  );
}
