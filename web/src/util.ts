import { useEffect, useRef, useState } from "react";

export function fmt(t: number, decimals = 1): string {
  if (!isFinite(t)) return "--:--";
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

export function parseTime(s: string): number | null {
  const parts = s.trim().split(":").map(Number);
  if (!parts.length || parts.some((p) => isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Arabic-friendly normalisation for search: drop tashkeel/tatweel, unify alef/ya/ta marbuta. */
export function normalize(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Calls fn every `ms` while mounted; fn can return a new interval. */
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function storage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function store(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/** Pauses between speech spans longer than minGap, clipped to [a, b]. */
export function pausesIn(speech: [number, number][], minGap: number, a = -Infinity, b = Infinity) {
  const out: [number, number][] = [];
  for (let i = 1; i < speech.length; i++) {
    const s = speech[i - 1][1], e = speech[i][0];
    if (e - s > minGap && e > a && s < b) out.push([Math.max(s, a), Math.min(e, b)]);
  }
  return out;
}
