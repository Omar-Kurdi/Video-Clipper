import { useEffect, useRef, useState } from "react";
import { api, type Camera, type Post, type Range, type StyleData, type TextStyle } from "./api";
import type { Ed } from "./Editor";
import { QuickPlayer } from "./Quick";
import { rememberVolume } from "./Volume";
import { fmt, parseTime, useDebounced } from "./util";

/* ---------- live 9:16 preview / rendered video ---------- */

/** Where each app's buttons, caption and username sit over a 1080×1920 video
 * (approximate, as fractions of the frame): keep faces and captions inside. */
const SAFE_ZONES = {
  tiktok: { name: "TikTok", top: 0.07, bottom: 0.23, left: 0.05, right: 0.13 },
  reels: { name: "Reels", top: 0.11, bottom: 0.22, left: 0.05, right: 0.11 },
  shorts: { name: "Shorts", top: 0.07, bottom: 0.2, left: 0.05, right: 0.11 },
} as const;
type Guide = keyof typeof SAFE_ZONES | "off";
const GUIDE_KEY = "safe-zone-guide";

function storedGuide(): Guide {
  try { const g = localStorage.getItem(GUIDE_KEY); if (g && (g === "off" || g in SAFE_ZONES)) return g as Guide; } catch { /* storage unavailable */ }
  return "off";
}

function SafeZone({ guide, width, height }: { guide: Guide; width: number; height: number }) {
  if (guide === "off") return null;
  const z = SAFE_ZONES[guide];
  return (
    <div className="safe-zone" aria-hidden="true" style={{ width, height }}>
      <div className="safe-zone-box" style={{ top: `${z.top * 100}%`, bottom: `${z.bottom * 100}%`, left: `${z.left * 100}%`, right: `${z.right * 100}%` }}>
        <span>{z.name} safe area</span>
      </div>
    </div>
  );
}

