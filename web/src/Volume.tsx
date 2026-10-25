import { useEffect, useState } from "react";

/**
 * The app's volume control: one setting for every player, remembered between
 * visits. Players are routed through a shared gain node (Web Audio) rather than
 * their own .volume, which the preview uses for its crossfades.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const VOLUME_KEY = "volume";
const listeners = new Set<(v: Vol) => void>();
interface Vol { level: number; muted: boolean }

function loadVolume(): Vol {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null");
    if (v && typeof v.level === "number") return { level: Math.min(1, Math.max(0, v.level)), muted: !!v.muted };
  } catch { /* storage unavailable */ }
  return { level: 1, muted: false };
}
let volume = loadVolume();

function setVolume(v: Vol) {
  volume = v;
  if (master) master.gain.value = v.muted ? 0 : v.level ** 2; // squared: the slider feels even to the ear
  try { localStorage.setItem(VOLUME_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
  listeners.forEach((f) => f(v));
}

function audioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume.muted ? 0 : volume.level ** 2;
    master.connect(ctx.destination);
  }
  return ctx;
}

function sourceFor(el: HTMLMediaElement): MediaElementAudioSourceNode {
  let src = sources.get(el);
  if (!src) {
    const c = audioContext();
    src = c.createMediaElementSource(el);
    src.connect(master!); // through the volume control to the speakers
    sources.set(el, src);
    // browsers start audio contexts suspended until the user interacts
    el.addEventListener("play", () => { if (c.state !== "running") c.resume(); });
  }
  return src;
}

export function VolumeControl({ getMedia }: { getMedia: () => (HTMLMediaElement | null)[] }) {
  const [v, setV] = useState(volume);
  useEffect(() => { listeners.add(setV); return () => { listeners.delete(setV); }; }, []);
  useEffect(() => {
    (getMedia().filter(Boolean) as HTMLMediaElement[]).forEach(sourceFor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const silent = v.muted || v.level === 0;
  const pct = Math.round((v.muted ? 0 : v.level) * 100);
  // an icon (click to mute); the slider pops up on hover or keyboard focus
  return (
    <div className="vol">
      <button type="button" className="icon vol-mute" aria-label={silent ? "Unmute" : "Mute"} title={`${silent ? "Unmute" : "Mute"} · volume ${pct}%`}
        onClick={() => setVolume({ level: v.level === 0 ? 0.7 : v.level, muted: !silent })}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
          {silent ? <path d="M17 9l5 6M22 9l-5 6" /> : <>
            <path d="M16.5 9.5a3.5 3.5 0 010 5" />{v.level >= 0.5 && <path d="M19 7a7 7 0 010 10" />}
          </>}
        </svg>
      </button>
      <div className="vol-pop">
        <input type="range" min={0} max={1} step={0.02} value={v.muted ? 0 : v.level} aria-label="Volume"
          onChange={(e) => setVolume({ level: +e.target.value, muted: false })} />
        <span className="vol-val tc">{pct}%</span>
      </div>
    </div>
  );
}
