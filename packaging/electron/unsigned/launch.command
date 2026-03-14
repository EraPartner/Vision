#!/bin/bash
set -euo pipefail

# launch.command - source-based launcher (double-click in Finder)
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -d "$DIR/.git" ] && [ -f "$DIR/package.json" ]; then
  ROOT_DIR="$DIR"
elif [ -d "$DIR/Vision/.git" ] && [ -f "$DIR/Vision/package.json" ]; then
  ROOT_DIR="$DIR/Vision"
else
  osascript -e 'display dialog "Could not find the Vision source folder. Place this launch.command inside the Vision repository (or next to a Vision folder)." buttons {"OK"} default button "OK"'
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
