#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/vision-db-provision-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
system_root="$test_root/system"
mkdir -p \
  "$fake_bin" \
  "$system_root/etc/apt/sources.list.d" \
  "$system_root/etc/postgresql-common" \
  "$system_root/usr/lib/postgresql/18/bin" \
  "$system_root/usr/share/postgresql-common/pgdg" \
  "$test_root/home/.codex"

printf '%s\n' 'VERSION_CODENAME="noble"' > "$system_root/os-release"

cat > "$fake_bin/uname" <<'FAKE_UNAME'
#!/usr/bin/env bash
printf '%s\n' Linux
FAKE_UNAME

cat > "$fake_bin/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == -n ]] && shift
[[ "${1:-}" == true ]] && exit 0
exec "$@"
FAKE_SUDO

cat > "$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
while (( $# )); do
  if [[ "$1" == -o ]]; then
    printf '%s\n' 'test signing key' > "$2"
    exit 0
  fi
  shift
done
exit 2
FAKE_CURL

cat > "$fake_bin/install" <<'FAKE_INSTALL'
#!/usr/bin/env bash
set -euo pipefail
args=()
for argument in "$@"; do
  [[ "$argument" == -D ]] || args+=("$argument")
done
exec /usr/bin/install "${args[@]}"
FAKE_INSTALL

cat > "$fake_bin/timeout" <<'FAKE_TIMEOUT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TIMEOUT_LOG"
while [[ "${1:-}" == --foreground || "${1:-}" == --kill-after=* ]]; do
  shift
done
(( $# >= 2 ))
shift
exec "$@"
FAKE_TIMEOUT

cat > "$fake_bin/apt-get" <<'FAKE_APT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALL_LOG"
if [[ " $* " == *' postgresql-common '* ]]; then
  printf '%s\n' '# create_main_cluster = true' > "$VISION_CLOUD_POSTGRES_COMMON_DIR/createcluster.conf"
fi
if [[ " $* " == *' postgresql-18 '* ]]; then
  /usr/bin/install -m 0755 /dev/null "$VISION_CLOUD_POSTGRES_BIN"
fi
FAKE_APT

chmod +x \
  "$fake_bin/uname" \
  "$fake_bin/sudo" \
  "$fake_bin/curl" \
  "$fake_bin/install" \
  "$fake_bin/timeout" \
  "$fake_bin/apt-get"

export PATH="$fake_bin:/usr/bin:/bin"
export HOME="$test_root/home"
export CODEX_HOME="$test_root/home/.codex"
export CALL_LOG="$test_root/apt-calls.log"
export TIMEOUT_LOG="$test_root/timeouts.log"
export VISION_CLOUD_OS_RELEASE="$system_root/os-release"
export VISION_CLOUD_POSTGRES_BIN="$system_root/usr/lib/postgresql/18/bin/postgres"
export VISION_CLOUD_POSTGRES_COMMON_DIR="$system_root/etc/postgresql-common"
export VISION_CLOUD_PGDG_KEY_PATH="$system_root/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"
export VISION_CLOUD_PGDG_SOURCE_PATH="$system_root/etc/apt/sources.list.d/pgdg.list"

bash "$repo_root/.codex/cloud/provision-test-db.sh" --install-packages-only >/dev/null

package_line="$(grep -n -- '--install-packages-only' "$repo_root/.codex/cloud/setup.sh" | head -1 | cut -d: -f1)"
dependency_line="$(grep -n 'install-dependencies.sh' "$repo_root/.codex/cloud/setup.sh" | head -1 | cut -d: -f1)"
[[ "$package_line" -lt "$dependency_line" ]]

grep -Fq 'Dpkg::Use-Pty=0 update' "$CALL_LOG"
grep -Fq 'Dpkg::Use-Pty=0 install -y --no-install-recommends postgresql-common' "$CALL_LOG"
grep -Fq 'Dpkg::Use-Pty=0 install -y --no-install-recommends postgresql-18' "$CALL_LOG"
[[ "$(grep -Ec '^--foreground --kill-after=10s .*apt-get ' "$TIMEOUT_LOG")" == 3 ]]
grep -Eq '^--foreground --kill-after=10s 300s .*postgresql-common$' "$TIMEOUT_LOG"
grep -Fxq 'create_main_cluster = false' \
  "$VISION_CLOUD_POSTGRES_COMMON_DIR/createcluster.conf"
[[ -x "$VISION_CLOUD_POSTGRES_BIN" ]]

grep -Fq "cloud_run_step 'Create the PostgreSQL 18 cluster'" \
  "$repo_root/.codex/cloud/provision-test-db.sh"
grep -Fq 'cloud_run_with_closed_fds_timeout 90s' \
  "$repo_root/.codex/cloud/provision-test-db.sh"
if grep -Fq -- '--encoding=UTF8 --start' \
  "$repo_root/.codex/cloud/provision-test-db.sh"; then
  printf '%s\n' 'PostgreSQL cluster creation must not launch an unisolated daemon.' >&2
  exit 1
fi

first_call_count="$(wc -l < "$CALL_LOG" | tr -d '[:space:]')"
bash "$repo_root/.codex/cloud/provision-test-db.sh" --install-packages-only >/dev/null
second_call_count="$(wc -l < "$CALL_LOG" | tr -d '[:space:]')"
[[ "$first_call_count" == "$second_call_count" ]]

if bash "$repo_root/.codex/cloud/provision-test-db.sh" --unknown-option >/dev/null 2>&1; then
  printf '%s\n' 'Expected an unknown provisioning option to fail.' >&2
  exit 1
fi

# Full provisioning remains mocked: no package install, daemon or database runs.
cat > "$fake_bin/sudo" <<'FAKE_ADMIN'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == -n ]] && shift
[[ "${1:-}" == true ]] && exit 0
if [[ "${1:-}" == -u ]]; then
  [[ "${2:-}" == postgres ]] || exit 1
  shift 2
fi
[[ "${1:-}" == -- ]] && shift
exec "$@"
FAKE_ADMIN
cp "$fake_bin/sudo" "$fake_bin/runuser"
cat > "$fake_bin/pg_conftool" <<'FAKE_CONFIG'
#!/usr/bin/env bash
set -euo pipefail
printf 'conftool:%s\n' "$*" >> "$CALL_LOG"
if [[ "$3" == show ]]; then
  printf 'shared_preload_libraries = %s\n' "$(cat "$PRELOAD_STATE")"
else
  printf '%s\n' "$5" > "$PRELOAD_STATE"
fi
FAKE_CONFIG
cat > "$fake_bin/pg_ctlcluster" <<'FAKE_CLUSTER'
#!/usr/bin/env bash
printf 'cluster:%s\n' "$*" >> "$CALL_LOG"
FAKE_CLUSTER
cat > "$fake_bin/pg_isready" <<'FAKE_READY'
#!/usr/bin/env bash
exit 0
FAKE_READY
cat > "$fake_bin/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
printf 'psql:%s\n' "$*" >> "$CALL_LOG"
case "$*" in
  *pg_encoding_to_char*) printf '%s\n' UTF8 ;;
  *'SHOW shared_preload_libraries'*) cat "$PRELOAD_STATE" ;;
