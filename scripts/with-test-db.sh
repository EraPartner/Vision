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
#   bun run test:db tests/services/transferReconciliation.db.test.js
#
# Any arguments are forwarded to Vitest, so a single file or -t filter works.
# The Python Alembic toolchain must be available on PATH
# (`pip install -r config/requirements.txt`) to build the schema.
#
# If TEST_DATABASE_URL is already exported, the script normally uses that
# database as-is. The one exception is the fixed disposable native database
# managed by Codex cloud: it is reset and migrated before every run so cached
# tasks and interrupted suites cannot leak rows into the next test process.

set -eu
umask 077

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

PORT=${VISION_TEST_DB_PORT:-55432}
KEEP=${VISION_TEST_DB_KEEP:-0}
CHECK_ONLY=${VISION_TEST_DB_CHECK_ONLY:-0}
TASK=${VISION_TEST_DB_TASK:-tests}
ACTIVE_PROVIDER=
NATIVE_ROOT=
NATIVE_DATA=
NATIVE_LOG=
POSTGRES_BIN=

case "$TASK" in
  tests|migration-fidelity|adr090-retirement|adr088-contract) ;;
  *)
    echo "[test-db] VISION_TEST_DB_TASK must be tests, migration-fidelity, adr090-retirement, or adr088-contract." >&2
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

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    echo "[test-db] Caller-managed TEST_DATABASE_URL is available."
    exit 0
  fi
  if [ "$TASK" = migration-fidelity ] || [ "$TASK" = adr090-retirement ] || [ "$TASK" = adr088-contract ]; then
    echo "[test-db] Destructive migration lifecycle tasks refuse a caller-managed TEST_DATABASE_URL." >&2
    echo "[test-db] Unset it so this script provisions a disposable database." >&2
    exit 1
  fi
  if [ "${CODEX_SESSION_ENV:-}" = cloud ] && \
    [ "$TEST_DATABASE_URL" = 'postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test' ]; then
    echo "[test-db] Resetting the managed Codex cloud database."
    bash "$REPO_ROOT/.codex/cloud/reset-test-db.sh"
  else
    echo "[test-db] Using caller-managed TEST_DATABASE_URL; no database provider was started."
  fi
  DATABASE_URL=${DATABASE_URL:-$TEST_DATABASE_URL}
  export DATABASE_URL TEST_DATABASE_URL
  cd apps/node-backend && exec bun vitest run "$@"
fi

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
    --auth-host=trust \
    --username=vision_test \
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

  "$POSTGRES_BIN/createdb" \
    -h 127.0.0.1 \
    -p "$PORT" \
    -U vision_test \
    -O vision_test \
    -E UTF8 \
    --locale=C \
    --template=template0 \
    vision_test
  "$POSTGRES_BIN/psql" \
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

URL="postgresql://vision_test@127.0.0.1:$PORT/vision_test"

# Both names point to the same disposable database. DB-backed suites seed
# through TEST_DATABASE_URL while the service under test uses DATABASE_URL.
export DATABASE_URL="$URL"
export TEST_DATABASE_URL="$URL"
# Keep boot-time migration state outside the repository. A disposable database
# must never consult or overwrite the normal development cache.
export VISION_CACHE_DIR="$NATIVE_ROOT/vision-cache"

echo "[test-db] Migrating the disposable database to head."
bun run apps/node-backend/scripts/db-migrate.js

if [ "$TASK" = migration-fidelity ]; then
  echo "[test-db] Verifying latest-revision downgrade and upgrade fidelity."
  bun run apps/node-backend/scripts/db-migrate.js downgrade -1
  bun run apps/node-backend/scripts/db-migrate.js upgrade head
  echo "[test-db] Migration fidelity check passed."
  exit 0
fi

if [ "$TASK" = adr090-retirement ]; then
  echo "[test-db] Verifying ADR-090 guarded retirement lifecycle."
  bun run scripts/test-adr090-retirement.js
  exit 0
fi

if [ "$TASK" = adr088-contract ]; then
  echo "[test-db] Applying the ADR-088 contract to the disposable database."
  "$POSTGRES_BIN/psql" "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -f alembic/manual/contract_drop_bank_account/up.sql >/dev/null
  (
    cd apps/node-backend
    bun vitest run tests/adr088Contract.db.test.js
  )
  echo "[test-db] Restoring the ADR-088 compatibility schema."
  "$POSTGRES_BIN/psql" "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -f alembic/manual/contract_drop_bank_account/down.sql >/dev/null
  restored=$(
    "$POSTGRES_BIN/psql" "$TEST_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "
      SELECT
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('transactions', 'planned_transactions')
            AND column_name = 'bank_account'),
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN ('idx_transactions_bank_account',
                              'idx_transactions_bank_date',
                              'idx_transactions_bank_date_active')),
        (SELECT count(*) FROM pg_trigger
          WHERE tgname IN ('trg_transactions_account_sync',
                           'trg_planned_transactions_account_sync')
            AND NOT tgisinternal),
        (SELECT count(*) FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE (t.bank_account IS NULL) <> (t.account_id IS NULL)
             OR (t.account_id IS NOT NULL
                 AND lower(btrim(t.bank_account)) <> lower(btrim(a.name)))),
        (SELECT count(*) FROM planned_transactions p
          LEFT JOIN accounts a ON a.id = p.account_id
          WHERE (p.bank_account IS NULL) <> (p.account_id IS NULL)
             OR (p.account_id IS NOT NULL
                 AND lower(btrim(p.bank_account)) <> lower(btrim(a.name))));
    "
  )
  if [ "$restored" != "2|3|2|0|0" ]; then
    echo "[test-db] ADR-088 rollback verification failed." >&2
    exit 1
  fi
  echo "[test-db] ADR-088 dropped-schema writes and rollback lifecycle passed."
  exit 0
fi

echo "[test-db] Running backend suite with native PostgreSQL."
cd apps/node-backend && bun vitest run "$@"
