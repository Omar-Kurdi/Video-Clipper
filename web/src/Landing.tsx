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
  const latest = lectures.find((l) => l.status === "ready");
  const v = value.trim();

  return (
    <div className="landing">
      <div className="wrap">
        <header className="l-header">
          <a href="#/" className="brand"><Mark /> Lecture Shorts</a>
          <span className="grow" />
          {lectures.length > 0 && (
            <span className="tc small dim">{lectures.length} lecture{lectures.length === 1 ? "" : "s"} · {shortCount} short{shortCount === 1 ? "" : "s"}</span>
          )}
        </header>

        <section className="hero">
          <div className="hero-copy">
            <h1>Hour-long lectures in. Shorts people <em>finish</em>, out.</h1>
            <p className="lede">Mark the moments in red. Pauses are cut with smooth morphs, the frame follows the speaker, and Arabic captions read right to left.</p>
            <form className="import" onSubmit={submit}>
              <label htmlFor="src" className="eyebrow">Add a lecture</label>
              <div className="import-box">
                <input id="src" type="text" value={value} dir="auto" autoComplete="off" spellCheck={false}
                  onChange={(e) => { setValue(e.target.value); setError(null); }}
                  placeholder="YouTube link or a file path on this computer" />
                <select aria-label="Lecture language" value={lang} onChange={(e) => setLang(e.target.value)}>
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
          </div>
          <HeroPage thumb={latest ? api.thumbUrl(latest.id) : null} />
        </section>

        <section ref={libRef} className="library" aria-labelledby="lib-h">
          <div className="lib-head">
            <h2 id="lib-h">Library</h2>
            <span className="grow" />
            {lectures.length > 3 && (
              <label className="search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <span className="sr">Search lectures</span>
                <input type="search" dir="auto" value={query} placeholder="Search lectures" onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
          </div>
          {loaded && lectures.length === 0 ? <EmptyLibrary onChoose={() => fileRef.current?.click()} /> : (
            <ul className="lib-list">
              {query && shown.length === 0 && <li className="lib-none">No lecture title matches “{query}”.</li>}
              {shown.map((l) => (
                <li key={l.id} className="lib-row">
                  <div className="thumb" style={l.status === "ready" ? { backgroundImage: `url(${api.thumbUrl(l.id)})` } : undefined} />
                  <div className="lib-main">
                    <span className={`lib-title ${/[؀-ۿ]/.test(l.title) ? "ar" : ""}`} dir="auto">{l.title}</span>
                    {l.status === "error" ? (
                      <span className="err">{l.job?.message ? `Import failed: ${l.job.message}` : "Import failed. Remove it and add the lecture again."}</span>
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
                            <i aria-hidden="true" />
                            <span>{s.name}{s.rendered ? " ✓" : ""}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {deleting === l.id && (
                      <Confirm action="Delete lecture" cancel="Keep it" onCancel={() => { setDeleting(null); setAlsoOriginal(false); }}
                        onConfirm={async () => {
                          setDeleting(null);
                          await api.deleteLecture(l.id, alsoOriginal).catch((e) => setError(e.message));
                          setAlsoOriginal(false);
                          refresh();
                        }}>
                        Delete this lecture and its {l.shorts} short{l.shorts === 1 ? "" : "s"}
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
                    <button type="button" className="btn dark" disabled={l.status !== "ready"} onClick={() => open(l)}>Open</button>
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
        <footer className="l-footer tc">Lecture Shorts · runs on this computer</footer>
      </div>
      {dropping && <div className="drop-veil" aria-hidden="true"><span>Drop the video to add it</span></div>}
    </div>
  );
}

const HERO_LINES: [string, string, boolean][] = [
  ["12:02", "قَالَ شَكَا أَهْلُ الْكُوفَةِ سَعْدًا إِلَى عُمَرَ", false],
  ["12:09", "فَأَرْسَلَ إِلَيْهِ فَقَالَ: يَا أَبَا إِسْحَاقَ، إِنَّ هَؤُلَاءِ يَزْعُمُونَ أَنَّكَ لَا تُحْسِنُ تُصَلِّي", true],
  ["12:16", "قَالَ: أَمَّا أَنَا وَاللَّهِ فَإِنِّي كُنْتُ أُصَلِّي بِهِمْ صَلَاةَ رَسُولِ اللَّهِ ﷺ", false],
];

/** The hero's picture: a ruled transcript page with one sentence in red, and the short it becomes. */
function HeroPage({ thumb }: { thumb: string | null }) {
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="page">
        {HERO_LINES.map(([t, text, inShort]) => (
          <div key={t} className={`page-line ${inShort ? "in" : ""}`}>
            <span className="tc">{t}</span>
            <p dir="rtl" lang="ar">{text}</p>
          </div>
        ))}
      </div>
      <div className="hero-slip" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>
        <span className="hero-tag">Bukhari 755</span>
        <span className="hero-cap" dir="rtl" lang="ar">يَا أَبَا إِسْحَاقَ</span>
      </div>
    </div>
  );
}

function EmptyLibrary({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="empty-lib">
      <h3>Add your first lecture</h3>
      <p>Paste a YouTube link or a file path above, or drop a video here. Each lecture is analysed once: waveform, pauses, cameras and the lecturer's face.</p>
      <button type="button" className="drop-zone" onClick={onChoose}>Drop a video file here, or click to choose one</button>
      <ul className="facts">
        <li><b>Pauses cut smoothly</b><span>Silences are found from the audio and blended with an optical-flow morph, so the speaker never jumps.</span></li>
        <li><b>The frame follows the speaker</b><span>A 9:16 window holds the lecturer and switches on the exact frame the camera changes.</span></li>
        <li><b>Captions that read right</b><span>Word-timed, right to left for Arabic, with harakat if you want them, or in English.</span></li>
        <li><b>Quran named on screen</b><span>While a verse is quoted, a small line above the captions names the surah and ayah.</span></li>
      </ul>
    </div>
  );
}
