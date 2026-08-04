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

if ! command -v bun >/dev/null 2>&1; then
  osascript -e "display dialog \"Bun was not found. Vision will install Bun $BUN_VERSION now.\" buttons {\"OK\"} default button \"OK\""
  export BUN_INSTALL="$HOME/.bun"
  # Install a PINNED version rather than whatever `latest` resolves to today.
  # This is still `curl | bash` — the installer script itself is fetched live
  # and executed, which is upstream's only supported install path — but the
  # payload it fetches is now fixed, so a user installing a year from now gets
  # the same toolchain this app was tested with instead of an untested one.
  # `-s bun-v<ver>` is the installer's documented version selector.
  if ! curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"; then
    osascript -e 'display dialog "Installing Bun failed. Install it manually from https://bun.sh and run this launcher again." buttons {"OK"} default button "OK"'
    exit 1
  fi
  export PATH="$BUN_INSTALL/bin:$PATH"

  # Assert rather than assume. The `-s bun-v<ver>` selector is upstream's
  # documented form, but this launcher cannot verify it at author time, so
  # check what actually landed: if the pin did not take, say so instead of
  # silently running an untested toolchain.
  INSTALLED_BUN="$(bun --version 2>/dev/null || echo unknown)"
  if [ "$INSTALLED_BUN" != "$BUN_VERSION" ]; then
    echo "WARNING: installed Bun $INSTALLED_BUN, expected $BUN_VERSION — continuing on an untested toolchain."
  fi
fi

open -a Docker || true

cd "$ROOT_DIR"

# Ensure project deps are installed (root + packaging/electron) so the electron binary exists
if ! command -v bun >/dev/null 2>&1; then
  echo "bun missing unexpectedly; aborting"
  exit 1
fi

# `|| true` used to swallow install failures here, so a partial dependency tree
# reached `electron:prod` and surfaced as a confusing runtime crash instead of
# the install error that caused it. Report the failure, but keep going: an
# offline relaunch with a complete node_modules from a previous run is a normal
# case and must still start.
echo "Installing root dependencies (this may take a moment)..."
if ! bun install --frozen-lockfile; then
  echo "WARNING: root dependency install failed — continuing with whatever is already installed."
fi

if [ ! -x "$ROOT_DIR/packaging/electron/node_modules/.bin/electron" ]; then
  echo "Installing packaging/electron dependencies..."
  if ! (cd "$ROOT_DIR/packaging/electron" && bun install --frozen-lockfile); then
    echo "WARNING: packaging/electron dependency install failed."
  fi
fi

# Whatever happened above, electron must exist before exec'ing the app —
# otherwise the failure shows up as an opaque crash rather than this message.
if [ ! -x "$ROOT_DIR/packaging/electron/node_modules/.bin/electron" ]; then
  osascript -e 'display dialog "Vision could not install its dependencies, so the app cannot start. Check your network connection and run this launcher again." buttons {"OK"} default button "OK"'
  echo "ERROR: packaging/electron/node_modules/.bin/electron is missing after install; aborting."
  exit 1
fi

exec bun run electron:prod
