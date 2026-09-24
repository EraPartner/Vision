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

# Bun version this project is built and tested against. Keep in step with
# .github/actions/setup/action.yml's bun-version default.
BUN_VERSION="1.3.14"
if ! command -v bun >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  osascript -e "display dialog \"Vision requires Bun $BUN_VERSION. Install that version from the official Bun release and run this launcher again.\" buttons {\"OK\"} default button \"OK\""
  exit 1
fi

INSTALLED_BUN="$(bun --version 2>/dev/null || echo unknown)"
if [ "$INSTALLED_BUN" != "$BUN_VERSION" ]; then
  osascript -e "display dialog \"Vision requires Bun $BUN_VERSION, but found $INSTALLED_BUN. Install the required version and run this launcher again.\" buttons {\"OK\"} default button \"OK\""
  exit 1
fi

cd "$ROOT_DIR"

# Ensure project deps are installed (root + packaging/electron) so the electron binary exists
if ! command -v bun >/dev/null 2>&1; then
  echo "bun missing unexpectedly; aborting"
  exit 1
fi

echo "Installing root dependencies (this may take a moment)..."
if ! bun install --frozen-lockfile --ignore-scripts; then
  echo "ERROR: root dependency install failed; Vision will not launch." >&2
  exit 1
fi

echo "Installing packaging/electron dependencies..."
if ! (cd "$ROOT_DIR/packaging/electron" && bun install --frozen-lockfile --ignore-scripts); then
  echo "ERROR: Electron dependency install failed; Vision will not launch." >&2
  exit 1
fi

# Bun skips all install hooks above. Electron's known, pinned installer is run
# explicitly only when its binary is absent; it checks the upstream download.
if [ ! -x "$ROOT_DIR/packaging/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  if ! bun "$ROOT_DIR/packaging/electron/node_modules/electron/install.js"; then
    echo "ERROR: the pinned Electron binary could not be installed." >&2
    exit 1
  fi
fi

# Whatever happened above, electron must exist before exec'ing the app —
# otherwise the failure shows up as an opaque crash rather than this message.
if [ ! -x "$ROOT_DIR/packaging/electron/node_modules/.bin/electron" ]; then
  osascript -e 'display dialog "Vision could not install its dependencies, so the app cannot start. Check your network connection and run this launcher again." buttons {"OK"} default button "OK"'
  echo "ERROR: packaging/electron/node_modules/.bin/electron is missing after install; aborting."
  exit 1
fi

# The source launcher keeps its generated native services outside release ZIPs.
# Prepare them on first use or after an explicit local cleanup. This validates
# PostgreSQL 18.6, creates the standalone Alembic executable, and installs the
# pinned Chrome Headless Shell used for PDF reports. It never starts Homebrew's
# PostgreSQL service; the application uses its bundled native runtime.
if [ ! -x "$ROOT_DIR/packaging/electron/native-runtime/vision-alembic" ] ||
   [ ! -f "$ROOT_DIR/packaging/electron/native-runtime/postgres/runtime.json" ] ||
   [ ! -f "$ROOT_DIR/packaging/electron/native-runtime/chromium/runtime.json" ]; then
  echo "Preparing Vision's private native services..."
  if ! bun run native:prepare; then
    osascript -e 'display dialog "Vision could not prepare its native PostgreSQL, migration, and PDF services. Review the Terminal output and the native macOS setup guide, then run the launcher again." buttons {"OK"} default button "OK"'
    exit 1
  fi
fi

exec bun run electron:prod
