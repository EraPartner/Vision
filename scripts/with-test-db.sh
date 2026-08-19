#!/usr/bin/env sh
#
# Run the backend suite against a real, disposable Postgres.
#
# The `tests/setup/db.js` harness is opt-in: without TEST_DATABASE_URL every
# DB-backed case self-skips, so a default `bun run test` never exercises them.
# This script provides that database locally with the same shape CI uses
# (.github/workflows/ci.yml → "Test (Backend)"), so a suite that passes here
# passes there.
#
#   bun run test:db                                  # whole backend suite
#   bun run test:db tests/services/transferReconciliation.db.test.js
#
# Any arguments are forwarded to vitest, so a single file or -t filter works.
#
# Requires Docker (for the throwaway container) and the Python Alembic toolchain
# on PATH (pip install -r config/requirements.txt) to build the schema.
#
# The container is named, published on a NON-default port, and removed on exit —
# it can neither collide with nor outlive a real local Postgres. Set
# VISION_TEST_DB_KEEP=1 to leave it running for inspection after a failure.
#
# If TEST_DATABASE_URL is already exported, the script normally uses that
# database as-is. The one exception is the fixed disposable native database
# managed by Codex cloud: it is reset and migrated before every run so cached
# tasks and interrupted suites cannot leak rows into the next test process.

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

CONTAINER=${VISION_TEST_DB_CONTAINER:-vision-test-db}
PORT=${VISION_TEST_DB_PORT:-55432}

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  if [ "${CODEX_SESSION_ENV:-}" = cloud ] && \
    [ "$TEST_DATABASE_URL" = 'postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test' ]; then
    echo "[test-db] Resetting the managed Codex cloud database."
    bash "$REPO_ROOT/.codex/cloud/reset-test-db.sh"
  else
    echo "[test-db] Using caller-managed TEST_DATABASE_URL — not starting a container."
  fi
  DATABASE_URL=${DATABASE_URL:-$TEST_DATABASE_URL}
  export DATABASE_URL TEST_DATABASE_URL
  cd apps/node-backend && exec bun vitest run "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[test-db] docker not found. Install it, or export TEST_DATABASE_URL yourself" >&2
  echo "[test-db] to point at an already-migrated Postgres." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[test-db] Docker CLI found, but the daemon is unavailable." >&2
  echo "[test-db] Export TEST_DATABASE_URL for an already-migrated Postgres." >&2
  echo "[test-db] In Codex cloud, configure and run .codex/cloud/setup.sh." >&2
  exit 1
fi

cleanup() {
  status=$?
  if [ "${VISION_TEST_DB_KEEP:-0}" = "1" ]; then
    echo "[test-db] VISION_TEST_DB_KEEP=1 — leaving container '$CONTAINER' on port $PORT."
  else
    echo "[test-db] Removing container '$CONTAINER'."
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit $status
}
trap cleanup EXIT INT TERM

# A leftover from an interrupted run would hold the port and, worse, carry stale
# rows into a suite that assumes a clean corpus. Always start from nothing.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "[test-db] Starting disposable postgres:18-alpine as '$CONTAINER' on port $PORT..."
# --tmpfs: the data directory never touches disk. Nothing here is worth
# persisting, and it makes the throwaway cluster measurably faster.
docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_USER=vision_test \
  -e POSTGRES_PASSWORD=vision_test \
  -e POSTGRES_DB=vision_test \
  -p "$PORT":5432 \
  --tmpfs /var/lib/postgresql/data \
  postgres:18-alpine >/dev/null

printf '[test-db] Waiting for postgres'
i=0
# Probe over TCP (-h 127.0.0.1): during initdb the entrypoint runs a TEMPORARY
# server that answers on the unix socket only — a socket probe reports ready,
# then the temp server shuts down and the migration's first TCP connect dies
# with "Connection terminated unexpectedly". TCP only answers once the final
# server is up.
until docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U vision_test -d vision_test >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo ' timed out.' >&2
    docker logs "$CONTAINER" >&2 || true
    exit 1
  fi
  printf '.'
  sleep 1
done
echo ' ready.'

URL="postgresql://vision_test:vision_test@127.0.0.1:$PORT/vision_test"
# Both names, same database: DB-backed suites seed through TEST_DATABASE_URL
# while the service under test queries through the app pool (DATABASE_URL).
export DATABASE_URL="$URL"
export TEST_DATABASE_URL="$URL"
# Keep the boot-time "already at head" cache out of the repo's .vision-cache —
# it is keyed on revision + versions/ fingerprint, so a dev-database entry must
# never be consulted for (or overwritten by) this throwaway one.
export VISION_CACHE_DIR="${TMPDIR:-/tmp}/vision-test-db-cache"

echo "[test-db] Migrating to head..."
bun run apps/node-backend/scripts/db-migrate.js

echo "[test-db] Running backend suite against $URL"
cd apps/node-backend && bun vitest run "$@"
