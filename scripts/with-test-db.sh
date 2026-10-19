#!/usr/bin/env sh
#
# Run the backend suite against a real, disposable PostgreSQL 18 database.
#
# The `tests/setup/db.js` harness is opt-in: without TEST_DATABASE_URL every
# DB-backed case self-skips, so a default `bun run test` never exercises them.
# This script creates an isolated native cluster when PostgreSQL 18 tools are
# installed. No container daemon is used.
#
#   bun run test:db                                  # whole backend suite
#   bun run test:db tests/services/transferReconciliation.db.test.ts
#   VISION_TEST_DB_VERIFY_CODEGEN=1 bun run test:db  # also verify schema.generated.ts
#
# Any arguments are forwarded to Vitest, so a single file or -t filter works.
# The schema is built with the Kysely migrator (db-migrate.ts up).
#
# An exported TEST_DATABASE_URL is ignored by default: this suite deletes test
# tables and must not accidentally target a development or production database.
# VISION_TEST_DB_USE_CALLER=1 explicitly opts into an already-disposable test
# database.

set -eu
umask 077
unset VISION_TEST_DB_ISOLATED

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

PORT=${VISION_TEST_DB_PORT:-55432}
KEEP=${VISION_TEST_DB_KEEP:-0}
CHECK_ONLY=${VISION_TEST_DB_CHECK_ONLY:-0}
WATCH=${VISION_TEST_DB_WATCH:-0}
ACTIVE_PROVIDER=
NATIVE_ROOT=
NATIVE_DATA=
NATIVE_LOG=
POSTGRES_BIN=

case "$WATCH" in
  0|1) ;;
  *)
    echo "[test-db] VISION_TEST_DB_WATCH must be 0 or 1." >&2
    exit 1
    ;;
esac

case "$PORT" in
  ''|*[!0-9]*)
    echo "[test-db] VISION_TEST_DB_PORT must be a number from 1024 through 65535." >&2
    exit 1
    ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "[test-db] VISION_TEST_DB_PORT must be a number from 1024 through 65535." >&2
  exit 1
fi

if [ -n "${TEST_DATABASE_URL:-}" ] && [ "${VISION_TEST_DB_USE_CALLER:-0}" = 1 ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    echo "[test-db] Caller-managed TEST_DATABASE_URL is available."
    exit 0
  fi
  echo "[test-db] Using caller-managed TEST_DATABASE_URL; no database provider was started."
  DATABASE_URL=$TEST_DATABASE_URL
  unset DATABASE_URL_MIGRATIONS DATABASE_URL_ANALYSIS
  export DATABASE_URL TEST_DATABASE_URL
  cd apps/node-backend
  if [ "$WATCH" = 1 ]; then
    exec bun vitest watch "$@"
  fi
  exec bun vitest run "$@"
fi

if [ -n "${TEST_DATABASE_URL:-}" ] || [ -n "${DATABASE_URL:-}" ] || \
  [ -n "${DATABASE_URL_MIGRATIONS:-}" ] || [ -n "${DATABASE_URL_ANALYSIS:-}" ]; then
  echo "[test-db] Ignoring inherited database URLs; starting a disposable native database."
fi
unset DATABASE_URL TEST_DATABASE_URL DATABASE_URL_MIGRATIONS DATABASE_URL_ANALYSIS

postgres_bin_is_18() {
  candidate=$1
  [ -x "$candidate/postgres" ] || return 1
  version=$("$candidate/postgres" --version 2>/dev/null || true)
  case "$version" in
    *' 18.'*) ;;
    *) return 1 ;;
  esac

  for tool in initdb postgres pg_ctl pg_isready createdb psql; do
    [ -x "$candidate/$tool" ] || return 1
  done
  return 0
}

find_native_postgres() {
  command_postgres=$(command -v postgres 2>/dev/null || true)
  command_bin=
  if [ -n "$command_postgres" ]; then
    command_bin=$(CDPATH='' cd -- "$(dirname -- "$command_postgres")" && pwd)
  fi

  for candidate in \
    "${VISION_TEST_POSTGRES_BIN:-}" \
    "${VISION_POSTGRES_BIN:-}" \
    "$command_bin" \
    /opt/homebrew/opt/postgresql@18/bin \
    /usr/local/opt/postgresql@18/bin \
    /usr/lib/postgresql/18/bin \
    /Applications/Postgres.app/Contents/Versions/18/bin
  do
    [ -n "$candidate" ] || continue
    if postgres_bin_is_18 "$candidate"; then
      POSTGRES_BIN=$candidate
      return 0
    fi
  done
  return 1
}

if [ "$CHECK_ONLY" = 1 ]; then
  find_native_postgres || exit 1
  echo "[test-db] Native PostgreSQL 18 tools are available."
  exit 0
fi

