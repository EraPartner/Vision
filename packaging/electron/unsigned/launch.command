#!/bin/bash
set -euo pipefail

# launch.command - source-based launcher (double-click in Finder)
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$DIR/package.json" ]; then
  ROOT_DIR="$DIR"
else
  # Prefer an explicit 'Vision' folder next to the launcher
  if [ -d "$DIR/Vision" ] && [ -f "$DIR/Vision/package.json" ]; then
    ROOT_DIR="$DIR/Vision"
  else
    # Fallback: scan immediate subdirectories for a package.json and use the first match
    FOUND=""
    for d in "$DIR"/*; do
      if [ -d "$d" ] && [ -f "$d/package.json" ]; then
        FOUND="$d"
        break
      fi
    done
    if [ -n "$FOUND" ]; then
      ROOT_DIR="$FOUND"
    else
      osascript -e 'display dialog "Could not find the Vision source folder. Place this launch.command inside the Vision repository (or next to a Vision folder containing package.json)." buttons {"OK"} default button "OK"'
      exit 1
    fi
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  osascript -e 'display dialog "Bun was not found. Vision will install Bun automatically now." buttons {"OK"} default button "OK"'
  export BUN_INSTALL="$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

open -a Docker || true

cd "$ROOT_DIR"

# Ensure project deps are installed (root + packaging/electron) so the electron binary exists
if ! command -v bun >/dev/null 2>&1; then
  echo "bun missing unexpectedly; aborting"
  exit 1
fi

echo "Installing root dependencies (this may take a moment)..."
bun install || true

if [ ! -x "$ROOT_DIR/packaging/electron/node_modules/.bin/electron" ]; then
  echo "Installing packaging/electron dependencies..."
  (cd "$ROOT_DIR/packaging/electron" && bun install) || true
fi

exec bun run electron:prod
