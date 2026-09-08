#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
postgres_bin=${VISION_CI_POSTGRES_BIN:-/usr/lib/postgresql/18/bin}
port=${VISION_CI_PORT:-3002}
database_port=${VISION_CI_DATABASE_PORT:-55432}
command_dir=${VISION_NATIVE_COMMAND_DIR:-.}

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 command [arguments ...]" >&2
  exit 2
fi
case "$command_dir" in
  /*|*'..'*)
    echo "VISION_NATIVE_COMMAND_DIR must be a repository-relative path without '..'." >&2
    exit 2
    ;;
esac
for tool in initdb pg_ctl pg_isready createdb psql postgres; do
  if [[ ! -x "$postgres_bin/$tool" ]]; then
    echo "PostgreSQL 18 tool is missing: $postgres_bin/$tool" >&2
    exit 1
  fi
done
if [[ $("$postgres_bin/postgres" --version) != *" 18."* ]]; then
  echo "The native stack requires PostgreSQL 18." >&2
  exit 1
fi

work_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vision-native-ci.XXXXXX")
data_dir=$work_root/postgres
postgres_log=$work_root/postgres.log
backend_log=$work_root/backend.log
backend_pid=

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill -TERM "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  if [[ -f "$data_dir/postmaster.pid" ]]; then
    "$postgres_bin/pg_ctl" -D "$data_dir" -m fast -w -t 30 stop >/dev/null 2>&1 || true
  fi
  if [[ $status -ne 0 ]]; then
    echo "Native stack failed. Backend log:" >&2
    tail -200 "$backend_log" >&2 2>/dev/null || true
    echo "PostgreSQL log:" >&2
    tail -200 "$postgres_log" >&2 2>/dev/null || true
  fi
  rm -rf -- "$work_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$postgres_bin/initdb" -D "$data_dir" --encoding=UTF8 --locale=C \
  --auth-local=trust --auth-host=trust --username=vision_ci --no-instructions >/dev/null
{
  echo "listen_addresses = '127.0.0.1'"
  echo "port = $database_port"
  echo "unix_socket_directories = ''"
  echo "shared_preload_libraries = 'pg_stat_statements'"
  echo "logging_collector = off"
} >> "$data_dir/postgresql.conf"
"$postgres_bin/pg_ctl" -D "$data_dir" -l "$postgres_log" -w -t 60 start >/dev/null
"$postgres_bin/createdb" -h 127.0.0.1 -p "$database_port" -U vision_ci \
  -O vision_ci -E UTF8 --locale=C --template=template0 vision_ci
"$postgres_bin/psql" -h 127.0.0.1 -p "$database_port" -U vision_ci -d vision_ci \
  -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' >/dev/null

export DATABASE_URL="postgresql://vision_ci@127.0.0.1:${database_port}/vision_ci"
export TEST_DATABASE_URL=$DATABASE_URL
export DATABASE_URL_MIGRATIONS=$DATABASE_URL
export ENVIRONMENT=production
export SERVER_HOST=127.0.0.1
export PORT=$port
export VISION_DIST_DIR="$repo_root/dist"

cd "$repo_root"
bun run apps/node-backend/scripts/db-migrate.js
if [[ ${VISION_NATIVE_VERIFY_MIGRATIONS:-0} == 1 ]]; then
  node apps/node-backend/scripts/alembic-command.js current
  bun run apps/node-backend/scripts/db-migrate.js downgrade -1
  bun run apps/node-backend/scripts/db-migrate.js upgrade head
fi

bun run backend >"$backend_log" 2>&1 &
backend_pid=$!
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ $ready != 1 ]]; then
  echo "Backend did not become healthy on port $port." >&2
  exit 1
fi

cd "$repo_root/$command_dir"
"$@"
