#!/usr/bin/env bash
# Manage the Even Hub simulator on a private X display.
# Usage: tools/sim.sh start|stop|restart [url]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SIM_PORT:-9898}"
URL="${2:-http://127.0.0.1:5199/}"
DISPLAY_NUM="${SIM_DISPLAY:-:98}"
PIDFILE="/tmp/relay-sim.pid"
LOGFILE="/tmp/relay-sim.log"

ensure_display() {
  if ! DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
    nohup Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -ac > /tmp/relay-xvfb.log 2>&1 &
    sleep 1
  fi
  if ! pgrep -x openbox >/dev/null 2>&1; then
    DISPLAY="$DISPLAY_NUM" nohup openbox > /tmp/relay-openbox.log 2>&1 &
    sleep 1
  fi
}

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill -- "-$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  for p in $(pgrep -x evenhub-simulator 2>/dev/null || true); do kill "$p" 2>/dev/null || true; done
  for p in $(pgrep -f '^node .*evenhub-simulator' 2>/dev/null || true); do kill "$p" 2>/dev/null || true; done
  sleep 1
}

start() {
  ensure_display
  if curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
    echo "simulator already running on :$PORT"
    return 0
  fi
  cd "$ROOT" || exit 1
  DISPLAY="$DISPLAY_NUM" WEBKIT_DISABLE_COMPOSITING_MODE=1 RUST_LOG=warn \
    setsid dbus-run-session -- evenhub-simulator "$URL" --automation-port "$PORT" --no-glow \
    > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 40); do
    if curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
      echo "simulator ready on :$PORT -> $URL"
      return 0
    fi
    sleep 1
  done
  echo "simulator failed to start; see $LOGFILE" >&2
  tail -20 "$LOGFILE" >&2
  return 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop; echo "simulator stopped" ;;
  restart) stop; start ;;
  *) echo "usage: $0 start|stop|restart [url]" >&2; exit 2 ;;
esac
