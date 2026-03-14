#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  osascript -e 'display dialog "Docker Desktop is required. Install/start Docker Desktop and try again." buttons {"OK"} default button "OK"'
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  osascript -e 'display dialog "Bun was not found. Vision will install Bun automatically now." buttons {"OK"} default button "OK"'
  export BUN_INSTALL="$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

open -a Docker || true

cd "$ROOT_DIR"
exec bun run electron:prod
