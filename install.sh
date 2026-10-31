#!/usr/bin/env bash
# One-time setup: Python environment, Python packages, web app build.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null || { echo "Missing: $1 — $2" >&2; exit 1; }; }
need python3 "install Python 3.10+"
need ffmpeg  "install ffmpeg (with NVENC support for GPU encoding)"
need node    "install Node.js 18+"
need npm     "install npm"

if [ ! -d .venv ]; then
  echo "==> Creating Python environment (.venv)"
  # reuse packages already installed on the system (e.g. CUDA libraries)
  python3 -m venv --system-site-packages .venv
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
