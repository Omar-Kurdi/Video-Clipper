import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lecture, type Short } from "./api";
import { Confirm } from "./Confirm";
import { Mark } from "./Mark";
import { go } from "./main";
import { fmt, normalize, useInterval } from "./util";

const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;

const LANG_NAME: Record<string, string> = { ar: "Arabic", en: "English" };
const isLink = (v: string) => /^https?:\/\//i.test(v) || /(^|\.)(youtube\.com|youtu\.be)\//i.test(v);

function statusText(l: Lecture): string {
  if (l.job) {
    const pct = l.job.progress ? ` ${Math.round(l.job.progress * 100)}%` : "";
    return `${l.job.stage || l.job.kind}${pct}`;
  }
  if (l.status === "error") return "Import failed";
  if (l.status !== "ready") return l.status;
  return l.has_transcript ? "transcript ready" : "no transcript yet";
}

export function Landing() {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState("");
  const [lang, setLang] = useState("ar");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [alsoOriginal, setAlsoOriginal] = useState(false);
  const [shorts, setShorts] = useState<Record<string, Short[]>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLElement>(null);

  const refresh = () => api.lectures().then(setLectures).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { refresh(); }, []);
  const active = lectures.some((l) => l.job || l.status === "importing" || l.status === "analyzing");
  useInterval(refresh, active ? 1500 : 10000);

  // each lecture's shorts, fetched again only when its count changes
  const shortsKey = lectures.filter((l) => l.status === "ready" && l.shorts).map((l) => `${l.id}:${l.shorts}`).join(",");
  useEffect(() => {
    for (const l of lectures) {
      if (l.status !== "ready" || !l.shorts) continue;
      api.shorts(l.id).then((list) => setShorts((m) => ({ ...m, [l.id]: list.filter((s) => s.ranges.length || s.rendered) }))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortsKey]);

  async function run(job: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await job();
      setValue("");
      await refresh();
      libRef.current?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const language = lang === "auto" ? null : lang;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    run(() => (isLink(v) ? api.importUrl(v, language) : api.importLocal(v, language)));
  };
  const upload = (f: File) => run(() => api.importFile(f, language));

  // drop a video anywhere on the page
  useEffect(() => {
    let depth = 0;
    const hasFile = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => { if (hasFile(e)) { depth++; setDropping(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDropping(false); };
    const over = (e: DragEvent) => { if (hasFile(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      const f = e.dataTransfer?.files[0];
      if (f) upload(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const open = (l: Lecture, short?: string) => go({ page: "editor", lecture: l.id, mode: "edit", short });
  const shown = useMemo(() => {
    const q = normalize(query);
    return q ? lectures.filter((l) => normalize(l.title).includes(q)) : lectures;
  }, [lectures, query]);
  const shortCount = lectures.reduce((n, l) => n + l.shorts, 0);
  const v = value.trim();
  const returning = lectures.length > 0;

  return (
    <div className="landing">
      <div className="wrap">
        <header className="l-header">
          <a href="#/" className="brand"><Mark /> Video Clipper</a>
          <span className="grow" />
          {lectures.length > 0 && (
            <span className="tc small dim">{lectures.length} video{lectures.length === 1 ? "" : "s"} · {shortCount} short{shortCount === 1 ? "" : "s"}</span>
          )}
        </header>

        {/* the full welcome only until the library has something in it; after that, just the import bar */}
        <section className={`hero ${returning ? "compact" : ""}`}>
          <div className="hero-copy">
            {!returning && <>
              <span className="eyebrow">Clipping for long talks · runs on your computer</span>
              <h1>Long talks in. Shorts people <em>finish</em>, out.</h1>
              <p className="lede">Lectures, podcasts, sermons, interviews. Mark the moments you want: pauses are cut with smooth morphs, the frame holds the main speaker on every camera (or wherever you place it), and captions are timed word by word, right to left for Arabic.</p>
            </>}
            <form className="import" onSubmit={submit}>
              <label htmlFor="src" className="eyebrow">Add a video</label>
              <div className="import-box">
                <input id="src" type="text" value={value} dir="auto" autoComplete="off" spellCheck={false}
                  onChange={(e) => { setValue(e.target.value); setError(null); }}
                  placeholder="YouTube link or a file path on this computer" />
                <select aria-label="Spoken language" value={lang} onChange={(e) => setLang(e.target.value)}>
                  <option value="ar">Arabic</option>
                  <option value="en">English</option>
                  <option value="auto">Detect</option>
                </select>
                <button type="submit" className="btn dark" disabled={busy || !v}>{busy ? "Importing…" : "Import"}</button>
              </div>
              {error ? <p className="err" role="alert">{error}</p> : (
                <p className="hint">
                  {v ? (isLink(v) ? "A link: the video is downloaded once." : "A file on this computer: it's linked, not copied.") : "Or drop a video anywhere on this page"}
                  {" · "}
                  <button type="button" className="link" onClick={() => fileRef.current?.click()}>choose a file</button>
                  {" · MP4, MOV, WebM, MKV"}
                </p>
              )}
              <input ref={fileRef} type="file" accept="video/*,.mkv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
            </form>
            {!returning && <Trust />}
          </div>
          {!returning && <HeroArt />}
        </section>

        {returning && <ShortsGallery lectures={lectures} shorts={shorts} open={open} />}

        <section ref={libRef} className="library" aria-labelledby="lib-h">
          <div className="lib-head">
            <h2 id="lib-h">Library</h2>
            <span className="grow" />
            {lectures.length > 3 && (
              <label className="search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <span className="sr">Search videos</span>
                <input type="search" dir="auto" value={query} placeholder="Search videos" onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
          </div>
          {loaded && lectures.length === 0 ? <EmptyLibrary onChoose={() => fileRef.current?.click()} /> : (
            <ul className="lib-list">
              {query && shown.length === 0 && <li className="lib-none">No video title matches “{query}”.</li>}
              {shown.map((l) => (
                <li key={l.id} className="lib-row">
                  <div className="thumb" style={l.status === "ready" ? { backgroundImage: `url(${api.thumbUrl(l.id)})` } : undefined} />
                  <div className="lib-main">
                    <span className={`lib-title ${/[؀-ۿ]/.test(l.title) ? "ar" : ""}`} dir="auto">{l.title}</span>
                    {l.status === "error" ? (
                      <span className="err">{l.job?.message ? `Import failed: ${l.job.message}` : "Import failed. Remove it and add the video again."}</span>
                    ) : (
                      <span className="lib-meta tc">
                        {l.duration ? fmt(l.duration, 0) : "—"}{l.language ? ` · ${LANG_NAME[l.language] ?? l.language}` : ""} · {statusText(l)}
                      </span>
                    )}
                    {l.job && l.job.status !== "error" && <div className="rule-progress" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100}
                      aria-valuenow={Math.round((l.job.progress || 0) * 100)}><i style={{ width: `${(l.job.progress || 0) * 100}%` }} /></div>}
                    {(shorts[l.id]?.length ?? 0) > 0 && (
                      <div className="slips">
                        {shorts[l.id].map((s) => (
                          <a key={s.id} href={`#/l/${l.id}/edit/${s.id}`} className={`slip ${s.rendered ? "done" : ""}`}
                            onClick={(e) => { e.preventDefault(); open(l, s.id); }}>
                            {/* rendered: a frame of the short; a draft: the lecture, faded */}
                            <i aria-hidden="true" style={{ backgroundImage: `url(${s.rendered ? api.shortThumb(l.id, s.id, s.last_render?.at) : api.thumbUrl(l.id)})` }} />
                            <span>{s.name}{s.rendered ? " ✓" : ""}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {deleting === l.id && (
                      <Confirm action="Delete video" cancel="Keep it" onCancel={() => { setDeleting(null); setAlsoOriginal(false); }}
                        onConfirm={async () => {
                          setDeleting(null);
                          await api.deleteLecture(l.id, alsoOriginal).catch((e) => setError(e.message));
                          setAlsoOriginal(false);
                          refresh();
                        }}>
                        Delete this video and its {l.shorts} short{l.shorts === 1 ? "" : "s"}
                        {l.disk ? <> (the video, renders and transcript: {fmtBytes(l.disk.bytes + (alsoOriginal ? l.disk.linked_bytes : 0))} freed)</> : null}?
                        {l.disk?.linked && (
                          <label className="confirm-check">
                            <input type="checkbox" checked={alsoOriginal} onChange={(e) => setAlsoOriginal(e.target.checked)} />
                            Also delete the original video on this computer ({fmtBytes(l.disk.linked_bytes)}):
                            <code dir="ltr">{l.disk.linked}</code>
                          </label>
                        )}
                      </Confirm>
                    )}
                  </div>
                  <div className="lib-actions">
                    {l.status === "error"
                      ? <button type="button" className="btn dark" onClick={() => api.retryImport(l.id).then(refresh).catch((e) => setError(e.message))}>Try again</button>
                      : <button type="button" className="btn dark" disabled={l.status !== "ready"} onClick={() => open(l)}>Open</button>}
                    <button type="button" className="btn" aria-label={`Delete ${l.title}`} title="Delete"
                      onClick={() => setDeleting(deleting === l.id ? null : l.id)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <HowItWorks />
        <footer className="l-footer tc">Video Clipper · runs on this computer</footer>
      </div>
      {dropping && <div className="drop-veil" aria-hidden="true"><span>Drop the video to add it</span></div>}
    </div>
  );
}

/** Three promises under the import field. */
function Trust() {
  return (
    <ul className="trust">
      <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>Runs on your computer</li>
      <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v18M18 3v18M6 12h12" /></svg>Frame-exact cuts</li>
      <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h7a3 3 0 013 3v12a2 2 0 00-2-2H4zM20 5h-6" /><path d="M14 8a3 3 0 013-3h3v13h-6" /></svg>Quran- and hadith-aware</li>
    </ul>
  );
}

/** The hero's picture: a wide shot of two people talking, the 9:16 window on
 * the one speaking, and the vertical short it becomes. Drawn, so it needs no footage. */
function HeroArt() {
  const person = (x: number, shirt: string, talking: boolean) => (
    <g>
      <ellipse cx={x} cy={262} rx={62} ry={84} fill={shirt} />
      <circle cx={x} cy={132} r={36} fill="#C99A7A" />
      <path d={`M${x - 37} ${122} q37 -46 74 0`} fill="#2A2522" />
      <path d={`M${x - 12} ${152} q12 ${talking ? 13 : 4} 24 0`} stroke="#5A2E22" strokeWidth={4} fill={talking ? "#5A2E22" : "none"} strokeLinecap="round" />
    </g>
  );
  return (
    <div className="hero-art ba" aria-hidden="true">
      <div className="ba-wide">
        <svg viewBox="0 0 480 270" preserveAspectRatio="xMidYMid slice">
          <rect width="480" height="270" fill="#1D2723" />
          <rect x="0" y="0" width="480" height="150" fill="#24312C" />
          <rect x="300" y="26" width="120" height="84" fill="#2E3E37" />
          <rect x="20" y="200" width="440" height="70" rx="18" fill="#2F4A44" />
          {person(140, "#E9E2D6", false)}
          {person(336, "#7A2731", true)}
        </svg>
        <div className="ba-frame" style={{ left: "70%" }}><span>9:16</span></div>
        <span className="ba-label tc">16:9 source</span>
      </div>
      <div className="ba-short">
        <svg viewBox="0 0 108 192" preserveAspectRatio="xMidYMid slice">
          <rect width="108" height="192" fill="#1D2723" />
          <rect x="0" y="0" width="108" height="100" fill="#24312C" />
          <ellipse cx="54" cy="176" rx="42" ry="58" fill="#7A2731" />
          <circle cx="54" cy="86" r="24" fill="#C99A7A" />
          <path d="M30 79 q24 -32 48 0" fill="#2A2522" />
          <path d="M46 98 q8 9 16 0" stroke="#5A2E22" strokeWidth="3" fill="#5A2E22" strokeLinecap="round" />
        </svg>
        <span className="hero-tag">Al-Baqarah 153</span>
        <span className="hero-cap" dir="rtl" lang="ar">إِنَّ ٱللَّهَ مَعَ ٱلصَّٰبِرِينَ</span>
      </div>
    </div>
  );
}

/** Every rendered short in the library, newest first. */
function ShortsGallery({ lectures, shorts, open }: {
  lectures: Lecture[]; shorts: Record<string, Short[]>; open: (l: Lecture, short?: string) => void;
}) {
  const done = lectures.flatMap((l) => (shorts[l.id] ?? []).filter((s) => s.rendered).map((s) => ({ l, s })))
    .sort((a, b) => (b.s.last_render?.at ?? 0) - (a.s.last_render?.at ?? 0));
  if (!done.length) return null;
  return (
    <section className="gallery" aria-labelledby="gal-h">
      <h2 id="gal-h">Your shorts</h2>
      <ul>
        {done.map(({ l, s }) => (
          <li key={s.id}>
            <a href={`#/l/${l.id}/edit/${s.id}`} onClick={(e) => { e.preventDefault(); open(l, s.id); }}>
              <i style={{ backgroundImage: `url(${api.shortThumb(l.id, s.id, s.last_render?.at)})` }} />
              <b dir="auto">{s.post?.title || s.name}</b>
              <span dir="auto" className="small muted">{l.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What it does differently, and the four steps. */
function HowItWorks() {
  return (
    <section className="how" aria-labelledby="how-h">
      <span className="eyebrow">The difference</span>
      <h2 id="how-h">The difference is in the details.</h2>
      <div className="diff">
        <figure>
          <figcaption><b>Pauses</b><span>A plain cut makes the speaker jump. A morph moves them into place.</span></figcaption>
          <div className="diff-pair">
            <div className="cut-demo plain" aria-hidden="true"><i /><i /><i /></div>
            <div className="cut-demo morph" aria-hidden="true"><i /><i /><i /></div>
          </div>
          <div className="diff-labels small muted"><span>Plain cut</span><span>Video Clipper</span></div>
        </figure>
        <figure>
          <figcaption><b>Quran</b><span>A recogniser writes what it heard. Your captions get the mushaf text, with the surah and ayah.</span></figcaption>
          <div className="diff-pair text">
            <p dir="rtl" lang="ar" className="heard">ان الله مع الصابرين</p>
            <p dir="rtl" lang="ar" className="quran">إِنَّ ٱللَّهَ مَعَ ٱلصَّٰبِرِينَ<small>البقرة ١٥٣</small></p>
          </div>
          <div className="diff-labels small muted"><span>Heard</span><span>In your captions</span></div>
        </figure>
      </div>
      <ol className="steps">
        <li><span className="tc">01</span><b>Add</b><span>A YouTube link or a file on this computer.</span></li>
        <li><span className="tc">02</span><b>Mark</b><span>Select sentences in the transcript, or take a suggested moment.</span></li>
        <li><span className="tc">03</span><b>Tune</b><span>Captions, framing per camera, pause length, safe area.</span></li>
        <li><span className="tc">04</span><b>Render</b><span>A 9:16 MP4, ready to post, with its title and description.</span></li>
      </ol>
    </section>
  );
}

function EmptyLibrary({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="empty-lib">
      <h3>Add your first video</h3>
      <p>Paste a YouTube link or a file path above, or drop a video here. Each video is analysed once: waveform, pauses, cameras and the speaker's face.</p>
      <button type="button" className="drop-zone" onClick={onChoose}>Drop a video file here, or click to choose one</button>
      <ul className="facts">
        <li><b>Pauses cut smoothly</b><span>Silences are found from the audio and blended with an optical-flow morph, so the speaker never jumps.</span></li>
        <li><b>The frame follows the speaker</b><span>A 9:16 window holds the speaker and switches on the exact frame the camera changes.</span></li>
        <li><b>Captions that read right</b><span>Word-timed, right to left for Arabic, with harakat if you want them, or in English.</span></li>
        <li><b>Quran named on screen</b><span>While a verse is quoted, a small line above the captions names the surah and ayah.</span></li>
      </ul>
    </div>
  );
}
