#!/usr/bin/env bash
# Manage the Relay backend. Usage: tools/server.sh start|stop|restart
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
PIDFILE="/tmp/relay-server.pid"
LOGFILE="/tmp/relay-server.log"

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill -- "-$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
}

start() {
  if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "server already running on :${PORT}"
    return 0
  fi
  cd "$ROOT" || exit 1
  SESSION_KEY="${SESSION_KEY:-$(printf '00%.0s' $(seq 1 32))}" \
    setsid npx tsx server/src/index.ts > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 30); do
    if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      echo "server ready on :${PORT}"
      return 0
    fi
    sleep 1
  done
  echo "server failed to start; see $LOGFILE" >&2
  tail -20 "$LOGFILE" >&2
  return 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop; echo "server stopped" ;;
  restart) stop; start ;;
  *) echo "usage: $0 start|stop|restart" >&2; exit 2 ;;
esac
