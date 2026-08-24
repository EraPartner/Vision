#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
cloud_env="$codex_home/vision-cloud-test-db.env"

# shellcheck source=.codex/cloud/lib.sh
source "$script_dir/lib.sh"

export CODEX_SESSION_ENV=cloud

install -d "$codex_home"
install -m 0644 "$script_dir/AGENTS.md" "$codex_home/AGENTS.md"
touch "$HOME/.bashrc"
grep -Fqx 'export CODEX_SESSION_ENV=cloud' "$HOME/.bashrc" || \
  printf '%s\n' 'export CODEX_SESSION_ENV=cloud' >> "$HOME/.bashrc"

command -v python3 >/dev/null || { printf '%s\n' 'Python 3 is required.' >&2; exit 1; }
command -v bun >/dev/null || { printf '%s\n' 'Bun is required.' >&2; exit 1; }

cd "$repo_root"
cloud_log 'Checking for an existing Docker daemon (8s deadline).'
if cloud_docker_daemon_available; then
  use_native_postgres=0
  cloud_log 'Docker daemon available; bun run test:db will use a disposable Postgres container.'
else
  use_native_postgres=1
  cloud_log 'No usable Docker daemon; installing native PostgreSQL 18 packages before project dependencies.'
  bash "$script_dir/provision-test-db.sh" --install-packages-only
fi

bash "$script_dir/install-dependencies.sh"

if (( use_native_postgres )); then
  cloud_log 'Provisioning the native PostgreSQL 18 test database.'
  bash "$script_dir/provision-test-db.sh"
fi

if [[ -f "$cloud_env" ]]; then
  cloud_log "Native test database environment persisted at $cloud_env."
fi

cloud_log 'Vision cloud setup complete. macOS-only checks still require a local session.'
