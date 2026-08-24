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
if [[ "${1:-}" == --kill-after=* ]]; then
  shift
fi
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
grep -Eq '^--kill-after=10s 300s .*postgresql-common$' "$TIMEOUT_LOG"
grep -Fxq 'create_main_cluster = false' \
  "$VISION_CLOUD_POSTGRES_COMMON_DIR/createcluster.conf"
[[ -x "$VISION_CLOUD_POSTGRES_BIN" ]]

first_call_count="$(wc -l < "$CALL_LOG" | tr -d '[:space:]')"
bash "$repo_root/.codex/cloud/provision-test-db.sh" --install-packages-only >/dev/null
second_call_count="$(wc -l < "$CALL_LOG" | tr -d '[:space:]')"
[[ "$first_call_count" == "$second_call_count" ]]

if bash "$repo_root/.codex/cloud/provision-test-db.sh" --unknown-option >/dev/null 2>&1; then
  printf '%s\n' 'Expected an unknown provisioning option to fail.' >&2
  exit 1
fi

printf '%s\n' 'PASS: cloud PostgreSQL package provisioning tests'