export function Preview({ ed, t: at, width = 270 }: { ed: Ed; t: number; width?: number }) {
  const s = ed.short;
  // preview a moment that is actually in the short when the playhead is elsewhere
  const inShort = s?.ranges.some(([a, b]) => at >= a && at <= b);
  const t = !s?.ranges.length || inShort ? at : s.ranges[0][0] + 0.5;
  type Tab = "play" | "look" | "rendered";
  const pick = (): Tab => (s?.rendered ? "rendered" : s?.ranges.length ? "play" : "look");
  const [tab, setTab] = useState<Tab>(pick);
  const [img, setImg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [guide, setGuideState] = useState<Guide>(storedGuide);
  const setGuide = (g: Guide) => { setGuideState(g); try { localStorage.setItem(GUIDE_KEY, g); } catch { /* storage unavailable */ } };
  const key = useDebounced(JSON.stringify({ t: Math.round(t * 4) / 4, style: s?.style, style_data: s?.style_data,
    title: s?.title, zoom: s?.zoom, captions: s?.captions, harakat: s?.harakat, caption_lang: s?.caption_lang, quran_tag: s?.quran_tag,
    tr: ed.translation ? 1 : 0 }), 350);

  const sid = s?.id;
  useEffect(() => { setTab(pick()); }, [sid, ed.renderedVersion, s?.rendered]); // eslint-disable-line react-hooks/exhaustive-deps
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
        <button type="button" role="tab" aria-selected={tab === "play"} disabled={!s?.ranges.length} onClick={() => setTab("play")}>Play cut</button>
        <button type="button" role="tab" aria-selected={tab === "look"} onClick={() => setTab("look")}>Still at {fmt(t, 0)}</button>
        <button type="button" role="tab" aria-selected={tab === "rendered"} disabled={!s?.rendered} onClick={() => setTab("rendered")}>Rendered</button>
      </div>
      <div className="preview-stage">
      <SafeZone guide={guide} width={width} height={height} />
      {tab === "play" && s?.ranges.length ? <QuickPlayer ed={ed} width={width} /> : (
      <div className="phone-frame" style={{ width, height }}>
        {tab === "rendered" && s?.rendered ? (
          <video key={ed.renderedVersion} src={api.shortVideoUrl(ed.lecture.id, s.id, ed.renderedVersion)} ref={rememberVolume} controls playsInline />
        ) : img ? (
          <img src={img} alt="Preview of the short at the current time" className={loading ? "loading" : ""} />
        ) : (
          <div className="ph">Loading preview…</div>
        )}
      </div>)}
      </div>
      <label className="guide-pick small">
        <span>Safe area</span>
        <select value={guide} onChange={(e) => setGuide(e.target.value as Guide)}>
          <option value="off">Off</option>
          {Object.entries(SAFE_ZONES).map(([k, z]) => <option key={k} value={k}>{z.name}</option>)}
        </select>
      </label>
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
      <div><b className="good">{e ? fmt(e.duration / (ed.short?.speed ?? 1), 0) : "0:00"}</b><span>{(ed.short?.speed ?? 1) !== 1 ? `exported at ${ed.short?.speed}×` : "after cuts"}</span></div>
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

/** The short's clips as one row under the timeline, in order, each editable. */
export function ClipStrip({ ed, onPlay }: { ed: Ed; onPlay: (r: Range) => void }) {
  const s = ed.short;
  if (!s) return null;
  const set = (i: number, r: Range) => {
    const ranges = s.ranges.map((x, k) => (k === i ? ([Math.min(r[0], r[1]), Math.max(r[0], r[1])] as Range) : x));
    ed.update({ ranges });
  };
  return (
    <div className="clip-strip">
      <label className="name-edit" title="Rename this short">
        <span className="sr">Short name</span>
        <input value={s.name} onChange={(e) => ed.update({ name: e.target.value })} />
      </label>
      {s.ranges.length === 0 ? <span className="muted small">No clips yet. Select a moment, then press Add.</span> : (
        <ol className="clip-list" aria-label={`Clips in ${s.name}`}>
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
      )}
    </div>
  );
}

/** One line of help; the rest behind "More". */
function Help({ children, more }: { children: React.ReactNode; more?: React.ReactNode }) {
  return (
    <div className="help">
      {children}
      {more && <details><summary>More</summary>{more}</details>}
    </div>
  );
}

/* ---------- pauses ---------- */

export function PausesPanel({ ed }: { ed: Ed }) {
  const s = ed.short;
  if (!s) return null;
  const ms = Math.round((s.transition_frames / (ed.lecture.fps || 25)) * 1000);
  return (
    <div className="panel">
      <div className="row"><label htmlFor="gap">Cut pauses longer than</label><span className="val">{s.min_gap.toFixed(2)} s</span></div>
      <input id="gap" type="range" min={0.2} max={1.5} step={0.05} value={s.min_gap} onChange={(e) => ed.update({ min_gap: +e.target.value })} />
      <Help>How the moments either side of a cut pause are joined:</Help>
      <fieldset>
        <legend className="sr">Transition at each cut</legend>
        <div className="seg fill">
          {(["morph", "fade", "cut"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={s.transition === t} onClick={() => ed.update({ transition: t })}>
              {t === "morph" ? "Morph" : t === "fade" ? "Fade" : "Jump cut"}
            </button>
          ))}
        </div>
      </fieldset>
      <Help more={s.transition === "morph" ? "The speaker's head and hands are smoothly moved from one position to the other, so the join looks like natural movement instead of a jump." : undefined}>
        {s.transition === "morph" && "Morph: the speaker moves smoothly into place."}
        {s.transition === "fade" && "Fade: a quick dissolve between the two moments."}
        {s.transition === "cut" && "Jump cut: the picture switches instantly."}
      </Help>
      {s.transition !== "cut" && <>
        <div className="row"><label htmlFor="len">Blend length</label><span className="val">{s.transition_frames} frames · {ms} ms</span></div>
        <input id="len" type="range" min={2} max={10} step={1} value={s.transition_frames} onChange={(e) => ed.update({ transition_frames: +e.target.value })} />
        <div className="blend-viz" aria-hidden="true">
          <span className="a">before</span>
          <span className="mix" style={{ flexBasis: `${s.transition_frames * 9}%` }}>{s.transition === "morph" ? "morph" : "blend"}</span>
          <span className="b">after</span>
        </div>
        <Help more={<>Short (2–3 frames) is quick and almost invisible, close to a jump cut. Longer (6–10) is softer, but you may notice the blend. Check one with "Check a cut exactly" under the preview.</>}>
          How long the join takes. 4 is a good start.
        </Help>
      </>}
      <p className="muted small">Camera changes are always clean hard cuts, with the crop switching on the exact frame.</p>
    </div>
  );
}

/* ---------- export ---------- */

export function ExportPanel({ ed }: { ed: Ed }) {
  const s = ed.short;
  if (!s) return null;
  return (
    <div className="panel">
      <div className="row"><label htmlFor="xspeed">Export speed</label><span className="val">{(s.speed ?? 1).toFixed(2)}×</span></div>
      <input id="xspeed" type="range" min={0.75} max={2} step={0.05} value={s.speed ?? 1} onChange={(e) => ed.update({ speed: +e.target.value })} />
      <Help more={<>To only <i>watch</i> faster, use the speed buttons on the players instead.</>}>
        Speeds up the exported video; the voice keeps its pitch.
      </Help>
      <PostText ed={ed} />
      <PostYoutube ed={ed} />
    </div>
  );
}

/** Upload the rendered short to the user's own YouTube channel. */
function PostYoutube({ ed }: { ed: Ed }) {
  const s = ed.short!;
  const [yt, setYt] = useState<{ configured: boolean; connected: boolean; channel: string | null } | null>(null);
  const [privacy, setPrivacy] = useState("private");
  const [when, setWhen] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => api.youtube().then(setYt).catch(() => {});
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh); // back from Google's sign-in tab
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const job = ed.jobs.find((j) => j.short_id === s.id && j.kind === "publish");
  const running = job && (job.status === "queued" || job.status === "running");
  const done = s.published?.youtube;
  if (!yt) return null;
  const post = async () => {
    setErr(null);
    try { await api.publishYoutube(ed.lecture.id, s.id, privacy, when ? new Date(when).getTime() / 1000 : null); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="post-text">
      <div className="row"><b>YouTube</b>
        {yt.connected && <span className="small muted">{yt.channel ?? "connected"} · <button type="button" className="link small" onClick={() => api.youtubeDisconnect().then(setYt)}>Disconnect</button></span>}
      </div>
      {!yt.configured ? (
        <Help more="In Google Cloud: create a project, enable the YouTube Data API v3, create an OAuth client of type Desktop app, then put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local and restart. See the README.">
          Set up a Google OAuth client to post to your channel.
        </Help>
      ) : !yt.connected ? (
        <a className="btn small" href="/api/publish/youtube/connect" target="_blank" rel="noreferrer">Connect YouTube channel</a>
      ) : (
        <>
          <label className="field"><span className="small muted">Visibility</span>
            <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} disabled={!!when}>
              <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
            </select></label>
          <label className="field"><span className="small muted">Publish at (optional)</span>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <button type="button" className="btn small primary" disabled={!s.rendered || !!running} onClick={post}
            title={!s.rendered ? "Render the short first" : undefined}>
            {running ? `Uploading… ${Math.round((job!.progress ?? 0) * 100)}%` : when ? "Schedule on YouTube" : "Post to YouTube"}
          </button>
          {job?.status === "error" && <p className="small err-text">{job.message}</p>}
          {err && <p className="small err-text">{err}</p>}
          {done && <p className="small">Posted{done.publish_at ? `, goes public ${new Date(done.publish_at * 1000).toLocaleString()}` : ` (${done.privacy})`}: <a href={done.url} target="_blank" rel="noreferrer">{done.url}</a></p>}
        </>
      )}
    </div>
  );
}

/** Title, description and hashtags to publish the short with. */
function PostText({ ed }: { ed: Ed }) {
  const s = ed.short!;
  const post = s.post ?? { title: "", description: "", hashtags: [] };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (p: Partial<Post>) => ed.update({ post: { ...post, ...p } });
  const write = async () => {
    setBusy(true); setErr(null);
    try { ed.update({ post: (await api.describeShort(ed.lecture.id, s.id)).post ?? null }); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const text = [post.title, post.description, post.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");
  const why = !ed.gemini ? "Needs a Gemini key (GEMINI_API_KEY in .env)" : !ed.transcript ? "Transcribe the video first"
    : !s.ranges.length ? "Add a clip first" : undefined;
  return (
    <div className="post-text">
      <div className="row"><b>Post text</b>
        <button type="button" className="btn small" disabled={busy || !!why} title={why} onClick={write}>
          {busy ? "Writing…" : post.title ? "Write again with Gemini" : "Write with Gemini"}
        </button>
      </div>
      {err && <p className="small err-text">{err}</p>}
      <label className="field"><span className="small muted">Title</span>
        <input type="text" dir="auto" value={post.title} maxLength={100} placeholder="Shown above the video"
          onChange={(e) => set({ title: e.target.value })} /></label>
      <label className="field"><span className="small muted">Description</span>
        <textarea dir="auto" rows={3} value={post.description} onChange={(e) => set({ description: e.target.value })} /></label>
      <label className="field"><span className="small muted">Hashtags</span>
        <input type="text" dir="auto" value={post.hashtags.map((h) => `#${h}`).join(" ")} placeholder="#reminder #quran"
          onChange={(e) => set({ hashtags: e.target.value.split(/[\s,]+/).map((h) => h.replace(/^#/, "")).filter(Boolean) })} /></label>
      <button type="button" className="btn small" disabled={!text} onClick={() => {
        navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
      }}>{copied ? "Copied" : "Copy all"}</button>
    </div>
  );
}

/* ---------- framing ---------- */

export function cropWidth(ed: Ed, zoom: number) {
  const W = ed.lecture.width ?? 1920, H = ed.lecture.height ?? 1080;
  return ((H / zoom) * 9) / 16 / W;
}

/** Thumbnail of one camera with its 9:16 frame; drag the frame to set it by hand. */
function CameraCard({ ed, cam, index }: { ed: Ed; cam: Camera; index: number }) {
  const shortZoom = ed.short?.zoom ?? 1;
  const [zoomDraft, setZoomDraft] = useState<number | null>(null);
  const zoom = zoomDraft ?? cam.zoom ?? shortZoom;
  const cw = Math.min(1, cropWidth(ed, zoom));
  const current = cam.manual?.x ?? cam.auto?.x ?? 0.5;
  const [drag, setDragState] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const setDrag = (v: number | null) => { dragRef.current = v; setDragState(v); };
  const x = drag ?? current;
  const left = Math.min(1 - cw, Math.max(0, x - cw / 2));
  const fromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1 - cw / 2, Math.max(cw / 2, (e.clientX - r.left) / r.width));
  };
  return (
    <li className="cam-card">
      <div className="cam-thumb" style={{ backgroundImage: `url(${api.cameraThumb(ed.lecture.id, cam.id)})` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(fromEvent(e)); }}
        onPointerMove={(e) => dragRef.current != null && setDrag(fromEvent(e))}
        onPointerUp={(e) => {
          if (dragRef.current == null) return;
          const nx = fromEvent(e);
          ed.setFraming(cam.id, { x: Math.round(nx * 1000) / 1000, y: cam.manual?.y ?? cam.auto?.y ?? 0.36 });
          setDrag(null);
        }}
        role="slider" aria-label={`Camera ${index + 1} framing`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(x * 100)} tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.05 : 0.01;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const nx = Math.min(1 - cw / 2, Math.max(cw / 2, current + (e.key === "ArrowLeft" ? -step : step)));
            ed.setFraming(cam.id, { x: Math.round(nx * 1000) / 1000, y: cam.manual?.y ?? cam.auto?.y ?? 0.36 });
          }
        }}>
        <div className={`cam-box ${cam.manual ? "manual" : ""}`} style={{ left: `${left * 100}%`, width: `${cw * 100}%` }} />
      </div>
      <div className="cam-meta">
        <b>Camera {index + 1}</b>
        <span className="muted small">{cam.share >= 0.01 ? `${Math.round(cam.share * 100)}%` : "<1%"} of the video · {cam.has_speaker ? "speaker found" : "speaker not recognised"}</span>
        <span className="small">{cam.manual ? "Your framing (follows this angle even when the camera moves)" : cam.has_speaker ? "Auto: locked on the speaker" : "Auto: centred. Drag the frame to place it"}</span>
        {cam.manual && <button type="button" className="link small" onClick={() => ed.setFraming(cam.id, null)}>Reset position to auto</button>}
        <div className="row cam-zoom">
          <label htmlFor={`camzoom${cam.id}`}>Zoom for this camera</label>
          <span className="val">{cam.zoom == null && zoomDraft == null ? `same as short (${shortZoom.toFixed(2)}×)` : `${zoom.toFixed(2)}×`}</span>
        </div>
        <input id={`camzoom${cam.id}`} type="range" min={0.6} max={1.6} step={0.05} value={zoom}
          onChange={(e) => setZoomDraft(+e.target.value)}
          onPointerUp={() => { if (zoomDraft != null) { ed.setCameraZoom(cam.id, zoomDraft); setZoomDraft(null); } }}
          onKeyUp={() => { if (zoomDraft != null) { ed.setCameraZoom(cam.id, zoomDraft); setZoomDraft(null); } }} />
        {cam.zoom != null && <button type="button" className="link small" onClick={() => ed.setCameraZoom(cam.id, null)}>Use the short's zoom</button>}
      </div>
    </li>
  );
}

/** Cameras by how much of the video they cover; one-off shots come last. */
export function sortedCameras(ed: Ed): Camera[] {
  return [...(ed.cameras?.cameras ?? [])].sort((a, b) => b.count - a.count);
}

export function FramingPanel({ ed }: { ed: Ed }) {
  const [showAll, setShowAll] = useState(false);
  const s = ed.short;
  if (!s) return null;
  // every angle seen at least twice; one-off shots (often cutaways) are listed on request
  const all = sortedCameras(ed);
  const minor = all.filter((c) => c.count < 2).length;
  const cams = showAll ? all : all.filter((c) => c.count >= 2);
  return (
    <div className="panel">
      <div className="row"><label htmlFor="zoom">Zoom (all cameras)</label><span className="val">{s.zoom < 1 ? "wider " : s.zoom > 1 ? "closer " : ""}{s.zoom.toFixed(2)}×</span></div>
      <input id="zoom" type="range" min={0.6} max={1.6} step={0.05} value={s.zoom} onChange={(e) => ed.update({ zoom: +e.target.value })}
        list="zoom-marks" />
      <datalist id="zoom-marks"><option value="1" /></datalist>
      <div className="range-ends small muted"><span>← wider (zoom out)</span><span>closer (zoom in) →</span></div>
      <Help more={s.zoom < 1 ? "More of the scene fits, so the speaker moving left or right is less noticeable. The space above and below is filled with a blurred copy of the picture."
          : s.zoom > 1 ? "Very high zoom can look soft, because the picture is enlarged." : undefined}>
        {s.zoom < 1 ? "Zoomed out: the video no longer fills the screen top to bottom."
          : s.zoom > 1 ? "Zoomed in: a tighter shot of the speaker."
          : "1× uses the full height of the video."}
      </Help>
      <fieldset className="follow-pick">
        <legend>Who to frame</legend>
        <label className="check"><input type="radio" name="follow" checked={(s.follow ?? "main") === "main"}
          onChange={() => ed.update({ follow: "main" })} />The main speaker</label>
        <label className="check"><input type="radio" name="follow" checked={s.follow === "talking"}
          onChange={() => ed.update({ follow: "talking" })} />Whoever is talking</label>
      </fieldset>
      <Help more="For podcasts and interviews with two or more people in the same shot: the frame cuts to the person whose mouth moves with the voice, and holds still for their whole turn. Shown in the rendered short; the quick preview keeps following the main speaker.">
        {s.follow === "talking" ? "Cuts to the person talking when several people share a shot." : "Holds the person who is on screen most."}
      </Help>
      <div className="cams-head"><b>Cameras</b>
        <Help more="The main speaker is recognised in every shot and held in place. A frame you set applies to every shot from that camera.">Drag a frame to set a camera by hand.</Help>
      </div>
      {!ed.cameras || ed.cameras.status === "analyzing" ? (
        <p className="muted small">Finding the cameras and the speaker… (about a minute per hour of video)</p>
      ) : (
        <ul className="cam-list">
          {cams.map((c, i) => <CameraCard key={c.id} ed={ed} cam={c} index={i} />)}
        </ul>
      )}
      {minor > 0 && (
        <p className="muted small">
          {showAll ? `${minor} one-off shots (seen only briefly) are listed last.` : `${minor} one-off shots (seen only briefly) are framed automatically.`}{" "}
          <button type="button" className="link small" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? "Hide them" : "Show them"}
          </button>
        </p>
      )}
    </div>
  );
}

/* ---------- captions & name plate ---------- */

const PRESET_LABEL: Record<string, string> = { box: "Box", pill: "Pill", outline: "Outline", minimal: "Minimal" };

export function effectiveData(ed: Ed): StyleData {
  const s = ed.short!;
  if (s.style_data) return s.style_data;
  const custom = ed.styles?.custom[s.style];
  return custom ?? { base: s.style };
}

export function effectiveCaption(ed: Ed, part: "captions" | "title" = "captions"): TextStyle | null {
  if (!ed.styles) return null;
  const d = effectiveData(ed);
  const base = ed.styles.presets[d.base ?? "box"] ?? ed.styles.presets.box;
  return { ...base[part], ...(d[part] ?? {}) };
}

/** Vertical position as a height from the middle of the screen: 0 = centre,
 * positive = up, negative = down (stored as the 0..1 top-down fraction). */
function HeightSlider({ label, y, onChange }: { label: string; y: number; onChange: (y: number) => void }) {
  const h = Math.round((0.5 - y) * 100);
  return (
    <label className="field">
      <span className="row"><span>{label}</span><span className="val">{h > 0 ? `+${h} (above centre)` : h < 0 ? `${h} (below centre)` : "0 (centre)"}</span></span>
      <input type="range" min={-45} max={45} step={1} value={h} onChange={(e) => onChange(Math.round((0.5 - +e.target.value / 100) * 1000) / 1000)} />
    </label>
  );
}

export function CaptionsPanel({ ed, compact }: { ed: Ed; compact?: boolean }) {
  const s = ed.short;
  if (!s || !ed.styles) return null;
  const cap = effectiveCaption(ed)!;
  const data = effectiveData(ed);
  const names = [...Object.keys(ed.styles.presets), ...Object.keys(ed.styles.custom)];

  const base = data.base ?? (s.style in ed.styles!.presets ? s.style : "box");
  const patch = (p: Partial<TextStyle>) =>
    ed.update({ style_data: { ...data, base, captions: { ...(data.captions ?? {}), ...p } } });
  const patchTitle = (p: Partial<TextStyle>) =>
    ed.update({ style_data: { ...data, base, title: { ...(data.title ?? {}), ...p } } });
  const plate = effectiveCaption(ed, "title")!;

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
      {s.title && <>
        <HeightSlider label="Name plate height" y={plate.y} onChange={(y) => patchTitle({ y })} />
        <label className="field">Name plate size {plate.size}<input type="range" min={24} max={80} step={2} value={plate.size} onChange={(e) => patchTitle({ size: +e.target.value })} /></label>
      </>}
      <HeightSlider label="Caption height" y={cap.y} onChange={(y) => patch({ y })} />
      <label className="field">Caption language
        <select value={s.caption_lang ?? "original"} onChange={(e) => ed.update({ caption_lang: e.target.value })}>
          <option value="original">As spoken ({ed.translationLang === "en" ? "Arabic" : "English"})</option>
          <option value={ed.translationLang} disabled={!ed.translation}>
            {ed.translationLang === "en" ? "English" : "Arabic"} translation{ed.translation ? "" : " (translate the transcript first)"}
          </option>
        </select>
      </label>
      <label className="check" title={s.captions ? "While a recognised Quran verse is quoted, a small line above the captions names the surah and the ayah being recited" : "Shown above the captions, so it needs Burn in captions"}>
        <input type="checkbox" disabled={!s.captions} checked={s.captions && (s.quran_tag ?? true)} onChange={(e) => ed.update({ quran_tag: e.target.checked })} />
        Show surah and ayah when a verse is quoted
      </label>
      {(s.caption_lang ?? "original") === "original" && <label className="field">Harakat (tashkeel) in captions
        <select value={s.harakat ?? "all"} onChange={(e) => ed.update({ harakat: e.target.value as "all" | "quran" | "none" })}>
          <option value="all">Show everywhere</option>
          <option value="quran">Only in Quran quotations</option>
          <option value="none">Hide</option>
        </select>
      </label>}
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
      <label className="check"><input type="checkbox" checked={s.grade} onChange={(e) => ed.update({ grade: e.target.checked })} />Colour grade</label>
      <Help more="A little more contrast and colour, slight sharpening, and gently darkened corners. Leave it off to keep the original colours.">
        A punchier look. Shows in the rendered video only.
      </Help>
    </div>
  );
}

/* ---------- one-line summaries of each settings section ---------- */

export type Section = "pauses" | "look" | "framing" | "export";

export function summary(ed: Ed, sec: Section): string {
  const s = ed.short;
  if (!s) return "";
  if (sec === "pauses") {
    const how = s.transition === "morph" ? "Morph" : s.transition === "fade" ? "Fade" : "Jump cut";
    return `Over ${s.min_gap.toFixed(2)} s · ${how}${s.transition !== "cut" ? `, ${s.transition_frames} frames` : ""}`;
  }
  if (sec === "look") {
    const base = s.style_data ? `${PRESET_LABEL[s.style_data.base ?? "box"] ?? s.style_data.base} (customised)` : PRESET_LABEL[s.style] ?? s.style;
    const spoken = ed.translationLang === "en" ? "Arabic" : "English";
    const original = (s.caption_lang ?? "original") === "original";
    const harakat = { all: "harakat everywhere", quran: "harakat in Quran only", none: "no harakat" }[s.harakat ?? "all"];
    const caps = !s.captions ? "No captions" : `${base} · ${original ? `${spoken}, ${harakat}` : ed.translationLang === "en" ? "English" : "Arabic"}`;
    return caps + (s.grade ? " · graded" : "");
  }
  if (sec === "framing") {
    const cams = (ed.cameras?.cameras ?? []).filter((c) => c.count >= 2);
    const manual = cams.filter((c) => c.manual).length;
    return `Zoom ${s.zoom.toFixed(2)}× · ${cams.length} camera${cams.length === 1 ? "" : "s"}${manual ? `, ${manual} set by hand` : ""}`;
  }
  return (s.speed ?? 1) === 1 ? "Normal speed" : `${(s.speed ?? 1).toFixed(2)}× speed`;
}
