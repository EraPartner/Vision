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

# Active migrations use only PostgreSQL 18 trusted extensions. The database
# owner can install these without SUPERUSER; fail if another extension appears
# so its privilege requirement is reviewed deliberately.
extensions="$(
  grep -Rh --include='*.py' -oE 'CREATE EXTENSION IF NOT EXISTS [A-Za-z0-9_]+' \
    "$repo_root/alembic/versions" | awk '{ print $6 }' | sort -u
)"
if [[ "$extensions" != $'pg_trgm\npgcrypto' ]]; then
  printf 'Unexpected active migration extension set:\n%s\n' "$extensions" >&2
  exit 1
fi

mkdir -p "$test_root/bin" "$test_root/home/.codex"

cat > "$test_root/bin/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -euo pipefail
printf 'psql:%s\n' "$*" >> "$CALL_LOG"
FAKE_PSQL

cat > "$test_root/bin/bun" <<'FAKE_BUN'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun:%s\n' "$*" >> "$CALL_LOG"
FAKE_BUN

chmod +x "$test_root/bin/psql" "$test_root/bin/bun"

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

bash "$repo_root/scripts/with-test-db.sh" tests/setup/db.test.js
[[ "$(grep -c '^psql:' "$CALL_LOG")" -eq 2 ]]
grep -Fq 'bun:vitest run tests/setup/db.test.js' "$CALL_LOG"

export TEST_DATABASE_URL='postgresql://example.invalid/not-managed'
export DATABASE_URL="$TEST_DATABASE_URL"
if bash "$repo_root/.codex/cloud/reset-test-db.sh"; then
  printf '%s\n' 'Expected an unmanaged database URL to be rejected.' >&2
  exit 1
fi
[[ "$(grep -c '^psql:' "$CALL_LOG")" -eq 2 ]]

printf '%s\n' 'PASS: managed cloud database reset tests'
