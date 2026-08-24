#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/vision-bun-install-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
fixture_root="$test_root/fixture"
test_home="$test_root/home"
mkdir -p "$fake_bin" "$fixture_root/bun-linux-x64" "$test_home"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" "test-version"' \
  > "$fixture_root/bun-linux-x64/bun"
chmod +x "$fixture_root/bun-linux-x64/bun"

archive="$test_root/bun.zip"
(
  cd "$fixture_root"
  python3 -m zipfile -c "$archive" bun-linux-x64
)
if command -v sha256sum >/dev/null 2>&1; then
  archive_sha="$(sha256sum "$archive" | awk '{ print $1 }')"
else
  archive_sha="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
fi

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'sleep 5' \
  > "$fake_bin/bun"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" x86_64' \
  > "$fake_bin/uname"

cat > "$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' curl >> "$CALL_LOG"
while (( $# )); do
  if [[ "$1" == -o ]]; then
    cp "$FIXTURE_ARCHIVE" "$2"
    exit 0
  fi
  shift
done
exit 2
FAKE_CURL

chmod +x "$fake_bin/bun" "$fake_bin/uname" "$fake_bin/curl"

export PATH="$fake_bin:/usr/bin:/bin"
export HOME="$test_home"
export CODEX_HOME="$test_home/.codex"
export CALL_LOG="$test_root/calls.log"
export FIXTURE_ARCHIVE="$archive"
export VISION_CLOUD_DISABLE_TIMEOUT=0
export VISION_CLOUD_BUN_VERSION=test-version
export VISION_CLOUD_BUN_CHECK_TIMEOUT=0.1s
export VISION_CLOUD_BUN_SHA_X64="$archive_sha"
export VISION_CLOUD_BUN_URL='https://example.invalid/bun.zip'

bash "$repo_root/.codex/cloud/install-bun.sh" >/dev/null

# shellcheck disable=SC1090,SC1091
source "$CODEX_HOME/vision-cloud-toolchain.env"
[[ "$(command -v bun)" == "$CODEX_HOME/vision-cloud-bin/bun" ]]
[[ "$(bun --version)" == test-version ]]
[[ "$(grep -c '^curl$' "$CALL_LOG")" -eq 1 ]]
[[ "$(grep -Fc "source '$CODEX_HOME/vision-cloud-toolchain.env'" "$HOME/.bashrc")" -eq 1 ]]

bash "$repo_root/.codex/cloud/install-bun.sh" >/dev/null
[[ "$(grep -c '^curl$' "$CALL_LOG")" -eq 1 ]]
[[ "$(grep -Fc "source '$CODEX_HOME/vision-cloud-toolchain.env'" "$HOME/.bashrc")" -eq 1 ]]

printf '%s\n' 'PASS: cloud Bun bootstrap tests'
