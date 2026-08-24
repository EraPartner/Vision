#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
bin_dir="$codex_home/vision-cloud-bin"
toolchain_env="$codex_home/vision-cloud-toolchain.env"
bun_bin="$bin_dir/bun"
bun_version="${VISION_CLOUD_BUN_VERSION:-1.3.14}"
bun_check_timeout="${VISION_CLOUD_BUN_CHECK_TIMEOUT:-10s}"

# shellcheck source=.codex/cloud/lib.sh
source "$script_dir/lib.sh"

command -v python3 >/dev/null || {
  printf '%s\n' 'Python 3 is required to extract the pinned Bun runtime.' >&2
  exit 1
}
command -v curl >/dev/null || {
  printf '%s\n' 'curl is required to download the pinned Bun runtime.' >&2
  exit 1
}

write_toolchain_env() {
  install -d -m 0700 "$codex_home" "$bin_dir"
  umask 077
  # Keep $PATH literal so it expands when a later shell sources this file.
  # shellcheck disable=SC2016
  printf 'export PATH=%q:$PATH\n' "$bin_dir" > "$toolchain_env"
  chmod 0644 "$toolchain_env"

  touch "$HOME/.bashrc"
  local source_line="source '$toolchain_env'"
  grep -Fqx "$source_line" "$HOME/.bashrc" || printf '%s\n' "$source_line" >> "$HOME/.bashrc"
}

runtime_version=''
if [[ -x "$bun_bin" ]]; then
  runtime_version="$(cloud_run_package_with_timeout "$bun_check_timeout" "$bun_bin" --version 2>/dev/null || true)"
  if [[ "$runtime_version" == "$bun_version" ]]; then
    write_toolchain_env
    cloud_log "SKIP: Pinned Bun $bun_version is already installed."
    exit 0
  fi
fi

existing_bun="$(command -v bun || true)"
if [[ -n "$existing_bun" ]]; then
  cloud_log "START: Check existing Bun runtime ($bun_check_timeout deadline)."
  runtime_version="$(cloud_run_package_with_timeout "$bun_check_timeout" "$existing_bun" --version 2>/dev/null || true)"
  if [[ "$runtime_version" == "$bun_version" ]]; then
    cloud_log "DONE: Existing Bun $bun_version is usable."
    exit 0
  fi
  if [[ -n "$runtime_version" ]]; then
    cloud_log "Existing Bun is $runtime_version; installing pinned Bun $bun_version."
  else
    cloud_log "Existing Bun did not respond in time; installing pinned Bun $bun_version."
  fi
fi

case "$(uname -m)" in
  x86_64 | amd64)
    bun_arch=x64
    bun_sha="${VISION_CLOUD_BUN_SHA_X64:-951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f}"
    ;;
  aarch64 | arm64)
    bun_arch=aarch64
    bun_sha="${VISION_CLOUD_BUN_SHA_ARM64:-a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b}"
    ;;
  *)
    printf 'Unsupported Bun architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

bun_url="${VISION_CLOUD_BUN_URL:-https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/bun-linux-${bun_arch}.zip}"
temporary="$(mktemp -d)"
cleanup() {
  rm -rf "$temporary"
}
trap cleanup EXIT

archive="$temporary/bun.zip"
extract_dir="$temporary/extracted"
cloud_run_step "Download pinned Bun $bun_version" \
  cloud_run_with_heartbeat 120s 30s "Bun $bun_version download" \
    curl -fsSL \
      --connect-timeout 15 \
      --max-time 110 \
      --retry 3 \
      --retry-all-errors \
      "$bun_url" \
      -o "$archive"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$archive" | awk '{ print $1 }')"
else
  actual_sha="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
fi
if [[ "$actual_sha" != "$bun_sha" ]]; then
  printf 'Pinned Bun archive checksum mismatch: expected %s, got %s.\n' \
    "$bun_sha" "$actual_sha" >&2
  exit 1
fi

install -d -m 0700 "$extract_dir" "$bin_dir"
cloud_run_step "Extract pinned Bun $bun_version" \
  cloud_run_with_timeout 30s python3 -m zipfile -e "$archive" "$extract_dir"
install -m 0755 "$extract_dir/bun-linux-${bun_arch}/bun" "$bun_bin"

runtime_version="$(cloud_run_package_with_timeout 15s "$bun_bin" --version)"
if [[ "$runtime_version" != "$bun_version" ]]; then
  printf 'Pinned Bun verification failed: expected %s, got %s.\n' \
    "$bun_version" "$runtime_version" >&2
  exit 1
fi

write_toolchain_env
cloud_log "Pinned Bun $bun_version is ready at $bun_bin."
