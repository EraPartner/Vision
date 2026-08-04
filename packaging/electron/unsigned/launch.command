#!/bin/bash
set -euo pipefail

# launch.command - source-based launcher (double-click in Finder)
DIR="$(cd "$(dirname "$0")" && pwd)"

# A candidate only counts if its package.json actually declares the Vision
# project. Without this the fallback scan below would take the alphabetically
# first sibling containing ANY package.json and `bun install` it — running that
# unrelated project's lifecycle scripts. Parsed with grep rather than jq/node/bun
# because none of them is guaranteed present on a stock Mac at this point (bun
# may still be about to be installed further down).
is_vision_project() {
  [ -f "$1/package.json" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"vision"' "$1/package.json"
}

if is_vision_project "$DIR"; then
  ROOT_DIR="$DIR"
else
  # Prefer an explicit 'Vision' folder next to the launcher
  if is_vision_project "$DIR/Vision"; then
    ROOT_DIR="$DIR/Vision"
  else
    # Fallback: scan immediate subdirectories for the Vision project
    FOUND=""
    for d in "$DIR"/*; do
      if [ -d "$d" ] && is_vision_project "$d"; then
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
