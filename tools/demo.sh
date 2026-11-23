#!/usr/bin/env bash
# One-command demo environment: backend + production preview + simulator.
# Linux/CI-friendly (uses the private Xvfb display managed by tools/sim.sh).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

bash tools/server.sh start || exit 1

if ! curl -sf --max-time 1 http://127.0.0.1:5200/ >/dev/null 2>&1; then
  echo "building app and starting preview on :5200"
  npm run build >/tmp/relay-build.log 2>&1 || { tail -20 /tmp/relay-build.log; exit 1; }
  setsid npx vite preview --config app/vite.config.ts --host 127.0.0.1 --port 5200 \
    > /tmp/relay-preview.log 2>&1 &
  echo $! > /tmp/relay-preview.pid
  for _ in $(seq 1 30); do
    curl -sf --max-time 1 http://127.0.0.1:5200/ >/dev/null 2>&1 && break
    sleep 1
  done
fi

bash tools/sim.sh start 'http://127.0.0.1:5200/?fresh=1' || exit 1

cat <<'EOF'

Relay demo is up.

  App (phone WebView / browser preview):  http://127.0.0.1:5200
  Backend:                                http://127.0.0.1:8787
  Pair page:                              http://127.0.0.1:8787/pair
  Simulator automation:                   http://127.0.0.1:9898

  Headless framebuffer screenshot:        python3 tools/shot.py /tmp/relay.png --scale 2
  Full asserted journey + screenshots:    npm run test:e2e
  Re-record the demo video:               python3 tools/record.py && python3 tools/video.py

The simulator runs on Xvfb :98. On a desktop, use the three-terminal flow
from README.md instead so you can see the window.
EOF
