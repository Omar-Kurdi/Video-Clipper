#!/usr/bin/env bash
# One-time setup: Python environment, Python packages, web app build.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null || { echo "Missing: $1 — $2" >&2; exit 1; }; }
PY="${PYTHON:-python3}"   # e.g. PYTHON=python3.14 ./install.sh
# an environment that already works stays on its own Python version: the
# system's python3 may have moved to one the packages don't install on yet,
# and rebuilding on it would throw a working environment away
if [ -z "${PYTHON:-}" ] && HAVE=$(.venv/bin/python -c 'import sys; print("python%d.%d" % sys.version_info[:2])' 2>/dev/null) && command -v "$HAVE" >/dev/null; then
  PY="$HAVE"
fi
# the heavy packages (numpy<2.5, torch, numba, CTranslate2) ship prebuilt wheels
# only up to MAX_PY (numpy<2.5 has none for 3.15); on a newer Python pip falls
# back to building numpy from source, which fails without the Python headers.
# So unless PYTHON= is set, use a supported version: one already installed, or
# one fetched with uv (no root)
MAX_PY=3.14
too_new() { "$1" -c "import sys; sys.exit(not sys.version_info[:2] > (${MAX_PY/./,}))" 2>/dev/null; }
if [ -z "${PYTHON:-}" ] && command -v "$PY" >/dev/null && too_new "$PY"; then
  echo "==> $("$PY" -V) is newer than the packages support (up to $MAX_PY), using an older Python"
  PY=""
  for v in 3.14 3.13 3.12 3.11 3.10; do
    command -v "python$v" >/dev/null && ! too_new "python$v" && { PY="python$v"; break; }
  done
  if [ -z "$PY" ] && command -v uv >/dev/null; then
    echo "    installing Python $MAX_PY with uv"
    uv python install "$MAX_PY"
    PY=$(uv python find "$MAX_PY")
  fi
  [ -n "$PY" ] || { echo "Missing: Python 3.10-$MAX_PY. Install uv (https://docs.astral.sh/uv/) and rerun, or set PYTHON=" >&2; exit 1; }
fi
need "$PY"   "install Python 3.10-$MAX_PY"
need ffmpeg  "install ffmpeg (with NVENC support for GPU encoding)"
need node    "install Node.js 18+"
need npm     "install npm"

# the versioned interpreter (python3.14, not python3), so a system Python
# upgrade doesn't silently move the environment to a version without its packages
PYV=$("$PY" -c 'import sys; print("python%d.%d" % sys.version_info[:2])')
PY=$(command -v "$PYV" || command -v "$PY")
if [ ! -x .venv/bin/python ] || [ "$(.venv/bin/python -c 'import sys; print("python%d.%d" % sys.version_info[:2])' 2>/dev/null)" != "$PYV" ]; then
  echo "==> Creating Python environment (.venv) with $PYV"
  # reuse packages already installed on the system (e.g. CUDA libraries)
  "$PY" -m venv --clear --system-site-packages .venv
fi

echo "==> Installing Python packages"
.venv/bin/python -m pip install --quiet --upgrade pip
if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then
  echo "    NVIDIA GPU found: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1), installing the GPU packages"
  # PyPI's torch is built for CUDA 13, which has no kernels for cards older than
  # Turing (compute capability < 7.5: GTX 10xx Pascal, Maxwell, Volta); torch
  # imports fine there but every GPU op fails with "no kernel image is available".
  # The CUDA 12.6 builds still include them, so install torch from that index first
  CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d ' .')
  if [ -n "$CAP" ] && [ "$CAP" -lt 75 ]; then
    echo "    compute capability ${CAP:0:1}.${CAP:1}: using the CUDA 12.6 torch build"
    .venv/bin/python -m pip install --quiet "torch==2.14.*" --index-url https://download.pytorch.org/whl/cu126
  fi
  .venv/bin/python -m pip install --quiet -r requirements.txt -r requirements-gpu.txt
else
  echo "    No NVIDIA GPU found: installing the CPU packages (transcription is slower; Arabic uses Whisper only)"
  # PyPI's torch bundles ~3 GB of CUDA libraries; the CPU build skips them
  .venv/bin/python -m pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu
  .venv/bin/python -m pip install --quiet -r requirements.txt
fi

echo "==> Building the web app"
(cd web && npm install --no-audit --no-fund --silent && npm run build --silent)

echo
echo "==> Optional local model (translation, and moments/post text when Gemini can't answer)"
.venv/bin/python -m shorts.local_llm | sed 's/^/    /' || true

echo
echo "Installed. Start with ./start.sh, stop with ./stop.sh"