cleanup() {
  status=$?
  trap - EXIT INT TERM

  if [ "$ACTIVE_PROVIDER" = native ] && [ -n "$NATIVE_ROOT" ]; then
    if [ "$KEEP" = 1 ]; then
      echo "[test-db] VISION_TEST_DB_KEEP=1; native diagnostics remain at $NATIVE_ROOT."
    else
      if [ -n "$NATIVE_DATA" ] && [ -f "$NATIVE_DATA/postmaster.pid" ]; then
        "$POSTGRES_BIN/pg_ctl" -D "$NATIVE_DATA" -m fast -w -t 30 stop >/dev/null 2>&1 || true
      fi
      native_tmp_base=${TMPDIR:-/tmp}
      native_tmp_base=${native_tmp_base%/}
      case "$NATIVE_ROOT" in
        "$native_tmp_base"/vision-test-pg.*) rm -rf -- "$NATIVE_ROOT" ;;
        *) echo "[test-db] Refusing to remove unexpected native path: $NATIVE_ROOT" >&2 ;;
      esac
    fi
  fi

  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_native_postgres() {
  ACTIVE_PROVIDER=native
  native_tmp_base=${TMPDIR:-/tmp}
  native_tmp_base=${native_tmp_base%/}
  NATIVE_ROOT=$(mktemp -d "$native_tmp_base/vision-test-pg.XXXXXX")
  NATIVE_DATA=$NATIVE_ROOT/data
  NATIVE_LOG=$NATIVE_ROOT/postgres.log
  chmod 700 "$NATIVE_ROOT"
  VISION_TEST_DB_PASSWORD=$(node -e "process.stdout.write(require('node:crypto').randomUUID())")
  printf '%s\n' "$VISION_TEST_DB_PASSWORD" > "$NATIVE_ROOT/superuser-password"

  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    echo "[test-db] Port $PORT is already occupied; choose another VISION_TEST_DB_PORT." >&2
    exit 1
  fi

  echo "[test-db] Initializing disposable native PostgreSQL 18 on 127.0.0.1:$PORT."
  "$POSTGRES_BIN/initdb" \
    -D "$NATIVE_DATA" \
    --encoding=UTF8 \
    --locale=C \
    --auth-local=trust \
    --auth-host=scram-sha-256 \
    --username=vision_test \
    --pwfile="$NATIVE_ROOT/superuser-password" \
    --no-instructions >/dev/null

  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = $PORT"
    echo "unix_socket_directories = ''"
    echo "shared_preload_libraries = 'pg_stat_statements'"
    echo "logging_collector = off"
  } >> "$NATIVE_DATA/postgresql.conf"

  if ! "$POSTGRES_BIN/pg_ctl" -D "$NATIVE_DATA" -l "$NATIVE_LOG" -w -t 60 start >/dev/null; then
    echo "[test-db] Native PostgreSQL 18 did not start. Diagnostics: $NATIVE_LOG" >&2
    exit 1
  fi
  if ! "$POSTGRES_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -U vision_test -d postgres -t 10 >/dev/null; then
    echo "[test-db] Native PostgreSQL 18 did not become ready. Diagnostics: $NATIVE_LOG" >&2
    exit 1
  fi

  PGPASSWORD=$VISION_TEST_DB_PASSWORD "$POSTGRES_BIN/createdb" \
    -h 127.0.0.1 \
    -p "$PORT" \
    -U vision_test \
    -O vision_test \
    -E UTF8 \
    --locale=C \
    --template=template0 \
    vision_test
  PGPASSWORD=$VISION_TEST_DB_PASSWORD "$POSTGRES_BIN/psql" \
    -h 127.0.0.1 \
    -p "$PORT" \
    -U vision_test \
    -d vision_test \
    -v ON_ERROR_STOP=1 \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' >/dev/null
}

if ! find_native_postgres; then
  echo "[test-db] PostgreSQL 18 tools were not found." >&2
  echo "[test-db] Set VISION_TEST_POSTGRES_BIN to the PostgreSQL 18 bin directory." >&2
  exit 1
fi
start_native_postgres

URL="postgresql://vision_test:$VISION_TEST_DB_PASSWORD@127.0.0.1:$PORT/vision_test"

# Both names point to the same disposable database. DB-backed suites seed
# through TEST_DATABASE_URL while the service under test uses DATABASE_URL.
export DATABASE_URL="$URL"
export TEST_DATABASE_URL="$URL"
VISION_TEST_ANALYSIS_PASSWORD=$(node -e "process.stdout.write(require('node:crypto').randomUUID())")
export DATABASE_URL_ANALYSIS="postgresql://vision_analysis_executor:$VISION_TEST_ANALYSIS_PASSWORD@127.0.0.1:$PORT/vision_test"
export VISION_TEST_DB_ISOLATED=1
echo "[test-db] Migrating the disposable database to the latest migration."
bun run apps/node-backend/scripts/db-migrate.ts up
# CI sets this so the committed Kysely types cannot drift from the migrated schema.
if [ "${VISION_TEST_DB_VERIFY_CODEGEN:-0}" = 1 ]; then
  echo "[test-db] Verifying generated database types against the migrated schema."
  bun run db:codegen --verify
fi

cd apps/node-backend
if [ "$WATCH" = 1 ]; then
  echo "[test-db] Watching backend suite with native PostgreSQL."
  bun vitest watch "$@"
else
  echo "[test-db] Running backend suite with native PostgreSQL."
  bun vitest run "$@"
fi
