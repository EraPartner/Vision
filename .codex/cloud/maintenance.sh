#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

export CODEX_SESSION_ENV=cloud

cd "$repo_root"
python3 -m venv venv
venv/bin/python -m pip install -r config/requirements.txt
PUPPETEER_SKIP_DOWNLOAD=true bun install --frozen-lockfile

if ! docker info >/dev/null 2>&1; then
  bash "$script_dir/provision-test-db.sh"
fi

printf '%s\n' 'Vision cloud environment maintenance complete.'
