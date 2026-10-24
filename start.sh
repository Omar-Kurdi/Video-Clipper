#!/usr/bin/env bash
# Start the web app in the background. Logs: .run/server.log
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .run
PID_FILE=.run/server.pid
LOG=.run/server.log

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PID_FILE")): $(grep -ao 'http://[^ ]*' "$LOG" | head -1)"
  exit 0
fi

PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python

if [ ! -f web/dist/index.html ]; then
  echo "==> Web app not built yet, building"
  (cd web && npm install --no-audit --no-fund --silent && npm run build --silent)
fi

nohup "$PY" -u -m server >"$LOG" 2>&1 &
echo $! >"$PID_FILE"

# wait for the server to report its address
for _ in $(seq 1 40); do
  url=$(grep -ao 'http://[^ ]*' "$LOG" | head -1 || true)
  if [ -n "$url" ] && grep -aq "Application startup complete" "$LOG"; then
    echo "Lecture Shorts is running: $url"
    echo "Stop it with ./stop.sh   (logs: $LOG)"
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "The server failed to start. Last lines of $LOG:" >&2
    tail -20 "$LOG" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.5
done
echo "Started (pid $(cat "$PID_FILE")) but it hasn't reported ready yet; see $LOG"
