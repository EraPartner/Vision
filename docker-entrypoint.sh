#!/bin/sh
# Docker entrypoint for Vision app container
# Boots the backend; DB wait + Alembic are handled in apps/node-backend/src/main.js.

set -e

# Boot trace: emit total entrypoint duration so the Electron orchestrator and
# CI can chart container init. Disable with VISION_BOOT_TRACE=0.
BOOT_T0=$(date +%s.%N)

echo "[entrypoint] Starting Vision app container..."

# DB readiness is now polled exclusively by the backend in
# apps/node-backend/src/main.js (checkConnection loop, 40 attempts with
# exponential backoff). The entrypoint pg_isready loop ran serially before
# bun started, blocking node spinup behind postgres init on cold boots.
# Letting bun start immediately overlaps its ~1s init with the tail end of
# postgres data dir creation (~1s warm-boot win, larger on first-ever start).

cd /app

# Alembic migrations are run by the JS backend on boot
# (apps/node-backend/src/database/migrate.js).

if [ "$VISION_BOOT_TRACE" != "0" ]; then
  TOTAL_MS=$(awk -v a="$(date +%s.%N)" -v b="$BOOT_T0" 'BEGIN{ printf("%d", (a-b)*1000) }')
  echo "[startup] {\"phase\":\"entrypoint_total\",\"ms\":$TOTAL_MS}" >&2
fi

echo "[entrypoint] Starting backend application..."
exec bun run apps/node-backend/src/main.js
