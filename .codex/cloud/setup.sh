#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"

install -d "$codex_home"
install -m 0644 "$script_dir/AGENTS.md" "$codex_home/AGENTS.md"
touch "$HOME/.bashrc"
grep -Fqx 'export CODEX_SESSION_ENV=cloud' "$HOME/.bashrc" || \
  printf '%s\n' 'export CODEX_SESSION_ENV=cloud' >> "$HOME/.bashrc"

command -v python3 >/dev/null || { printf '%s\n' 'Python 3 is required.' >&2; exit 1; }
command -v bun >/dev/null || { printf '%s\n' 'Bun is required.' >&2; exit 1; }

cd "$repo_root"
python3 -m venv venv
venv/bin/python -m pip install -r config/requirements.txt
bun install --frozen-lockfile

printf '%s\n' 'Vision cloud setup complete. Database and macOS checks require separate setup.'
