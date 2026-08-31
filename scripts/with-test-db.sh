#!/usr/bin/env sh
#
# Run the backend suite against a real, disposable PostgreSQL 18 database.
#
# The `tests/setup/db.js` harness is opt-in: without TEST_DATABASE_URL every
# DB-backed case self-skips, so a default `bun run test` never exercises them.
# This script creates an isolated native cluster when PostgreSQL 18 tools are
# installed. Docker remains an optional fallback and matches CI's database.
#
#   bun run test:db                                  # whole backend suite
#   bun run test:db tests/services/transferReconciliation.db.test.js
#   VISION_TEST_DB_PROVIDER=docker bun run test:db   # force Docker
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

PROVIDER=${VISION_TEST_DB_PROVIDER:-auto}
CONTAINER=${VISION_TEST_DB_CONTAINER:-vision-test-db}
PORT=${VISION_TEST_DB_PORT:-55432}
KEEP=${VISION_TEST_DB_KEEP:-0}
CHECK_ONLY=${VISION_TEST_DB_CHECK_ONLY:-0}
TASK=${VISION_TEST_DB_TASK:-tests}
ACTIVE_PROVIDER=
NATIVE_ROOT=
NATIVE_DATA=
NATIVE_LOG=
POSTGRES_BIN=

case "$PROVIDER" in
  auto|native|docker) ;;
  *)
    echo "[test-db] VISION_TEST_DB_PROVIDER must be auto, native, or docker." >&2
    exit 1
    ;;
esac

case "$TASK" in
  tests|migration-fidelity) ;;
  *)
    echo "[test-db] VISION_TEST_DB_TASK must be tests or migration-fidelity." >&2
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
  if [ "$TASK" = migration-fidelity ]; then
    echo "[test-db] Migration fidelity refuses a caller-managed TEST_DATABASE_URL." >&2
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

  for tool in initdb postgres pg_ctl pg_isready createdb; do
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

docker_is_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

if [ "$CHECK_ONLY" = 1 ]; then
  case "$PROVIDER" in
    native)
      find_native_postgres || exit 1
      echo "[test-db] Native PostgreSQL 18 tools are available."
      ;;
    docker)
      docker_is_ready || exit 1
      echo "[test-db] Docker is available."
      ;;
    auto)
      if find_native_postgres; then
        echo "[test-db] Native PostgreSQL 18 tools are available."
      elif docker_is_ready; then
        echo "[test-db] Docker is available."
      else
        exit 1
      fi
      ;;
  esac
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
  elif [ "$ACTIVE_PROVIDER" = docker ]; then
    if [ "$KEEP" = 1 ]; then
      echo "[test-db] VISION_TEST_DB_KEEP=1; leaving container '$CONTAINER' on port $PORT."
    else
      echo "[test-db] Removing container '$CONTAINER'."
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
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
}

start_docker_postgres() {
  ACTIVE_PROVIDER=docker

  # A leftover from an interrupted run would hold the port and carry stale rows
  # into a suite that assumes a clean corpus. This removes only the named test
  # container; it never removes a volume.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

  echo "[test-db] Starting disposable postgres:18-alpine as '$CONTAINER' on port $PORT."
  docker run -d --rm \
    --name "$CONTAINER" \
    -e POSTGRES_USER=vision_test \
    -e POSTGRES_PASSWORD=vision_test \
    -e POSTGRES_DB=vision_test \
    -p "$PORT":5432 \
    --tmpfs /var/lib/postgresql/data \
    postgres:18-alpine >/dev/null

  printf '[test-db] Waiting for PostgreSQL'
  i=0
  # Probe over TCP. The image's temporary initialization server accepts only
  # Unix-socket connections and must not be mistaken for final readiness.
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
}

case "$PROVIDER" in
  native)
    if ! find_native_postgres; then
      echo "[test-db] PostgreSQL 18 tools were not found." >&2
      echo "[test-db] Set VISION_TEST_POSTGRES_BIN to the PostgreSQL 18 bin directory." >&2
      exit 1
    fi
    start_native_postgres
    ;;
  docker)
    if ! docker_is_ready; then
      echo "[test-db] Docker was requested, but its daemon is unavailable." >&2
      exit 1
    fi
    start_docker_postgres
    ;;
  auto)
    if find_native_postgres; then
      start_native_postgres
    elif docker_is_ready; then
      start_docker_postgres
    else
      echo "[test-db] Neither PostgreSQL 18 tools nor a running Docker daemon were found." >&2
      echo "[test-db] Install PostgreSQL 18 tools, start Docker, or export TEST_DATABASE_URL." >&2
      exit 1
    fi
    ;;
esac

if [ "$ACTIVE_PROVIDER" = docker ]; then
  URL="postgresql://vision_test:vision_test@127.0.0.1:$PORT/vision_test"
else
  URL="postgresql://vision_test@127.0.0.1:$PORT/vision_test"
fi

# Both names point to the same disposable database. DB-backed suites seed
# through TEST_DATABASE_URL while the service under test uses DATABASE_URL.
export DATABASE_URL="$URL"
export TEST_DATABASE_URL="$URL"
# Keep boot-time migration state outside the repository. A disposable database
# must never consult or overwrite the normal development cache.
if [ "$ACTIVE_PROVIDER" = native ]; then
  export VISION_CACHE_DIR="$NATIVE_ROOT/vision-cache"
else
  export VISION_CACHE_DIR="${TMPDIR:-/tmp}/vision-test-db-cache"
fi

echo "[test-db] Migrating the disposable database to head."
bun run apps/node-backend/scripts/db-migrate.js

if [ "$TASK" = migration-fidelity ]; then
  echo "[test-db] Verifying latest-revision downgrade and upgrade fidelity."
  bun run apps/node-backend/scripts/db-migrate.js downgrade -1
  bun run apps/node-backend/scripts/db-migrate.js upgrade head
  echo "[test-db] Migration fidelity check passed."
  exit 0
fi

echo "[test-db] Running backend suite with the $ACTIVE_PROVIDER provider."
cd apps/node-backend && bun vitest run "$@"
