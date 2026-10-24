#!/usr/bin/env bash
# Stop the web app, including one started by hand with `python -m server`.
set -uo pipefail
cd "$(dirname "$0")"
HERE=$(pwd -P)
PID_FILE=.run/server.pid

# don't throw away work in progress (a transcription, a render...) unless asked to
if [ "${1:-}" != "-f" ]; then
  url=$(grep -ao 'http://[^ ]*' .run/server.log 2>/dev/null | head -1)
  busy=$([ -n "$url" ] && curl -s --max-time 2 "$url/api/jobs" | python3 -c \
    "import json,sys; print(', '.join(sorted({j['kind'] for j in json.load(sys.stdin) if j['status'] in ('queued','running')})))" 2>/dev/null)
  if [ -n "$busy" ]; then
    echo "Not stopping: the app is still working ($busy)."
    echo "Wait for it to finish, or run ./stop.sh -f to stop anyway (that work is lost)."
    exit 1
  fi
fi

pids=()
[ -f "$PID_FILE" ] && pids+=("$(cat "$PID_FILE")")
# any `python -m server` running from this folder
for p in $(pgrep -f -- "python[0-9.]* (-u )?-m server" || true); do
  [[ "$(cat "/proc/$p/comm" 2>/dev/null)" == python* ]] || continue
  [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$HERE" ] && pids+=("$p")
done

stopped=0
for p in $(printf '%s\n' "${pids[@]}" | sort -u); do
  if kill -0 "$p" 2>/dev/null; then
    kill "$p"
    for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p"
    echo "Stopped server (pid $p)"
    stopped=1
  fi
done
rm -f "$PID_FILE"
[ "$stopped" = 1 ] || echo "Server was not running"
