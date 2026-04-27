#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
APP_DEST="/Applications/Vision.app"
USERDATA="$HOME/Library/Application Support/Vision"
SETTINGS="$USERDATA/settings.json"

echo "==> Vision installer"
echo "    Repo: $REPO_PATH"

# ── Homebrew ──────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "==> Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
fi

# ── Docker Desktop ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker Desktop..."
  brew install --cask docker
  echo ""
  echo "  Docker Desktop installed. Please:"
  echo "  1. Open Docker from Applications"
  echo "  2. Complete the setup wizard"
  echo "  3. Re-run this script once Docker is running"
  echo ""
  open -a Docker || true
  exit 1
fi

# Check Docker daemon is actually running
if ! docker info &>/dev/null 2>&1; then
  echo "==> Docker is installed but not running. Starting Docker Desktop..."
  open -a Docker
  echo "    Waiting for Docker daemon..."
  for i in $(seq 1 30); do
    sleep 2
    if docker info &>/dev/null 2>&1; then
      echo "    Docker is ready."
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "ERROR: Docker did not start in time. Please start Docker Desktop manually and re-run."
      exit 1
    fi
  done
fi

# ── Bun ───────────────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "==> Installing Bun..."
  brew install bun
fi

# ── Electron dependencies ─────────────────────────────────────────────────────
echo "==> Installing Electron dependencies..."
cd "$REPO_PATH/packaging/electron"
bun install

# ── Build .app ────────────────────────────────────────────────────────────────
echo "==> Building Vision.app (this takes a minute)..."
bun run dist

# Find the built .app (arm64 or x64)
APP_SRC=""
for candidate in \
  "$REPO_PATH/packaging/electron/dist/mac-arm64/Vision.app" \
  "$REPO_PATH/packaging/electron/dist/mac/Vision.app" \
  "$REPO_PATH/packaging/electron/dist/mac-x64/Vision.app"; do
  if [ -d "$candidate" ]; then
    APP_SRC="$candidate"
    break
  fi
done

if [ -z "$APP_SRC" ]; then
  echo "ERROR: Could not find built Vision.app in packaging/electron/dist/"
  exit 1
fi

# ── Install to /Applications ──────────────────────────────────────────────────
echo "==> Installing to $APP_DEST..."
if [ -d "$APP_DEST" ]; then
  rm -rf "$APP_DEST"
fi
cp -r "$APP_SRC" "$APP_DEST"

# Remove quarantine flag so Gatekeeper doesn't block the self-built app
xattr -cr "$APP_DEST" 2>/dev/null || true

# ── Write repoPath to Vision settings ────────────────────────────────────────
# Tells the packaged app to build from local source instead of pulling GHCR image.
echo "==> Configuring Vision to use local repo..."
mkdir -p "$USERDATA"

if [ -f "$SETTINGS" ]; then
  # Merge repoPath into existing settings
  node -e "
    const fs = require('fs');
    const p = process.argv[1];
    let s = {};
    try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    s.repoPath = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  " "$SETTINGS" "$REPO_PATH"
else
  printf '{\n  "repoPath": "%s"\n}\n' "$REPO_PATH" > "$SETTINGS"
fi

echo ""
echo "  Vision installed successfully!"
echo "  Open /Applications/Vision.app or run:"
echo "    open $APP_DEST"
echo ""
echo "  First launch will build the Docker image — takes a few minutes."
