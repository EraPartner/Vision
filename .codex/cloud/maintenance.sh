#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
cloud_env="$codex_home/vision-cloud-test-db.env"

# shellcheck source=.codex/cloud/lib.sh
source "$script_dir/lib.sh"

export CODEX_SESSION_ENV=cloud

cd "$repo_root"
if [[ -f "$cloud_env" ]]; then
  bash "$script_dir/install-dependencies.sh"
  cloud_log 'Refreshing the existing native PostgreSQL test database.'
  bash "$script_dir/provision-test-db.sh"
else
  cloud_log 'Installing native PostgreSQL 18 packages before project dependencies.'
  bash "$script_dir/provision-test-db.sh" --install-packages-only
  bash "$script_dir/install-dependencies.sh"
  cloud_log 'Provisioning the native PostgreSQL 18 test database.'
  bash "$script_dir/provision-test-db.sh"
fi

cloud_log 'Vision cloud environment maintenance complete.'
