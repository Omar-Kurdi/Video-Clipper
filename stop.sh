#!/usr/bin/env bash
# Stop the web app, including one started by hand with `python -m server`.
set -uo pipefail
cd "$(dirname "$0")"
HERE=$(pwd -P)
PID_FILE=.run/server.pid

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
