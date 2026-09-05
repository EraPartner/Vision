#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
cloud_env="$codex_home/vision-cloud-test-db.env"
expected_url='postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test'

# shellcheck source=.codex/cloud/lib.sh
source "$script_dir/lib.sh"

if [[ -f "$cloud_env" ]]; then
  # shellcheck disable=SC1090
  source "$cloud_env"
fi

if [[ "${CODEX_SESSION_ENV:-}" != cloud ]]; then
  printf '%s\n' 'Refusing to reset a database outside a Codex cloud session.' >&2
  exit 1
fi
if [[ "${TEST_DATABASE_URL:-}" != "$expected_url" ]]; then
  printf '%s\n' \
    'Refusing to reset TEST_DATABASE_URL: it is not the managed disposable cloud database.' >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" && "$DATABASE_URL" != "$expected_url" ]]; then
  printf '%s\n' 'Refusing to reset because DATABASE_URL points at a different database.' >&2
  exit 1
fi

command -v psql >/dev/null 2>&1 || {
  printf '%s\n' 'psql is required to reset the managed cloud test database.' >&2
  exit 1
}
command -v bun >/dev/null 2>&1 || {
  printf '%s\n' 'Bun is required to migrate the managed cloud test database.' >&2
  exit 1
}

# pg_stat_statements is not trusted: only the fixed managed database's bootstrap
# uses the administrator. Migrations and application tests retain NOSUPERUSER.
if (( EUID == 0 )); then
  postgres_user=(runuser -u postgres --)
else
  command -v sudo >/dev/null && sudo -n true || {
    printf '%s\n' 'Managed query statistics setup requires non-interactive sudo.' >&2
    exit 1
  }
  postgres_user=(sudo -n -u postgres)
fi

export DATABASE_URL="$expected_url"
export TEST_DATABASE_URL="$expected_url"
export PGCONNECT_TIMEOUT=5
export PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=5000'
export VISION_CACHE_DIR="${VISION_CACHE_DIR:-$codex_home/vision-cloud-state/migration-cache}"
export VISION_MIGRATE_TIMEOUT_MS=300000

cd "$repo_root"
cloud_run_step 'Reset the managed PostgreSQL test schema' \
  cloud_run_with_timeout 60s \
  psql "$expected_url" --no-password --set=ON_ERROR_STOP=1 --quiet \
  --command='DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public AUTHORIZATION vision_test;
GRANT ALL ON SCHEMA public TO public;'

# DROP SCHEMA CASCADE removes extensions in public; recreate the untrusted
# extension as the administrator before running migrations as vision_test.
cloud_run_step 'Install managed query statistics extension' \
  cloud_run_with_timeout 60s "${postgres_user[@]}" \
  psql --host=/var/run/postgresql --port=5432 --username=postgres \
  --dbname=vision_test --no-password --set=ON_ERROR_STOP=1 --quiet \
  --command='CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;'

cloud_run_step 'Migrate the clean PostgreSQL test schema' \
  cloud_run_with_timeout 330s bun run apps/node-backend/scripts/db-migrate.js

cloud_log 'Managed native test database reset to a clean migrated schema.'
