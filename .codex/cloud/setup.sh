#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"

export CODEX_SESSION_ENV=cloud

install -d "$codex_home"
install -m 0644 "$script_dir/AGENTS.md" "$codex_home/AGENTS.md"
touch "$HOME/.bashrc"
grep -Fqx 'export CODEX_SESSION_ENV=cloud' "$HOME/.bashrc" || \
  printf '%s\n' 'export CODEX_SESSION_ENV=cloud' >> "$HOME/.bashrc"

command -v python3 >/dev/null || { printf '%s\n' 'Python 3 is required.' >&2; exit 1; }
command -v bun >/dev/null || { printf '%s\n' 'Bun is required.' >&2; exit 1; }

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  command -v apt-get >/dev/null || {
    printf '%s\n' 'Docker is missing and apt-get is unavailable.' >&2
    exit 1
  }

  apt_get=(apt-get)
  if (( EUID != 0 )); then
    command -v sudo >/dev/null || {
      printf '%s\n' 'Docker installation requires root access or sudo.' >&2
      exit 1
    }
    apt_get=(sudo apt-get)
  fi

  "${apt_get[@]}" update
  "${apt_get[@]}" install -y docker.io docker-compose-v2
fi

docker --version
docker compose version

cd "$repo_root"
python3 -m venv venv
venv/bin/python -m pip install -r config/requirements.txt
PUPPETEER_SKIP_DOWNLOAD=true bun install --frozen-lockfile

printf '%s\n' \
  'Vision cloud setup complete. Docker daemon, database, and macOS checks require separate setup.'
