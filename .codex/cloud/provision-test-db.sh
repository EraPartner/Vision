#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
cloud_env="$codex_home/vision-cloud-test-db.env"
state_dir="$codex_home/vision-cloud-state"
test_db_url='postgresql://vision_test:vision_test@127.0.0.1:5432/vision_test'
postgres_bin="${VISION_CLOUD_POSTGRES_BIN:-/usr/lib/postgresql/18/bin/postgres}"
postgres_common_dir="${VISION_CLOUD_POSTGRES_COMMON_DIR:-/etc/postgresql-common}"
pgdg_key_path="${VISION_CLOUD_PGDG_KEY_PATH:-/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc}"
pgdg_source_path="${VISION_CLOUD_PGDG_SOURCE_PATH:-/etc/apt/sources.list.d/pgdg.list}"
os_release="${VISION_CLOUD_OS_RELEASE:-/etc/os-release}"

mode="${1:-provision}"
if [[ "$mode" != provision && "$mode" != --install-packages-only ]]; then
  printf 'Usage: %s [--install-packages-only]\n' "$0" >&2
  exit 2
fi

# shellcheck source=.codex/cloud/lib.sh
source "$script_dir/lib.sh"

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
  sudo -n true >/dev/null 2>&1 || {
    printf '%s\n' 'PostgreSQL setup requires non-interactive passwordless sudo.' >&2
    exit 1
  }
  root=(sudo -n)
  postgres_user=(sudo -n -u postgres)
fi

apt_get=(
  "${root[@]}"
  env DEBIAN_FRONTEND=noninteractive
  apt-get
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
  -o DPkg::Lock::Timeout=60
  -o Dpkg::Use-Pty=0
)

if [[ ! -x "$postgres_bin" ]]; then
  command -v curl >/dev/null || {
    cloud_run_step 'Refresh package indexes for curl' \
      cloud_run_with_heartbeat 120s 30s 'curl package index refresh' \
        "${apt_get[@]}" update
    cloud_run_step 'Install curl and certificate authorities' \
      cloud_run_with_heartbeat 120s 30s 'curl and certificate installation' \
        "${apt_get[@]}" install -y --no-install-recommends \
        ca-certificates curl
  }

  os_codename="$(awk -F= '$1 == "VERSION_CODENAME" { gsub(/^"|"$/, "", $2); print $2; exit }' "$os_release")"
  if [[ -z "$os_codename" ]]; then
    printf '%s\n' 'Could not determine the operating-system codename for PostgreSQL packages.' >&2
    exit 1
  fi

  pg_key="$(mktemp)"
  pg_source="$(mktemp)"
  configured_createcluster_conf=''
  cleanup_temp() {
    rm -f "$pg_key" "$pg_source"
    if [[ -n "$configured_createcluster_conf" ]]; then
      rm -f "$configured_createcluster_conf"
    fi
  }
  trap cleanup_temp EXIT

  cloud_run_step 'Download the PostgreSQL package signing key' \
    cloud_run_with_timeout 90s curl -fsSL \
      --connect-timeout 15 \
      --max-time 60 \
      --retry 3 \
      --retry-all-errors \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o "$pg_key"
  printf '%s\n' \
    "deb [signed-by=$pgdg_key_path] https://apt.postgresql.org/pub/repos/apt ${os_codename}-pgdg main" \
    > "$pg_source"
  "${root[@]}" install -D -m 0644 "$pg_key" \
    "$pgdg_key_path"
  "${root[@]}" install -D -m 0644 "$pg_source" \
    "$pgdg_source_path"
  cloud_run_step 'Refresh PostgreSQL package indexes' \
    cloud_run_with_heartbeat 120s 30s 'PostgreSQL package index refresh' \
      "${apt_get[@]}" update
  cloud_run_step 'Install PostgreSQL package support' \
    cloud_run_with_heartbeat 120s 30s 'PostgreSQL package support installation' \
      "${apt_get[@]}" install -y --no-install-recommends \
      postgresql-common

  createcluster_conf="$postgres_common_dir/createcluster.conf"
  configured_createcluster_conf="$(mktemp)"
  awk '
    BEGIN { updated = 0 }
    /^[[:space:]#]*create_main_cluster[[:space:]]*=/ {
      print "create_main_cluster = false"
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) print "create_main_cluster = false"
    }
  ' "$createcluster_conf" > "$configured_createcluster_conf"
  "${root[@]}" install -m 0644 "$configured_createcluster_conf" "$createcluster_conf"
  rm -f "$configured_createcluster_conf"
  configured_createcluster_conf=''

  cloud_run_step 'Install PostgreSQL 18' \
    cloud_run_with_heartbeat 300s 30s 'PostgreSQL 18 installation' \
      "${apt_get[@]}" install -y --no-install-recommends \
      postgresql-18

  cleanup_temp
  trap - EXIT
