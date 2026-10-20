import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Range } from "./api";
import { RenderButton, TopBar, type Ed } from "./Editor";
import { CaptionsPanel, ClipList, CutsPanel, Preview, Stats } from "./panels";
import { fmt, normalize } from "./util";

export function Read({ ed }: { ed: Ed }) {
  const tr = ed.transcript;
  const s = ed.short;
  const video = useRef<HTMLVideoElement>(null);
  const article = useRef<HTMLElement>(null);
  const stopAt = useRef<number | null>(null);
  const [time, setTime] = useState(0);
  const [sel, setSel] = useState<[number, number] | null>(null); // word indices, inclusive
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);

  const words = tr?.words ?? [];
  const wordSeg = useMemo(() => {
    const m = new Int32Array(words.length);
    tr?.segments.forEach((g, k) => { for (let i = g.w0; i < g.w1; i++) m[i] = k; });
    return m;
  }, [tr, words.length]);
  const segOf = (i: number): [number, number] => {
    const g = tr!.segments[wordSeg[i]];
    return [g.w0, g.w1 - 1];
  };
  const norm = useMemo(() => words.map((w) => normalize(w.w)), [words]);

  // ----- search -----
  const hits = useMemo(() => {
    const toks = query.trim().split(/\s+/).map(normalize).filter(Boolean);
    if (!toks.length) return [] as [number, number][];
    const out: [number, number][] = [];
    for (let i = 0; i + toks.length <= norm.length; i++) {
      if (toks.every((t, k) => norm[i + k].includes(t))) out.push([i, i + toks.length - 1]);
    }
    return out;
  }, [query, norm]);
  const hitSet = useMemo(() => {
    const set = new Set<number>();
    for (const [a, b] of hits) for (let i = a; i <= b; i++) set.add(i);
    return set;
  }, [hits]);
  useEffect(() => setHitIdx(0), [query]);
  const jump = (k: number) => {
    if (!hits.length) return;
    const n = (k + hits.length) % hits.length;
    setHitIdx(n);
    const el = article.current?.querySelector(`[data-i="${hits[n][0]}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    seek(words[hits[n][0]].s);
  };

  // ----- playback -----
  const seek = (t: number) => {
    const v = video.current;
    if (v) v.currentTime = t;
    setTime(t);
  };
  const playRange = (r: Range) => {
    seek(r[0]);
    stopAt.current = r[1];
    video.current?.play();
  };
  const onTime = () => {
    const v = video.current;
    if (!v) return;
    setTime(v.currentTime);
    if (stopAt.current != null && v.currentTime >= stopAt.current) { v.pause(); stopAt.current = null; }
  };

  // highlight the spoken word without re-rendering the whole transcript
  const nowIdx = useMemo(() => {
    let lo = 0, hi = words.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].s <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }, [time, words]);
  useEffect(() => {
    const root = article.current;
    if (!root) return;
    root.querySelector(".now")?.classList.remove("now");
    if (nowIdx >= 0) root.querySelector(`[data-i="${nowIdx}"]`)?.classList.add("now");
  }, [nowIdx]);

  // ----- selection -> word range -----
  // click = whole sentence, shift+click = extend, drag = everything touched (snapped to sentences)
  const onMouseUp = (e: React.MouseEvent) => {
    if (!tr) return;
    const sx = window.getSelection();
    const idx = (n: Node | null) => {
      const el = (n instanceof HTMLElement ? n : n?.parentElement)?.closest("[data-i]");
      return el ? Number(el.getAttribute("data-i")) : null;
    };
    if (sx && !sx.isCollapsed && sx.rangeCount) {
      const inside = [...(article.current?.querySelectorAll("[data-i]") ?? [])].filter((el) => sx.containsNode(el, true));
      if (!inside.length) return;
      const a = Number(inside[0].getAttribute("data-i"));
      const b = Number(inside[inside.length - 1].getAttribute("data-i"));
      setSel([segOf(Math.min(a, b))[0], segOf(Math.max(a, b))[1]]);
      sx.removeAllRanges();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest(".ts")) return;
    let i = idx(target);
    if (i == null) {
      const para = target.closest("[data-seg]");
      if (!para) return;
      i = tr.segments[Number(para.getAttribute("data-seg"))].w0;
    }
    const [a, b] = segOf(i);
    if (e.shiftKey && sel) setSel([Math.min(sel[0], a), Math.max(sel[1], b)]);
    else { setSel([a, b]); seek(words[a].s); }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const selRange: Range | null = sel ? [words[sel[0]].s, words[sel[1]].e] : null;
  const clearSel = () => { setSel(null); window.getSelection()?.removeAllRanges(); };

  // ----- transcript markup (memoised; only changes with words/ranges/search/gap) -----
  const ranges = s?.ranges ?? [];
  const minGap = s?.min_gap ?? 0.4;
  const body = useMemo(() => {
    if (!tr) return null;
    const inShort = (t: number) => ranges.some(([a, b]) => t >= a && t <= b);
    return tr.segments.map((seg, k) => {
      const parts: React.ReactNode[] = [];
      for (let i = seg.w0; i < seg.w1; i++) {
        const w = tr.words[i];
        if (i > seg.w0) {
          const gap = w.s - tr.words[i - 1].e;
          parts.push(gap > minGap
            ? <span key={`g${i}`} className={`pause ${inShort(w.s) ? "cut" : ""}`} dir="ltr">{gap.toFixed(1)}s</span>
            : " ");
        }
        const picked = sel != null && i >= sel[0] && i <= sel[1];
        const cls = [inShort((w.s + w.e) / 2) ? "in" : "", hitSet.has(i) ? "hit" : "", picked ? "picked" : ""].join(" ").trim();
        parts.push(<span key={i} data-i={i} className={cls || undefined}>{w.w}</span>);
      }
      return (
        <div className={`para ${sel && seg.w0 >= sel[0] && seg.w1 - 1 <= sel[1] ? "picked" : ""}`} key={k} data-seg={k}>
          <button type="button" className="ts" dir="ltr" onClick={() => { seek(seg.s); video.current?.play(); }} aria-label={`Play from ${fmt(seg.s)}`}>{fmt(seg.s)}</button>
          <p>{parts}</p>
        </div>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr, JSON.stringify(ranges), minGap, hitSet, sel]);

  const lang = tr?.language ?? ed.lecture.language ?? "ar";
  const rtl = ["ar", "fa", "ur", "he"].includes(lang);

  return (
    <div className="app read">
      <TopBar ed={ed} mode="read" />
      <div className="read-grid">
        <nav className="shorts-nav" aria-label="Shorts in this lecture">
          <div className="eyebrow">Shorts · {ed.shorts.length}</div>
          {ed.shorts.map((x) => (
            <a key={x.id} href={`#/l/${ed.lecture.id}/read/${x.id}`} className={`short-card ${x.id === s?.id ? "on" : ""}`}>
              <span className="name" dir="auto">{x.name}</span>
              <span className="meta">{x.ranges.length ? `${fmt(x.ranges[0][0], 0)} · ${x.ranges.length} clip${x.ranges.length > 1 ? "s" : ""}` : "empty"}{x.rendered ? " · rendered" : ""}</span>
            </a>
          ))}
          <button type="button" className="btn dashed" onClick={() => ed.newShort()}>+ New short</button>
          {s && ed.shorts.length > 1 && (
            <button type="button" className="link danger" onClick={() => { if (confirm(`Delete ${s.name}?`)) ed.removeShort(s.id); }}>Delete this short</button>
          )}
        </nav>

        <main className="doc">
          {!tr ? (
            <div className="no-transcript">
              <h2>This lecture has no transcript yet</h2>
              <p>Transcribing lets you read, search and select by sentence. It runs on your GPU — about a minute or two per hour of lecture.</p>
              {ed.transcribeJob ? (
                <div className="render-progress block" role="status">
                  <span>Transcribing… {Math.round(ed.transcribeJob.progress * 100)}%</span>
                  <progress max={1} value={ed.transcribeJob.progress} />
                </div>
              ) : (
                <button type="button" className="btn dark" onClick={ed.transcribe}>Transcribe lecture</button>
              )}
              <p className="muted">Or pick moments by time in <a href={`#/l/${ed.lecture.id}/studio${s ? `/${s.id}` : ""}`}>Studio</a>.</p>
            </div>
          ) : (
            <>
              <div className="search-row">
                <label className="search">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                  <span className="sr">Search lecture</span>
                  <input type="search" dir="auto" value={query} placeholder="Search this lecture" onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") jump(hitIdx + (e.shiftKey ? -1 : 1)); }} />
                  {query && <span className="count">{hits.length ? `${hitIdx + 1} / ${hits.length}` : "no matches"}</span>}
                </label>
                <button type="button" className="btn small" disabled={!hits.length} onClick={() => jump(hitIdx - 1)} aria-label="Previous match">↑</button>
                <button type="button" className="btn small" disabled={!hits.length} onClick={() => jump(hitIdx + 1)} aria-label="Next match">↓</button>
                <span className="howto"><span><b>Click</b> a sentence to select it</span><span><b>Shift+click</b> another to extend</span><span><b>Drag</b> across lines</span><span><b>Esc</b> clears</span></span>
              </div>
              <article ref={article} lang={lang} dir={rtl ? "rtl" : "ltr"} className={`transcript ${rtl ? "rtl" : ""}`} onMouseUp={onMouseUp}>
                {body}
              </article>
            </>
          )}

          {selRange && (
            <div className="sel-bar" role="toolbar" aria-label="Selection">
              <span className="tc">{fmt(selRange[0])} – {fmt(selRange[1])}</span>
              <span className="dim">{(selRange[1] - selRange[0]).toFixed(1)}s · {sel![1] - sel![0] + 1} words</span>
              <button type="button" className="btn small inv" onClick={() => playRange(selRange)}>Play</button>
              <button type="button" className="btn small inv" onClick={() => { ed.addRange(selRange); clearSel(); }}>Add to {s?.name ?? "short"}</button>
              <button type="button" className="btn small mint" onClick={() => { ed.newShort([selRange]); clearSel(); }}>New short</button>
              <button type="button" className="icon inv" aria-label="Clear selection" onClick={clearSel}>✕</button>
            </div>
          )}
        </main>

        <aside className="read-side" aria-label="Preview and look">
          <video ref={video} className="mini-player" src={api.videoUrl(ed.lecture.id)} controls preload="metadata" playsInline onTimeUpdate={onTime} />
          <Preview ed={ed} t={selRange ? selRange[0] + 0.5 : time} width={234} />
          <Stats ed={ed} />
          <ClipList ed={ed} onPlay={playRange} />
          <details className="card"><summary>Look &amp; name plate</summary><CaptionsPanel ed={ed} compact /></details>
          <details className="card"><summary>Cuts &amp; transitions</summary><CutsPanel ed={ed} /></details>
          <RenderButton ed={ed} block />
        </aside>
      </div>
    </div>
  );
}
