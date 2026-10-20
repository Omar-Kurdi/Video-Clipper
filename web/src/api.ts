export type Range = [number, number];

export interface Job {
  id: string;
  kind: "download" | "analyze" | "transcribe" | "render";
  status: "queued" | "running" | "done" | "error";
  progress: number;
  stage: string;
  message: string;
  lecture_id?: string;
  short_id?: string;
  name?: string;
  created: number;
}

export interface Lecture {
  id: string;
  title: string;
  status: "importing" | "analyzing" | "ready" | "error";
  transcript: "none" | "running" | "ready";
  has_transcript: boolean;
  language: string | null;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  created: number;
  shorts: number;
  job: Job | null;
}

export interface TextStyle {
  font: string;
  size: number;
  color: string;
  highlight: string | null;
  box: boolean;
  box_color: string;
  box_opacity: number;
  radius: number;
  pad_x: number;
  pad_y: number;
  outline: number;
  outline_color: string;
  shadow: number;
  y: number;
  max_words: number;
  max_chars: number;
  fade_ms: number;
}

export interface StyleData {
  base?: string;
  captions?: Partial<TextStyle>;
  title?: Partial<TextStyle>;
}

export interface ShortSettings {
  name: string;
  ranges: Range[];
  title: string | null;
  style: string;
  style_data: StyleData | null;
  min_gap: number;
  transition: "morph" | "fade" | "cut";
  transition_frames: number;
  zoom: number;
  grade: boolean;
  captions: boolean;
}

export interface Short extends ShortSettings {
  id: string;
  lecture_id: string;
  created: number;
  rendered: boolean;
  job: Job | null;
  last_render?: { duration: number; cuts: number; hard_cuts: number; at: number };
}

export interface Estimate {
  selected: number;
  duration: number;
  cuts: number;
  segments: Range[];
}

export interface Word { w: string; s: number; e: number }
export interface Transcript {
  language: string;
  words: Word[];
  segments: { s: number; e: number; w0: number; w1: number }[];
}

export interface Styles {
  presets: Record<string, { captions: TextStyle; title: TextStyle }>;
  custom: Record<string, StyleData>;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return r.json() as Promise<T>;
}

const json = (body: unknown, method = "POST"): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

export const defaultSettings = (name = "Short 1"): ShortSettings => ({
  name, ranges: [], title: null, style: "box", style_data: null, min_gap: 0.4,
  transition: "morph", transition_frames: 4, zoom: 1, grade: false, captions: true,
});

export const api = {
  lectures: () => req<Lecture[]>("/api/lectures"),
  lecture: (id: string) => req<Lecture>(`/api/lectures/${id}`),
  importUrl: (url: string, language: string | null) => req<Lecture>("/api/lectures/url", json({ url, language })),
  importLocal: (path: string, language: string | null) => req<Lecture>("/api/lectures/local", json({ path, language })),
  importFile: (file: File, language: string | null) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("language", language ?? "");
    return req<Lecture>("/api/lectures/upload", { method: "POST", body: fd });
  },
  deleteLecture: (id: string) => req<{ ok: boolean }>(`/api/lectures/${id}`, { method: "DELETE" }),
  waveform: (id: string) => req<{ rate: number; peaks: number[] }>(`/api/lectures/${id}/waveform`),
  speech: (id: string) => req<Range[]>(`/api/lectures/${id}/speech`),
  transcript: (id: string) => req<Transcript>(`/api/lectures/${id}/transcript`),
  transcribe: (id: string) => req<Job>(`/api/lectures/${id}/transcribe`, { method: "POST" }),
  estimate: (id: string, s: ShortSettings) => req<Estimate>(`/api/lectures/${id}/estimate`, json(s)),
  preview: async (id: string, body: object) => {
    const r = await fetch(`/api/lectures/${id}/preview`, json(body));
    if (!r.ok) throw new Error("preview failed");
    return URL.createObjectURL(await r.blob());
  },
  speaker: (id: string) => req<[number, number, number][]>(`/api/lectures/${id}/speaker`),
  previewCut: async (id: string, s: ShortSettings, pause: Range) => {
    const r = await fetch(`/api/lectures/${id}/preview-cut`, json({ ...s, pause }));
    if (!r.ok) throw new Error("cut preview failed");
    return URL.createObjectURL(await r.blob());
  },
  shorts: (id: string) => req<Short[]>(`/api/lectures/${id}/shorts`),
  createShort: (id: string, s: ShortSettings) => req<Short>(`/api/lectures/${id}/shorts`, json(s)),
  updateShort: (id: string, sid: string, s: ShortSettings) => req<Short>(`/api/lectures/${id}/shorts/${sid}`, json(s, "PUT")),
  deleteShort: (id: string, sid: string) => req<{ ok: boolean }>(`/api/lectures/${id}/shorts/${sid}`, { method: "DELETE" }),
  render: (id: string, sid: string) => req<Job>(`/api/lectures/${id}/shorts/${sid}/render`, { method: "POST" }),
  jobs: (lectureId?: string) => req<Job[]>(`/api/jobs${lectureId ? `?lecture_id=${lectureId}` : ""}`),
  styles: () => req<Styles>("/api/styles"),
  saveStyle: (name: string, data: StyleData) => req<{ ok: boolean }>("/api/styles", json({ name, data })),
  videoUrl: (id: string) => `/api/lectures/${id}/video`,
  thumbUrl: (id: string) => `/api/lectures/${id}/thumb`,
  shortVideoUrl: (id: string, sid: string, v?: number) => `/api/lectures/${id}/shorts/${sid}/video${v ? `?v=${v}` : ""}`,
};
