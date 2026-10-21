import { useEffect, useRef, useState } from "react";
import { api, type Lecture } from "./api";
import { go } from "./main";
import { fmt, useInterval } from "./util";

type Source = "link" | "file" | "path";

function statusText(l: Lecture): string {
  if (l.job) {
    const pct = l.job.progress ? ` ${Math.round(l.job.progress * 100)}%` : "";
    return `${l.job.stage || l.job.kind}${pct}`;
  }
  if (l.status === "error") return "Import failed";
  if (l.status !== "ready") return l.status;
  return l.has_transcript ? "Ready · transcript" : "Ready · no transcript";
}

export function Landing() {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [source, setSource] = useState<Source>("link");
  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lang, setLang] = useState("ar");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const libRef = useRef<HTMLElement>(null);

  const refresh = () => api.lectures().then(setLectures).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const active = lectures.some((l) => l.job || l.status === "importing" || l.status === "analyzing");
  useInterval(refresh, active ? 1500 : 10000);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const language = lang === "auto" ? null : lang;
    try {
      if (source === "link") await api.importUrl(value.trim(), language);
      else if (source === "path") await api.importLocal(value.trim(), language);
      else if (file) await api.importFile(file, language);
      setValue("");
      setFile(null);
      await refresh();
      libRef.current?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const open = (l: Lecture) => go({ page: "editor", lecture: l.id, mode: "edit" });
  const latestReady = lectures.find((l) => l.status === "ready");
  const openEditor = () => {
    if (latestReady) open(latestReady);
    else document.getElementById("src")?.focus();
  };

  return (
    <div className="landing">
      <header className="l-header">
        <a href="#/" className="brand">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10 9.5l4 2.5-4 2.5z" fill="currentColor" /></svg>
          Lecture Shorts
        </a>
        <nav aria-label="Main" className="l-nav">
          <a href="#modes" onClick={(e) => { e.preventDefault(); document.getElementById("modes")?.scrollIntoView({ behavior: "smooth" }); }}>The editor</a>
          <a href="#how" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>How it works</a>
        </nav>
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={() => libRef.current?.scrollIntoView({ behavior: "smooth" })}>
          Library{lectures.length ? ` · ${lectures.length}` : ""}
        </button>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <h1>Hour-long lectures in. Shorts people finish, out.</h1>
          <p className="lede">Pauses are removed with smooth morph cuts, the frame follows the speaker, and Arabic captions read right-to-left the way they should.</p>
          <form className="import" onSubmit={submit}>
            <div className="import-tabs" role="tablist" aria-label="Import from">
              {(["link", "file", "path"] as Source[]).map((s) => (
                <button key={s} type="button" role="tab" aria-selected={source === s}
                  className={source === s ? "on" : ""} onClick={() => { setSource(s); setError(null); }}>
                  {s === "link" ? "Link" : s === "file" ? "Upload file" : "File on this computer"}
                </button>
              ))}
            </div>
            <label htmlFor="src" className="sr">Lecture source</label>
            <div className="import-box">
              {source === "file" ? (
                <input id="src" type="file" accept="video/*,.mkv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              ) : (
                <input id="src" type="text" value={value} onChange={(e) => setValue(e.target.value)}
                  placeholder={source === "link" ? "Paste a YouTube link" : "/home/me/Videos/lecture.mp4"} />
              )}
              <select aria-label="Lecture language" value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="ar">Arabic</option>
                <option value="en">English</option>
                <option value="auto">Auto-detect</option>
              </select>
              <button type="submit" className="btn dark" disabled={busy || (source === "file" ? !file : !value.trim())}>
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
            {error ? <p className="err" role="alert">{error}</p> : <p className="hint">MP4, MOV, WebM or MKV · 16:9 sources work best</p>}
          </form>
        </div>
        <div className="hero-art" aria-hidden="true">
          {lectures.filter((l) => l.status === "ready").slice(0, 3).map((l, i) => (
            <div key={l.id} className={`phone p${i}`} style={{ backgroundImage: `url(${api.thumbUrl(l.id)})` }} />
          ))}
          {!lectures.some((l) => l.status === "ready") && <><div className="phone p0 empty" /><div className="phone p1 empty" /><div className="phone p2 empty" /></>}
        </div>
      </section>

      <section id="modes" className="modes" aria-labelledby="modes-h">
        <h2 id="modes-h">Watch it or read it, in one place</h2>
        <p className="sub">The video with its timeline and the transcript sit side by side, and both edit the same short.</p>
        <div className="mode-grid">
          <article className="mode-card dark">
            <div className="mode-art studio-art" aria-hidden="true">
              <div className="crop" />
              <div className="mini-wave">{Array.from({ length: 70 }, (_, i) => <span key={i} style={{ height: `${i % 11 < 2 ? 8 : 30 + ((i * 37) % 60)}%` }} className={i > 12 && i < 44 ? "sel" : ""} />)}</div>
            </div>
            <span className="eyebrow gold">WATCH &amp; MARK</span>
            <h3>Timeline</h3>
            <p>Scrub the video, press I and O to mark a moment, and fine-tune on the waveform. Pauses and the speaker framing are visible as you go.</p>
            <ul><li>Works without a transcript</li><li>Frame-accurate in and out points</li><li>Drag the frame to set each camera</li></ul>
          </article>
          <article className="mode-card light">
            <div className="mode-art read-art" lang="ar" dir="rtl" aria-hidden="true">
              <p className="dim">لما بعث ستين أو ثمانين راكبا من قريش</p>
              <p className="sel">إلا أن سعدا رمى ذلك اليوم <mark>بسهم</mark>، فكان أول من رمى <mark>بسهم</mark> في سبيل الله <span className="pause">1.2s</span></p>
              <p className="dim">لكن قال ابن هشام مهذب سيرة ابن إسحاق</p>
            </div>
            <span className="eyebrow green">READ &amp; SELECT</span>
            <h3>Transcript</h3>
            <p>Read the lecture like a document. Search a word, click the sentences you want, and fix any misheard text right there.</p>
            <ul><li>Search a whole hour in seconds</li><li>Clips start and end on whole sentences</li><li>Corrections flow into the captions</li></ul>
          </article>
        </div>
        <button type="button" className="btn dark open-editor" onClick={openEditor}>Open the editor →</button>
      </section>

      <section ref={libRef} className="library" aria-labelledby="lib-h">
        <h2 id="lib-h">Library</h2>
        {lectures.length === 0 ? (
          <p className="sub">No lectures yet. Import one above to get started.</p>
        ) : (
          <ul className="lib-list">
            {lectures.map((l) => (
              <li key={l.id} className="lib-row">
                <div className="thumb" style={l.status === "ready" ? { backgroundImage: `url(${api.thumbUrl(l.id)})` } : undefined} />
                <div className="lib-main">
                  <span className="lib-title" dir="auto">{l.title}</span>
                  <span className="lib-meta">
                    {l.duration ? fmt(l.duration, 0) : "—"} · {l.shorts} short{l.shorts === 1 ? "" : "s"} · {statusText(l)}
                  </span>
                  {l.job && <progress max={1} value={l.job.progress || undefined} aria-label="Progress" />}
                </div>
                <div className="lib-actions">
                  <button type="button" className="btn" disabled={l.status !== "ready"} onClick={() => open(l)}>Open</button>
                  <button type="button" className="btn ghost" aria-label={`Delete ${l.title}`}
                    onClick={async () => { if (confirm(`Delete “${l.title}” and its shorts?`)) { await api.deleteLecture(l.id); refresh(); } }}>✕</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="how" className="how" aria-labelledby="how-h">
        <h2 id="how-h">What happens to every short</h2>
        <ol>
          <li><span className="num">01</span><b>Pauses removed, smoothly</b><span>Silences are found from the audio itself and cut out. Each cut is blended with an optical-flow morph, so the speaker never jumps.</span></li>
          <li><span className="num">02</span><b>The frame follows the speaker</b><span>A 9:16 window tracks the speaker's face like a calm camera operator, and switches cleanly on the exact frame the camera changes.</span></li>
          <li><span className="num">03</span><b>Captions that read right</b><span>Word-timed captions in short chunks, right-to-left for Arabic, with the spoken word highlighted if you want it.</span></li>
        </ol>
      </section>
      <footer className="l-footer">Lecture Shorts · runs on your machine</footer>
    </div>
  );
}