esac
FAKE_PSQL
cat > "$fake_bin/bun" <<'FAKE_BUN'
#!/usr/bin/env bash
printf 'bun:%s\n' "$*" >> "$CALL_LOG"
FAKE_BUN
chmod +x "$fake_bin/"*
export PRELOAD_STATE="$test_root/preloads"
printf '%s\n' auto_explain > "$PRELOAD_STATE"
bash "$repo_root/.codex/cloud/provision-test-db.sh" >/dev/null
grep -Fxq 'auto_explain,pg_stat_statements' "$PRELOAD_STATE"
[[ "$(grep -c '^cluster:18 main restart$' "$CALL_LOG")" -eq 1 ]]
grep -Fq 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;' "$CALL_LOG"
# Repeat provisioning must not restart an already configured cluster.
bash "$repo_root/.codex/cloud/provision-test-db.sh" >/dev/null
[[ "$(grep -c '^cluster:18 main restart$' "$CALL_LOG")" -eq 1 ]]

# A default empty preload value must also configure successfully.
printf '\n' > "$PRELOAD_STATE"
bash "$repo_root/.codex/cloud/provision-test-db.sh" >/dev/null
grep -Fxq 'pg_stat_statements' "$PRELOAD_STATE"
[[ "$(grep -c '^cluster:18 main restart$' "$CALL_LOG")" -eq 2 ]]

printf '%s\n' 'PASS: cloud PostgreSQL package provisioning tests'
