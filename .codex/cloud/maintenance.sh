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
bash "$script_dir/install-dependencies.sh"

if [[ -f "$cloud_env" ]]; then
  cloud_log 'Refreshing the existing native PostgreSQL test database.'
  bash "$script_dir/provision-test-db.sh"
else
  cloud_log 'Checking for an existing Docker daemon (8s deadline).'
  if cloud_docker_daemon_available; then
    cloud_log 'Docker daemon available; no native database maintenance is required.'
  else
    cloud_log 'No usable Docker daemon; provisioning native PostgreSQL 18.'
    bash "$script_dir/provision-test-db.sh"
  fi
fi

cloud_log 'Vision cloud environment maintenance complete.'
