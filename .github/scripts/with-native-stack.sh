#!/usr/bin/env bash
# Run a command against the production backend on a fresh SQLite database
# (ADR-263): migrate a temporary database file with the CLI the app shares,
# optionally round-trip the latest migration, start the backend and wait for
# /health, then run the command from VISION_NATIVE_COMMAND_DIR.
set -euo pipefail
umask 077

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
port=${VISION_CI_PORT:-3002}
command_dir=${VISION_NATIVE_COMMAND_DIR:-.}

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 command [arguments ...]" >&2
  exit 2
fi
if ( : >"/dev/tcp/127.0.0.1/$port" ) 2>/dev/null; then
  echo "Native stack cannot start: backend port $port is already in use." >&2
  exit 1
fi
case "$command_dir" in
  /*|*'..'*)
    echo "VISION_NATIVE_COMMAND_DIR must be a repository-relative path without '..'." >&2
    exit 2
    ;;
esac

work_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vision-native-ci.XXXXXX")
backend_log=$work_root/backend.log
backend_pid=

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill -TERM "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  if [[ $status -ne 0 ]]; then
    echo "Native stack failed. Backend log:" >&2
    tail -200 "$backend_log" >&2 2>/dev/null || true
  fi
  rm -rf -- "$work_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export VISION_DATABASE_PATH=$work_root/database/vision.sqlite3
export ATTACHMENTS_DIR=$work_root/attachments
export ENVIRONMENT=production
export SERVER_HOST=127.0.0.1
export PORT=$port
export VISION_DIST_DIR=${VISION_DIST_DIR:-$repo_root/dist}

cd "$repo_root"
bun run apps/node-backend/scripts/db-migrate.ts
if [[ ${VISION_NATIVE_VERIFY_MIGRATIONS:-0} == 1 ]]; then
  bun run apps/node-backend/scripts/db-migrate.ts status
  # Round-trip the latest migration only when it ships a *.down.sql rollback.
  latest_migration=$(find db/migrations -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' \
    ! -name '*.down.sql' | sort | tail -n 1)
  if [[ -n $latest_migration && -f ${latest_migration%.sql}.down.sql ]]; then
    bun run apps/node-backend/scripts/db-migrate.ts down
    bun run apps/node-backend/scripts/db-migrate.ts up
  fi
fi

(
  cd "$repo_root/apps/node-backend"
  exec bun run src/main.ts
) >"$backend_log" 2>&1 &
backend_pid=$!
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    break
  fi
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null &&
      kill -0 "$backend_pid" 2>/dev/null; then
    ready=1
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
