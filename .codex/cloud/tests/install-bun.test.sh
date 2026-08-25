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
if [[ "${CURL_FAIL:-0}" == 1 ]]; then
  exit 22
fi
while (( $# )); do
  if [[ "$1" == -o ]]; then
    cp "$FIXTURE_ARCHIVE" "$2"
    exit 0
  fi
  shift
done
exit 2
FAKE_CURL

cat > "$fake_bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' npm >> "$HOME/calls.log"
printf '%s\n' "$*" > "$HOME/npm-args.log"
printf '%s\n' "${TEST_SECRET-unset}" > "$HOME/npm-secret.log"
prefix=''
while (( $# )); do
  if [[ "$1" == --prefix ]]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
[[ -n "$prefix" ]]
cp "$prefix/package-lock.json" "$HOME/npm-package-lock.json"
if [[ -f "$HOME/tamper-npm-package" ]]; then
  exit 1
fi
target="$prefix/node_modules/@oven/bun-linux-x64/bin"
mkdir -p "$target"
cp "$HOME/fixture-bun" "$target/bun"
chmod +x "$target/bun"
FAKE_NPM

chmod +x "$fake_bin/bun" "$fake_bin/uname" "$fake_bin/curl" "$fake_bin/npm"

export PATH="$fake_bin:/usr/bin:/bin"
export HOME="$test_home"
export CODEX_HOME="$test_home/.codex"
export CALL_LOG="$test_home/calls.log"
export FIXTURE_ARCHIVE="$archive"
cp "$fixture_root/bun-linux-x64/bun" "$test_home/fixture-bun"
export VISION_CLOUD_DISABLE_TIMEOUT=0
export VISION_CLOUD_BUN_VERSION=test-version
export VISION_CLOUD_BUN_CHECK_TIMEOUT=0.1s
export VISION_CLOUD_BUN_SHA_X64="$archive_sha"
export VISION_CLOUD_BUN_URL='https://example.invalid/bun.zip'
export VISION_CLOUD_BUN_NPM_INTEGRITY_X64='sha512-test-integrity'
export TEST_SECRET='must-not-reach-package-code'

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

rm "$CODEX_HOME/vision-cloud-bin/bun"
export CURL_FAIL=1
bash "$repo_root/.codex/cloud/install-bun.sh" >/dev/null
[[ "$(bun --version)" == test-version ]]
[[ "$(grep -c '^curl$' "$CALL_LOG")" -eq 2 ]]
[[ "$(grep -c '^npm$' "$CALL_LOG")" -eq 1 ]]
grep -Eq '^ci( |$)' "$HOME/npm-args.log"
grep -Fq -- '--registry=https://registry.npmjs.org' "$HOME/npm-args.log"
grep -Fq -- '--ignore-scripts' "$HOME/npm-args.log"
grep -Fq -- '"integrity": "sha512-test-integrity"' "$HOME/npm-package-lock.json"
grep -Fq -- '"resolved": "https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-test-version.tgz"' \
  "$HOME/npm-package-lock.json"
[[ "$(<"$HOME/npm-secret.log")" == unset ]]

rm "$CODEX_HOME/vision-cloud-bin/bun"
touch "$HOME/tamper-npm-package"
if bash "$repo_root/.codex/cloud/install-bun.sh" >/dev/null 2>&1; then
  printf '%s\n' 'FAIL: tampered npm package was accepted' >&2
  exit 1
fi
[[ ! -e "$CODEX_HOME/vision-cloud-bin/bun" ]]
[[ "$(grep -c '^npm$' "$CALL_LOG")" -eq 2 ]]

printf '%s\n' 'PASS: cloud Bun bootstrap tests'
