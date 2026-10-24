export type Range = [number, number];

export interface Job {
  id: string;
  kind: "download" | "analyze" | "transcribe" | "translate" | "proofread" | "render" | "cameras";
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
  speed?: number;   // export speed (voice pitch kept)
  harakat?: "all" | "quran" | "none";  // tashkeel in captions
  caption_lang?: string;  // "original", or a translation's language ("en", "ar")
  quran_tag?: boolean;    // surah and ayah on screen while a Quran verse is quoted
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

export interface Word {
  w: string; s: number; e: number; quran?: string; spoken?: string;
  /** recognisers disagreed: "doubt" = no other model heard this word; "voted" = replaced by what two others heard */
  flag?: "doubt" | "voted" | "gemini";  // "gemini": changed by Gemini proofreading (reason in why)
  alts?: string[];  // what the other recognisers heard (or, for "voted"/"gemini", the original reading)
  why?: string;
  checked?: string;  // a doubtful word Gemini confirmed
}
export interface Source {
  type: "quran" | "hadith";
  w0: number; w1: number;
  ref: string | null;      // "البقرة 2:93" / "Sahih al-Bukhari 755"
  url: string | null;
  grade?: string | null;
  text?: string | null;    // exact Quran text / the hadith's reference wording
  english?: string;
  cued?: boolean;
  places?: number;        // Quran words found in this many places (ref starts with "~": no surah/ayah claimed)
  keep_spoken?: boolean;  // Quran with the lecturer's own harakat (a reading he is discussing)
}
export interface Transcript {
  language: string;
  words: Word[];
  segments: { s: number; e: number; w0: number; w1: number; edited?: boolean }[];
  sources?: Source[];
  engine?: "whisper" | "tashkeel";
}

export interface Translation {
  lang: string;
  source_lang: string;
  model: string;
  quran: string;  // published Quran translation used for whole verses
  segments: { text: string; source: string; edited?: boolean }[];  // per sentence; `source` = the text it was made from
}

export interface Camera {
  id: number;
  count: number;
  share: number;
  has_speaker: boolean;
  auto: { x: number; y: number; w: number } | null;
  manual: { x: number; y: number } | null;
  zoom?: number | null;
}
export interface Cameras { status: "ready" | "analyzing"; has_lecturer?: boolean; cameras: Camera[]; job?: Job }

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
  name, ranges: [], title: null, style: "pill", style_data: null, min_gap: 0.4,
  transition: "morph", transition_frames: 4, zoom: 1, grade: false, captions: true, speed: 1, harakat: "all", quran_tag: true,
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
  editSegment: (id: string, k: number, text: string | null) =>
    req<Transcript>(`/api/lectures/${id}/transcript/segments/${k}`, json({ text }, "PUT")),
  features: () => req<{ gemini: boolean }>("/api/features"),
  proofread: (id: string) => req<Job>(`/api/lectures/${id}/proofread`, { method: "POST" }),
  translation: (id: string, lang: string) => req<Translation>(`/api/lectures/${id}/translation/${lang}`),
  editTranslation: (id: string, lang: string, k: number, text: string) =>
    req<Translation>(`/api/lectures/${id}/translation/${lang}/segments/${k}`, json({ text }, "PUT")),
  translate: (id: string, lang: string) => req<Job>(`/api/lectures/${id}/translate?lang=${lang}`, { method: "POST" }),
  transcribe: (id: string, engine = "tashkeel") => req<Job>(`/api/lectures/${id}/transcribe?engine=${engine}`, { method: "POST" }),
  estimate: (id: string, s: ShortSettings) => req<Estimate>(`/api/lectures/${id}/estimate`, json(s)),
  preview: async (id: string, body: object) => {
    const r = await fetch(`/api/lectures/${id}/preview`, json(body));
    if (!r.ok) throw new Error("preview failed");
    return URL.createObjectURL(await r.blob());
  },
  speaker: (id: string) => req<[number, number, number, number?, (number | null)?][]>(`/api/lectures/${id}/speaker`),
  cameras: (id: string) => req<Cameras>(`/api/lectures/${id}/cameras`),
  framingAt: (id: string, t: number) =>
    req<{ camera: number | null; mode: "manual" | "lecturer" | "camera" | "none"; x: number; y: number; zoom: number | null }>(
      `/api/lectures/${id}/framing-at?t=${t.toFixed(3)}`),
  setFramingAt: (id: string, t: number, x: number) => req<Camera>(`/api/lectures/${id}/framing-at`, json({ t, x }, "PUT")),
  setCameraZoom: (id: string, cid: number, zoom: number | null) =>
    req<Camera>(`/api/lectures/${id}/cameras/${cid}`, json({ zoom }, "PUT")),
  setFraming: (id: string, cid: number, manual: { x: number; y: number } | null) =>
    req<Camera>(`/api/lectures/${id}/cameras/${cid}`, json({ manual }, "PUT")),
  cameraThumb: (id: string, cid: number) => `/api/lectures/${id}/cameras/${cid}/thumb`,
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