fi

if [[ "$mode" == --install-packages-only ]]; then
  cloud_log 'PostgreSQL 18 packages are installed; cluster creation is deferred.'
  exit 0
fi

if ! cloud_run_with_timeout 15s "${root[@]}" \
  pg_ctlcluster 18 main status >/dev/null 2>&1; then
  if ! cloud_run_step 'Start PostgreSQL 18' \
    cloud_run_with_timeout 90s "${root[@]}" pg_ctlcluster 18 main start; then
    if [[ ! -s /var/lib/postgresql/18/main/PG_VERSION ]]; then
      cloud_run_step 'Create and start the PostgreSQL 18 cluster' \
        cloud_run_with_timeout 120s "${root[@]}" pg_createcluster 18 main \
          --locale=C.UTF-8 --encoding=UTF8 --start
    else
      printf '%s\n' 'PostgreSQL 18 exists but could not be started.' >&2
      exit 1
    fi
  fi
fi

wait_for_postgres() {
  for _ in $(seq 1 15); do
    if pg_isready -h 127.0.0.1 -p 5432 -t 1 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cloud_run_step 'Wait for PostgreSQL 18 readiness' wait_for_postgres || {
  printf '%s\n' 'PostgreSQL 18 did not become ready within 30 seconds.' >&2
  exit 1
}

export PGCONNECT_TIMEOUT=5
export PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=5000'

cloud_run_step 'Ensure the disposable PostgreSQL role exists' \
  cloud_run_with_timeout 45s "${postgres_user[@]}" \
  psql --dbname=postgres --set=ON_ERROR_STOP=1 --quiet \
  --command="DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vision_test') THEN
      CREATE ROLE vision_test LOGIN NOSUPERUSER CREATEDB CREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD 'vision_test';
    ELSE
      ALTER ROLE vision_test WITH LOGIN NOSUPERUSER CREATEDB CREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD 'vision_test';
    END IF;
  END \$\$;"

test_db_encoding="$(cloud_run_with_timeout 45s "${postgres_user[@]}" \
  psql --dbname=postgres --tuples-only --no-align \
  --command="SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = 'vision_test'" \
  | tr -d '[:space:]')"
if [[ -n "$test_db_encoding" && "$test_db_encoding" != UTF8 ]]; then
  cloud_log "Recreating disposable vision_test database as UTF8 (was $test_db_encoding)."
  cloud_run_step 'Disconnect the disposable PostgreSQL database' \
    cloud_run_with_timeout 45s "${postgres_user[@]}" \
    psql --dbname=postgres --set=ON_ERROR_STOP=1 --quiet \
    --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = 'vision_test' AND pid <> pg_backend_pid();"
  cloud_run_step 'Drop the non-UTF8 disposable PostgreSQL database' \
    cloud_run_with_timeout 45s "${postgres_user[@]}" dropdb vision_test
  test_db_encoding=''
fi
if [[ -z "$test_db_encoding" ]]; then
  cloud_run_step 'Create the disposable PostgreSQL database' \
    cloud_run_with_timeout 45s "${postgres_user[@]}" \
    createdb --owner=vision_test --encoding=UTF8 --locale=C.UTF-8 \
      --template=template0 vision_test
fi

install -d -m 0700 "$codex_home"
install -d -m 0700 "$state_dir"
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

cd "$repo_root"
bash "$script_dir/reset-test-db.sh"

cloud_log 'Native PostgreSQL 18 is ready for bun run test and bun run test:db.'
