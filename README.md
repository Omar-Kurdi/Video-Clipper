# Video Clipper — lecture → vertical shorts

Turns selected moments of a long, single-speaker lecture into 9:16 shorts:
pauses removed with optical-flow "morph" cuts, a crop that follows the speaker,
clean hard cuts on camera changes, styled word captions (right-to-left for
Arabic) and an optional name plate.

Needs `ffmpeg` (with NVENC), an NVIDIA GPU, Pillow built with raqm, Node 18+
for the web app, and `pip install -r requirements.txt`.

Models download on first use: about 11 GB for transcription (Whisper 2.9 GB,
the two Cohere models 3.9 GB each, NVIDIA's checker 0.4 GB) and about 8 GB
more if you use translation. Only one runs on the GPU at a time (peak about
4.5 GB). Cohere Transcribe Arabic is gated: accept its terms on its
[Hugging Face page](https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026)
and log in once with `hf auth login`; without it, transcription still works
with the Tashkeel model alone. See [Credits](#credits) for every model.

## Web app

```bash
./install.sh   # once: .venv, Python packages, web build (re-run after pulling updates)
./start.sh     # runs in the background, prints the address (8000, or the next free port)
./stop.sh      # stops it
```

Logs go to `.run/server.log`. Heavy work runs at low priority. Long shorts
are cut in passes of at most 8 clips, so memory stays around 2 GB however
long the short is. Encoding uses the GPU (NVENC) when available; otherwise a
light CPU setting is used, and the render log says which. To run in the foreground instead:
`python -m server`.

- **Library** (the home page) – paste a YouTube link or a file path already on
  this computer (linked, not copied) into one field, or drop a video anywhere on
  the page. Each lecture is analysed once: waveform, pauses, thumbnail. Each
  lecture lists its shorts; click one to open it.
- **Editor** – one screen, left to right: the transcript (search; click a
  sentence to select it, shift+click to extend, double-click to correct the
  text, and corrections are used in the captions), the video, then the preview
  and settings (clips, cuts, captions, framing). The waveform timeline runs
  under the transcript and video (`I` / `O` to mark, `Enter` to add, drag to
  select, scroll to move, `Ctrl`+scroll to zoom). Shorts are tabs in the top
  bar, next to the Render button. Selecting in either place selects in both.
  What's in the short is shown in red everywhere: transcript, 9:16 frame and
  timeline.
- **Framing**: each lecture is analysed once. Camera angles are recognised
  by matching the architecture in the picture, so a moving audience, a pan or
  a small zoom doesn't split one angle into several. The lecturer is found by
  face recognition, so he is framed even in wide shots where audience faces
  are bigger, and held in the same spot every time an angle comes back.
  Pause and drag the orange frame on the video (or a camera card in the
  Framing tab) to set an angle by hand. It's stored relative to the scene and
  mapped onto every shot of that angle, even if the camera moved. Each angle
  can also have its own zoom. The CLI does the same, cached in
  `<video>.cameras.json/.npz`; use `--no-lock` to just follow the main face.
- Settings (pause threshold, morph/fade/jump
  cuts, caption style, name plate and caption height, zoom in or out, grade,
  export speed) update a live 9:16 preview;
  **Render** runs in the background and the result plays and downloads in place.
- **Accurate Arabic**: Arabic lectures are transcribed with Whisper for the
  word timings, then the audio is re-read by
  [Cohere Transcribe Arabic](https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026)
  for the words (in up to 35 s chunks cut at pauses, as Cohere's own long-form
  mode does: it reads much better with that context) and its fine-tune
  [Cohere-Speech-Tashkeel-2B](https://huggingface.co/NAMAA-Space/Cohere-Speech-Tashkeel-2B)
  for the harakat. Audio is prepared exactly as Cohere's reference code does
  (librosa-style downmix and soxr resampling), since the models are sensitive
  to it. Every word is then checked against the Tashkeel model, Whisper and
  NVIDIA's FastConformer (aligned word by word): where two agree on something
  else, the majority wins (a lone «و» of difference never replaces a word);
  where only the Tashkeel model, Cohere's own fine-tune, backs a word that
  Whisper and NVIDIA both dispute, it's flagged; where nobody backs a word it gets a
  red wavy underline (amber dotted = changed by majority), and hovering shows
  what the others heard. Captions can show harakat everywhere, only in Quran
  quotations, or not at all. Older transcripts get an **Upgrade to accurate
  Arabic** button.
- **Quran and hadith**: quotations are found by matching the transcript
  against the whole Quran and the six hadith books (helped by cues such as
  «قال تعالى» or «قال رسول الله ﷺ»). Without a cue a quotation needs 5 matching
  words; right after one, 2 are enough (e.g. «وَٱلرُّجْزَ فَٱهْجُرْ»), and a verse
  the lecturer says again straight away counts too. Quran quotations are
  replaced by the exact Uthmani text and linked to quran.com. Words that fit
  several places in the Quran are marked as Quran without naming a surah;
  when the lecturer discusses a reading («وفي قراءة», «قرأ يعقوب», «بالكسر»)
  his own harakat are kept instead of Hafs. Hadith show their collection,
  number, grading and sunnah.com link; inside a hadith, a word one of the
  recognisers heard the collection's way (or a doubtful one a letter off) is
  corrected to its wording («الطاعون ريجز» → «الطَّاعُونُ رِجْزٌ»), and the
  lecturer's own phrasing is otherwise kept. Doubtful words one letter from
  a word of the lecture's title become that word («والرجل» → «والرِّجز» in a
  lecture on الرجز). Texts download once into `models/texts/`. In
  the video, a small gold line above the captions names the surah and ayah
  while a verse is quoted («سورة البقرة، الآية ٩٣», or "Quran · Al-Baqarah
  2:93" with English captions); it can be turned off.
- **Proofread with Gemini** (optional, online): with `GEMINI_API_KEY` in
  `.env` (see `.env.example`; a free key from aistudio.google.com works), the
  transcript gets a **Proofread doubtful words with Gemini** button. The audio
  and transcript go to Google's Gemini, which hears the speech and knows Arabic,
  the Quran and hadith; only the underlined words can change (blue underline,
  its reason on hover), Quran text never; a word misheard as two is joined
  back («وسوسة هو» → «وسوسته»). One request per 30 minutes of audio. If the
  model is busy or out of free quota, the next newest Flash model is tried.
  The key can live in `.env` or `.env.local` (both git-ignored). On the free
  tier Google may use what you send to improve its products. On the Sa'd test
  lecture it took word errors from 6.6 % to 6.2 % (letters 4.1 % → 3.3 %).
- **Translation** (optional): **Translate to English** (or to Arabic, for an
  English lecture) translates every sentence on the GPU with
  Qwen3-4B-Instruct. Whole Quran verses use the Saheeh International
  translation word for word; hadith use the collection's English as a
  reference. Show it under each sentence, double-click to correct it (your
  corrections survive re-translating), and pick it as the caption language.
- **Speed**: the preview can play at 1.25–2× on its own; **Export speed**
  speeds up the render with the voice pitch kept (ffmpeg `atempo`).
- Under the video and the preview: a **volume control** (slider and mute, one
  setting for the whole app, remembered).
- **Check a cut exactly** (under the preview): the instant preview only
  approximates morph cuts; pick one removed pause and render just that moment
  as the export will look.

App data lives in `data/` (override with `SHORTS_DATA=/path`). For frontend
development run `npm run dev` in `web/` (proxies `/api` to port 8000).

## Command line

```bash
# just give time ranges (from any video player) — no transcript needed;
# only the selected ranges are transcribed for captions
python -m shorts make lecture.mp4 --range 12:30-13:45 -o out/short1.mp4

# optional: full transcript to search/read when picking ranges
python -m shorts transcribe lecture.mp4    # -> lecture.transcript.txt
```

Ranges are `START-END` (`75-90`, `1:15-1:30.5`, `1:01:15-1:02:00`), repeatable;
they are joined in order. `--no-captions` skips speech recognition entirely.

### Transitions
`--transition morph` (default) warps the last frame before a pause into the
first frame after it using optical flow; `fade` is an eased dissolve; `cut`
leaves jump cuts. `--transition-frames 4` sets the length (6 = softer).
Joins that land on a camera change are always clean hard cuts, and the crop
switches on that exact frame.

### Caption styles
`--style pill|box|outline|minimal` (default `pill`), or a JSON file that starts from a preset
and overrides any field — see [styles/example.json](styles/example.json):

| key | meaning |
|---|---|
| `font` | fontconfig name (`"Vazirmatn:style=Bold"`) or path to a .ttf |
| `size`, `color`, `highlight` | text size, colour, colour of the spoken word (`null` = off) |
| `box`, `box_color`, `box_opacity`, `radius`, `pad_x`, `pad_y` | background box |
| `outline`, `outline_color`, `shadow` | text stroke and soft shadow |
| `y` | vertical centre (0 = top, 1 = bottom) |
| `max_words`, `max_chars`, `fade_ms` | caption chunking and fade-in |

`captions` styles the subtitles, `title` the name plate (`--title "..."`).

Other flags: `--min-gap 0.4` (cut pauses longer than this), `--zoom 1.15`
(tighter crop), `--grade`, `--speed 1.25` (faster, same voice pitch), `--keep-temp`.

## How it works

1. **plan** (`shorts/plan.py`) – Silero VAD finds pauses in the selected audio;
   speech is padded, every segment snapped to whole frames.
2. **cut** (`shorts/cut.py`) – one seeked input per segment, video hard-joined,
   audio crossfaded over the transition length (A/V stay frame-exact).
3. **reframe** (`shorts/reframe.py`) – YuNet face tracking, damped virtual
   camera, camera-change detection at the exact frame.
4. **transitions** (`shorts/transitions.py`) – morph/fade frames synthesized at
   same-camera joins; the crop glides across them.
5. **render** (`shorts/render.py`, `shorts/captions.py`) – crop, scale to
   1080×1920, composite Pillow-rendered captions, encode with NVENC.

`shorts/pipeline.py` wraps all of this in one call (`make_short`) used by both
the CLI and the web server (`server/`: FastAPI, a GPU job queue, JSON storage).

## Tests

```bash
python tests/test_sources.py   # Quran/hadith recognition, title vocabulary, word alignment (no GPU)
python tests/test_credits.py   # every model and dataset is credited below
```

## Checking a render

`python tests/verify_render.py <video> --range 322-445` renders a short and
checks it is exactly what the editor planned. It compares the cut plan with
the editor's estimate, checks the length to the frame, compares sampled frames
with the planned crop of the source, checks manual framing and per-camera
zoom, and checks audio sync.

## Credits

Models and texts this app downloads and uses. Keep this table in step with the
code: `python tests/test_credits.py` fails when a model or dataset referenced in
`shorts/` is missing here.

| Used for | Model / data | Licence |
|---|---|---|
| Speech recognition, word timings | [Whisper large-v3](https://huggingface.co/openai/whisper-large-v3) (OpenAI) via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`large-v3`) | MIT |
| Accurate Arabic words | [CohereLabs/cohere-transcribe-arabic-07-2026](https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026) (gated: accept its terms on Hugging Face once; without it the Tashkeel model is used alone) | Apache-2.0 |
| Harakat (tashkeel) | [NAMAA-Space/Cohere-Speech-Tashkeel-2B](https://huggingface.co/NAMAA-Space/Cohere-Speech-Tashkeel-2B), fine-tuned from [Cohere Transcribe Arabic](https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026) | Apache-2.0 |
| Second opinion on every word (doubtful-word marks) | [NVIDIA FastConformer Arabic (pcd)](https://huggingface.co/nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0), ONNX export [OpenVoiceOS/stt_ar_fastconformer_hybrid_large_pcd_v1.0_onnx](https://huggingface.co/OpenVoiceOS/stt_ar_fastconformer_hybrid_large_pcd_v1.0_onnx), run with [onnx-asr](https://github.com/istupakov/onnx-asr) | CC-BY-4.0 |
| Pause detection | [Silero VAD](https://github.com/snakers4/silero-vad) (bundled with faster-whisper) | MIT |
| Proofreading doubtful words (optional, online) | Google [Gemini](https://ai.google.dev) API, newest Flash model your key can use (or `GEMINI_MODEL`) | Google's API terms |
| Translation | [Qwen/Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) | Apache-2.0 |
| Face detection | [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (`face_detection_yunet_2023mar.onnx`, OpenCV Zoo) | MIT |
| Recognising the lecturer | [SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) (`face_recognition_sface_2021dec.onnx`, OpenCV Zoo) | Apache-2.0 |
| Quran text (Uthmani) | [arbml/quran_uthmani](https://huggingface.co/datasets/arbml/quran_uthmani), which appears to be the [Tanzil](https://tanzil.net) Uthmani text: used verbatim, as Tanzil's terms require | Tanzil terms |
| Quran in English | Saheeh International, from [nassimjp/quran](https://huggingface.co/datasets/nassimjp/quran) (`en-saheeh`) | © Saheeh International; downloaded at runtime, not redistributed |
| Hadith (six books, grading, English) | [meeAtif/hadith_datasets](https://huggingface.co/datasets/meeAtif/hadith_datasets), from [sunnah.com](https://sunnah.com) | MIT |
