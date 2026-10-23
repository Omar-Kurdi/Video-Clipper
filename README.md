# Video Clipper — lecture → vertical shorts

Turns selected moments of a long, single-speaker lecture into 9:16 shorts:
pauses removed with optical-flow "morph" cuts, a crop that follows the speaker,
clean hard cuts on camera changes, styled word captions (right-to-left for
Arabic) and an optional name plate.

Needs `ffmpeg` (with NVENC), an NVIDIA GPU, Pillow built with raqm, Node 18+
for the web app, and `pip install -r requirements.txt`.

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

- **Landing / library** – import a lecture from a YouTube link, an upload, or a
  file already on this computer (linked, not copied). Each lecture is analysed
  once: waveform, pauses, thumbnail.
- **Editor** – one screen: the transcript on the left (search; click a
  sentence to select it, shift+click to extend, double-click to correct the
  text, and corrections are used in the captions), the video and waveform
  timeline in the middle (`I` / `O` to mark, `Enter` to add, drag to select,
  scroll to move, `Ctrl`+scroll to zoom), and the preview and settings on the
  right. Selecting in either place selects in both.
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
  cuts, caption style, name plate, zoom in or out, grade) update a live 9:16 preview;
  **Render** runs in the background and the result plays and downloads in place.

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
`--style box|pill|outline|minimal`, or a JSON file that starts from a preset
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
(tighter crop), `--grade`, `--keep-temp`.

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

## Checking a render

`python tests/verify_render.py <video> --range 322-445` renders a short and
checks it is exactly what the editor planned. It compares the cut plan with
the editor's estimate, checks the length to the frame, compares sampled frames
with the planned crop of the source, checks manual framing and per-camera
zoom, and checks audio sync.
