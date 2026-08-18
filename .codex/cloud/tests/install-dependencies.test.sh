#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cloud_dir="$(cd "$script_dir/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

fixture="$test_dir/repo"
fake_bin="$test_dir/bin"
call_log="$test_dir/calls.log"
test_home="$test_dir/home"

mkdir -p \
  "$fixture/config" \
  "$fixture/apps/frontend" \
  "$fixture/apps/node-backend" \
  "$fixture/packages/shared-utils" \
  "$fixture/packages/types" \
  "$fake_bin" \
  "$test_home"

for file in \
  package.json \
  apps/frontend/package.json \
  apps/node-backend/package.json \
  packages/shared-utils/package.json \
  packages/types/package.json; do
  printf '{}\n' > "$fixture/$file"
done
printf 'root-lock\n' > "$fixture/bun.lock"
printf 'backend-lock\n' > "$fixture/apps/node-backend/bun.lock"
printf 'alembic>=1\n' > "$fixture/config/requirements.txt"
: > "$call_log"

# Literal shell source follows; expansion must happen when the fake command runs.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "--version" ]]; then' \
  '  printf "%s\n" "Python 3.12.0"' \
  '  exit 0' \
  'fi' \
  'printf "python:%s\n" "$*" >> "$CALL_LOG"' \
  'if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then' \
  '  mkdir -p "$3/bin"' \
  '  cp "$FAKE_BIN/python3" "$3/bin/python"' \
  '  printf "#!/usr/bin/env bash\nexit 0\n" > "$3/bin/alembic"' \
  '  chmod +x "$3/bin/python" "$3/bin/alembic"' \
  'fi' \
  > "$fake_bin/python3"
chmod +x "$fake_bin/python3"

# Literal shell source follows; expansion must happen when the fake command runs.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "--version" ]]; then' \
  '  printf "%s\n" "1.2.3"' \
  '  exit 0' \
  'fi' \
  'printf "bun-install:%s\n" "$*" >> "$CALL_LOG"' \
  'mkdir -p node_modules/.bun' \
  > "$fake_bin/bun"
chmod +x "$fake_bin/bun"

export CALL_LOG="$call_log"
export FAKE_BIN="$fake_bin"
export PATH="$fake_bin:/usr/bin:/bin"
export HOME="$test_home"
export CODEX_HOME="$test_home/.codex"
export VISION_CLOUD_REPO_ROOT="$fixture"
export VISION_CLOUD_DISABLE_TIMEOUT=1

run_installer() {
  bash "$cloud_dir/install-dependencies.sh" >/dev/null
}

count_calls() {
  local pattern="$1"
  grep -Ec "$pattern" "$call_log" || true
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s (expected %s, got %s)\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

run_installer
assert_equals 1 "$(count_calls '^python:-m pip ')" 'first run installs Python dependencies once'
assert_equals 1 "$(count_calls '^bun-install:')" 'first run installs workspace dependencies once'
assert_equals 1 "$(count_calls '^bun-install:.*--ignore-scripts')" \
  'workspace install suppresses the root prepare hook'

run_installer
assert_equals 1 "$(count_calls '^python:-m pip ')" 'unchanged Python dependencies are skipped'
assert_equals 1 "$(count_calls '^bun-install:')" 'unchanged Bun dependencies are skipped'

printf 'sqlalchemy>=2\n' >> "$fixture/config/requirements.txt"
run_installer
assert_equals 2 "$(count_calls '^python:-m pip ')" 'requirements change reinstalls Python dependencies'
assert_equals 1 "$(count_calls '^bun-install:')" 'requirements change does not reinstall Bun dependencies'

printf 'backend-package-changed\n' >> "$fixture/apps/node-backend/package.json"
run_installer
assert_equals 2 "$(count_calls '^bun-install:')" 'workspace manifest change reinstalls Bun dependencies'

rm -rf "$fixture/node_modules/.bun"
run_installer
assert_equals 3 "$(count_calls '^bun-install:')" \
  'missing workspace installation overrides a matching marker'

# shellcheck source=.codex/cloud/lib.sh
source "$cloud_dir/lib.sh"
if cloud_run_step 'expected test failure' false >/dev/null; then
  printf 'FAIL: cloud_run_step did not propagate a command failure\n' >&2
  exit 1
fi
if command -v timeout >/dev/null 2>&1; then
  unset VISION_CLOUD_DISABLE_TIMEOUT
  if cloud_run_with_timeout 0.1s sleep 5; then
    printf 'FAIL: cloud_run_with_timeout did not stop a long-running command\n' >&2
    exit 1
  fi
fi

printf '%s\n' 'PASS: cloud dependency cache tests'
