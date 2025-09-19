#!/usr/bin/env bash
set -euo pipefail

npm --prefix prompt-transform-worker run dev &
WORKER_PID=$!

echo "Started worker dev server (pid $WORKER_PID)"

npm --prefix prompt-structurer run dev &
EXT_PID=$!

echo "Started extension dev server (pid $EXT_PID)"

dev_cleanup() {
  echo "Stopping dev servers..."
  kill $WORKER_PID $EXT_PID 2>/dev/null || true
}

trap dev_cleanup EXIT

wait
