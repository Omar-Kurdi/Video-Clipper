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
.venv/bin/python -m pip install --quiet -r requirements.txt

echo "==> Building the web app"
(cd web && npm install --no-audit --no-fund --silent && npm run build --silent)

echo
echo "Installed. Start with ./start.sh, stop with ./stop.sh"
