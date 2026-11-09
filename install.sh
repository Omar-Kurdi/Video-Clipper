#!/usr/bin/env bash
# One-time setup: Python environment, Python packages, web app build.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null || { echo "Missing: $1 — $2" >&2; exit 1; }; }
PY="${PYTHON:-python3}"   # e.g. PYTHON=python3.14 ./install.sh
need "$PY"   "install Python 3.10+"
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
echo "Installed. Start with ./start.sh, stop with ./stop.sh"
