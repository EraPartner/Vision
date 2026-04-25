#!/bin/sh
# Docker entrypoint for Vision app container
# Runs Alembic migrations before starting the backend

set -e

# Boot trace: emit `[startup] {"phase":"...","ms":N}` between key stages so the
# Electron orchestrator and CI can chart container init. Disable with
# VISION_BOOT_TRACE=0.
BOOT_T0=$(date +%s.%N)
_phase_t0=$BOOT_T0
boot_mark() {
  if [ "$VISION_BOOT_TRACE" = "0" ]; then
    _phase_t0=$(date +%s.%N)
    return
  fi
  local now ms
  now=$(date +%s.%N)
  ms=$(awk -v a="$now" -v b="$_phase_t0" 'BEGIN{ printf("%d", (a-b)*1000) }')
  echo "[startup] {\"phase\":\"$1\",\"ms\":$ms}" >&2
  _phase_t0=$now
}

echo "[entrypoint] Starting Vision app container..."

# Wait for DB readiness via pg_isready (Alpine postgresql-client). Much
# cheaper than spinning up Python+psycopg2 on every boot.
DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-ftm_user}"
DB_NAME="${DB_NAME:-financial_transactions}"
MAX_ATTEMPTS=60
attempt=0
echo "[entrypoint] Waiting for database (pg_isready)..."
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t 2 >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "[entrypoint] ERROR: Database did not become ready after $MAX_ATTEMPTS attempts" >&2
    exit 1
  fi
  sleep 0.2
done
echo "[entrypoint] Database is ready!"
boot_mark "entrypoint_db_wait"

cd /app

# Alembic migrations are now run by the JS backend on boot
# (apps/node-backend/src/database/migrate.js). The legacy-rev rewrite + column
# resize one-shots have been ported to stampBaselineIfLegacy() in that module.
# Removing the duplicate alembic invocation here saves ~2-4s on warm boots.

if [ "$VISION_BOOT_TRACE" != "0" ]; then
  TOTAL_MS=$(awk -v a="$(date +%s.%N)" -v b="$BOOT_T0" 'BEGIN{ printf("%d", (a-b)*1000) }')
  echo "[startup] {\"phase\":\"entrypoint_total\",\"ms\":$TOTAL_MS}" >&2
fi

echo "[entrypoint] Starting backend application..."
exec bun run apps/node-backend/src/main.js
