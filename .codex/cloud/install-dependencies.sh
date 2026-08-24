#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${VISION_CLOUD_REPO_ROOT:-$(cd "$script_dir/../.." && pwd)}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
state_dir="$codex_home/vision-cloud-state"

# shellcheck source=.codex/cloud/lib.sh
source "$script_dir/lib.sh"

install -d -m 0700 "$state_dir"
cd "$repo_root"

bash "$script_dir/install-bun.sh"
toolchain_env="$codex_home/vision-cloud-toolchain.env"
if [[ -f "$toolchain_env" ]]; then
  # shellcheck disable=SC1090
  source "$toolchain_env"
fi

python_fingerprint="$({
  python3 --version
  cloud_fingerprint 2 config/requirements.in config/requirements.txt
} | cloud_hash_stream)"
python_marker="$state_dir/python-dependencies.sha256"

if cloud_marker_matches "$python_marker" "$python_fingerprint" &&
  [[ -x venv/bin/alembic ]]; then
  cloud_log 'SKIP: Python dependencies are unchanged.'
else
  cloud_run_step 'Create Python virtual environment' \
    cloud_run_with_timeout 60s python3 -m venv venv
  cloud_run_step 'Install Python dependencies' \
    cloud_run_package_with_timeout 600s env \
      PIP_DISABLE_PIP_VERSION_CHECK=1 \
      PIP_DEFAULT_TIMEOUT=30 \
      PIP_RETRIES=3 \
      venv/bin/python -m pip install --no-input --require-hashes \
        --only-binary=psycopg2-binary \
        -r config/requirements.txt
  cloud_write_marker "$python_marker" "$python_fingerprint"
fi

cloud_log 'START: Resolve Bun dependency fingerprint.'
bun_version="$(cloud_run_package_with_timeout 15s bun --version)"
bun_fingerprint="$({
  printf '%s\n' "$bun_version"
  cloud_fingerprint 1 \
    bun.lock \
    apps/node-backend/bun.lock \
    package.json \
    apps/frontend/package.json \
    apps/node-backend/package.json \
    packages/shared-utils/package.json \
    packages/types/package.json
} | cloud_hash_stream)"
cloud_log 'DONE: Resolve Bun dependency fingerprint.'
bun_marker="$state_dir/bun-dependencies.sha256"

if cloud_marker_matches "$bun_marker" "$bun_fingerprint" &&
  [[ -d node_modules/.bun ]]; then
  cloud_log 'SKIP: Bun workspace dependencies are unchanged.'
else
  # The root prepare hook installs the complete Electron development toolchain.
  # Cloud cannot package macOS builds, and the backend workspace already owns
  # archiver/yauzl for its backup round-trip tests, so suppress that hook here.
  cloud_run_step 'Install Bun workspace dependencies' \
    cloud_run_package_with_heartbeat 420s 30s 'Bun workspace dependency installation' env \
      PUPPETEER_SKIP_DOWNLOAD=true \
      bun install --frozen-lockfile --ignore-scripts --no-progress
  cloud_write_marker "$bun_marker" "$bun_fingerprint"
fi
