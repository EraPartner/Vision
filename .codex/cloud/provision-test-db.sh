#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
cloud_env="$codex_home/vision-cloud-test-db.env"
test_db_url='postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test'

if [[ "$(uname -s)" != Linux ]] || ! command -v apt-get >/dev/null; then
  printf '%s\n' \
    'Native cloud test database setup requires a Debian or Ubuntu Codex environment.' >&2
  exit 1
fi

if (( EUID == 0 )); then
  root=()
  postgres_user=(runuser -u postgres --)
else
  command -v sudo >/dev/null || {
    printf '%s\n' 'PostgreSQL setup requires root access or sudo.' >&2
    exit 1
  }
  root=(sudo)
  postgres_user=(sudo -u postgres)
fi

if [[ ! -x /usr/lib/postgresql/18/bin/postgres ]]; then
  command -v curl >/dev/null || {
    "${root[@]}" apt-get update
    "${root[@]}" apt-get install -y --no-install-recommends ca-certificates curl
  }

  os_codename="$(awk -F= '$1 == "VERSION_CODENAME" { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release)"
  if [[ -z "$os_codename" ]]; then
    printf '%s\n' 'Could not determine the operating-system codename for PostgreSQL packages.' >&2
    exit 1
  fi

  pg_key="$(mktemp)"
  pg_source="$(mktemp)"
  cleanup_temp() {
    rm -f "$pg_key" "$pg_source"
  }
  trap cleanup_temp EXIT

  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$pg_key"
  printf '%s\n' \
    "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${os_codename}-pgdg main" \
    > "$pg_source"
  "${root[@]}" install -D -m 0644 "$pg_key" \
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  "${root[@]}" install -D -m 0644 "$pg_source" \
    /etc/apt/sources.list.d/pgdg.list
  "${root[@]}" apt-get update
  "${root[@]}" apt-get install -y --no-install-recommends postgresql-18

  cleanup_temp
  trap - EXIT
fi

if ! "${root[@]}" pg_ctlcluster 18 main status >/dev/null 2>&1; then
  if ! "${root[@]}" pg_ctlcluster 18 main start; then
    if [[ ! -s /var/lib/postgresql/18/main/PG_VERSION ]]; then
      "${root[@]}" pg_createcluster 18 main --start
    else
      printf '%s\n' 'PostgreSQL 18 exists but could not be started.' >&2
      exit 1
    fi
  fi
fi

for _ in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || {
  printf '%s\n' 'PostgreSQL 18 did not become ready within 30 seconds.' >&2
  exit 1
}

"${postgres_user[@]}" psql --dbname=postgres --set=ON_ERROR_STOP=1 --quiet \
  --command="DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vision_test') THEN
      CREATE ROLE vision_test LOGIN SUPERUSER PASSWORD 'vision_test';
    ELSE
      ALTER ROLE vision_test WITH LOGIN SUPERUSER PASSWORD 'vision_test';
    END IF;
  END \$\$;"

if ! "${postgres_user[@]}" psql --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = 'vision_test'" | grep -qx 1; then
  "${postgres_user[@]}" createdb --owner=vision_test vision_test
fi

install -d -m 0700 "$codex_home"
umask 077
printf '%s\n' \
  'export CODEX_SESSION_ENV=cloud' \
  ": \"\${DATABASE_URL:='$test_db_url'}\"" \
  ": \"\${TEST_DATABASE_URL:='$test_db_url'}\"" \
  'export DATABASE_URL TEST_DATABASE_URL' \
  > "$cloud_env"

touch "$HOME/.bashrc"
source_line="source '$cloud_env'"
grep -Fqx "$source_line" "$HOME/.bashrc" || printf '%s\n' "$source_line" >> "$HOME/.bashrc"

export CODEX_SESSION_ENV=cloud
export DATABASE_URL="$test_db_url"
export TEST_DATABASE_URL="$test_db_url"
export VISION_CACHE_DIR="${TMPDIR:-/tmp}/vision-cloud-test-db-cache"

cd "$repo_root"
bun run apps/node-backend/scripts/db-migrate.js

printf '%s\n' \
  'Native PostgreSQL 18 is ready for bun run test and bun run test:db.'
