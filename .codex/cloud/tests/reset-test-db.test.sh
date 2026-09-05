#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/vision-db-reset-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

provision_script="$repo_root/.codex/cloud/provision-test-db.sh"
grep -Fq 'CREATE ROLE vision_test LOGIN NOSUPERUSER CREATEDB CREATEROLE' \
  "$provision_script"
grep -Fq 'ALTER ROLE vision_test WITH LOGIN NOSUPERUSER CREATEDB CREATEROLE' \
  "$provision_script"
if grep -Eq '(CREATE ROLE|ALTER ROLE).*vision_test.*LOGIN SUPERUSER' "$provision_script"; then
  printf '%s\n' 'The managed test role must not be a PostgreSQL superuser.' >&2
  exit 1
fi

# Trusted extensions are installed by the database owner. Query statistics
# requires the narrowly scoped administrator bootstrap tested below. Keep this
# inventory explicit so new extensions trigger a privilege review.
extensions="$(
  grep -Rh --include='*.py' -oE 'CREATE EXTENSION IF NOT EXISTS [A-Za-z0-9_]+' \
    "$repo_root/alembic/versions" | awk '{ print $6 }' | sort -u
)"
if [[ "$extensions" != $'pg_stat_statements\npg_trgm\npgcrypto' ]]; then
  printf 'Unexpected active migration extension set:\n%s\n' "$extensions" >&2
  exit 1
fi

mkdir -p "$test_root/bin" "$test_root/home/.codex"

cat > "$test_root/bin/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -euo pipefail
printf 'psql:%s\n' "$*" >> "$CALL_LOG"
if [[ "${FAIL_EXTENSION:-0}" == 1 && "$*" == *'CREATE EXTENSION'* ]]; then exit 1; fi
FAKE_PSQL

cat > "$test_root/bin/bun" <<'FAKE_BUN'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun:%s\n' "$*" >> "$CALL_LOG"
FAKE_BUN

cat > "$test_root/bin/sudo" <<'FAKE_ADMIN'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == -n ]] && shift
[[ "${1:-}" == true ]] && exit 0
[[ "${1:-}" == -u && "${2:-}" == postgres ]] || exit 1
shift 2
[[ "${1:-}" == -- ]] && shift
printf 'admin:%s\n' "$*" >> "$CALL_LOG"
exec "$@"
FAKE_ADMIN
cp "$test_root/bin/sudo" "$test_root/bin/runuser"
chmod +x "$test_root/bin/psql" "$test_root/bin/bun" "$test_root/bin/sudo" "$test_root/bin/runuser"

export CALL_LOG="$test_root/calls.log"
export HOME="$test_root/home"
export CODEX_HOME="$test_root/home/.codex"
export PATH="$test_root/bin:/usr/bin:/bin"
export CODEX_SESSION_ENV=cloud
export TEST_DATABASE_URL='postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test'
export DATABASE_URL="$TEST_DATABASE_URL"
export VISION_CLOUD_DISABLE_TIMEOUT=1

bash "$repo_root/.codex/cloud/reset-test-db.sh"
grep -Fq 'DROP SCHEMA IF EXISTS public CASCADE' "$CALL_LOG"
grep -Fq 'bun:run apps/node-backend/scripts/db-migrate.js' "$CALL_LOG"
grep -Fq 'admin:psql --host=/var/run/postgresql --port=5432 --username=postgres --dbname=vision_test' "$CALL_LOG"
grep -Fq 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;' "$CALL_LOG"
# Administrator bootstrap must happen between reset and unprivileged migrations.
reset_line="$(grep -n 'DROP SCHEMA' "$CALL_LOG" | head -1 | cut -d: -f1)"
admin_line="$(grep -n '^admin:' "$CALL_LOG" | head -1 | cut -d: -f1)"
migrate_line="$(grep -n '^bun:run' "$CALL_LOG" | head -1 | cut -d: -f1)"
[[ "$reset_line" -lt "$admin_line" && "$admin_line" -lt "$migrate_line" ]]

bash "$repo_root/scripts/with-test-db.sh" tests/setup/db.test.js
[[ "$(grep -c '^psql:' "$CALL_LOG")" -eq 4 ]]
grep -Fq 'bun:vitest run tests/setup/db.test.js' "$CALL_LOG"

export TEST_DATABASE_URL='postgresql://example.invalid/not-managed'
export DATABASE_URL="$TEST_DATABASE_URL"
if bash "$repo_root/.codex/cloud/reset-test-db.sh"; then
  printf '%s\n' 'Expected an unmanaged database URL to be rejected.' >&2
  exit 1
fi
[[ "$(grep -c '^psql:' "$CALL_LOG")" -eq 4 ]]

# If administrator extension creation fails, never continue to migrations.
export TEST_DATABASE_URL='postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test'
export DATABASE_URL="$TEST_DATABASE_URL"
export FAIL_EXTENSION=1
if bash "$repo_root/.codex/cloud/reset-test-db.sh"; then
  printf '%s\n' 'Expected administrator extension failure to stop reset.' >&2
  exit 1
fi
[[ "$(grep -c '^bun:run' "$CALL_LOG")" -eq 2 ]]

printf '%s\n' 'PASS: managed cloud database reset tests'
