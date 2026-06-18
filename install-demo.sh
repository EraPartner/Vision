#!/usr/bin/env bash
# Build & install "Vision Demo.app" — a full Electron build of Vision running on
# synthetic data only, fully isolated from your real Vision.app (separate userData,
# separate Docker project `visiondemoapp`, separate volumes, local images only).
# Mirrors ./install.sh. Does NOT set repoPath, so the demo runs in embedded mode.
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$REPO_PATH/packaging/electron"
APP_NAME="Vision Demo"
APP_DEST="/Applications/$APP_NAME.app"

echo "==> Vision Demo installer"
echo "    Repo: $REPO_PATH"

# ── Preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker not found. Install Docker Desktop first."; exit 1; }
if ! docker info >/dev/null 2>&1; then
  echo "==> Docker not running. Starting Docker Desktop..."
  open -a Docker || true
  for i in $(seq 1 30); do sleep 2; docker info >/dev/null 2>&1 && break; [ "$i" -eq 30 ] && { echo "ERROR: Docker did not start."; exit 1; }; done
fi
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found (brew install bun)."; exit 1; }

# ── 1) Demo DB image (postgres + synthetic data baked in) ────────────────────
echo "==> Building vision-demo-db:latest (synthetic data preloaded)..."
docker build -t vision-demo-db:latest "$ELECTRON_DIR/demo-db"

# ── 2) Ensure the app image exists locally (demo compose uses pull_policy: never)
if ! docker image inspect vision-app:latest >/dev/null 2>&1; then
  echo "==> vision-app:latest not found; building from repo (one-time)..."
  docker compose -f "$REPO_PATH/docker-compose.yml" build app
  docker image inspect vision-app:latest >/dev/null 2>&1 || { echo "ERROR: failed to produce vision-app:latest"; exit 1; }
fi

# ── 3) Build Vision Demo.app ─────────────────────────────────────────────────
echo "==> Installing Electron deps..."
cd "$ELECTRON_DIR"
bun install
echo "==> Generating locales..."
GENERATE_LOCALES_AST=1 node ../../scripts/generate-locales.js
echo "==> Building $APP_NAME.app (takes a couple of minutes)..."
./node_modules/.bin/electron-builder --config electron-builder-demo.json --mac --arm64

# ── 4) Locate + install to /Applications ─────────────────────────────────────
APP_SRC=""
for c in "$ELECTRON_DIR/dist-demo/mac-arm64/$APP_NAME.app" "$ELECTRON_DIR/dist-demo/mac/$APP_NAME.app"; do
  [ -d "$c" ] && { APP_SRC="$c"; break; }
done
[ -n "$APP_SRC" ] || { echo "ERROR: built app not found under $ELECTRON_DIR/dist-demo/"; exit 1; }

echo "==> Installing to $APP_DEST..."
[ -d "$APP_DEST" ] && rm -rf "$APP_DEST"
cp -r "$APP_SRC" "$APP_DEST"
xattr -cr "$APP_DEST" 2>/dev/null || true
# electron-builder skips signing (identity:null); arm64 needs at least an ad-hoc
# signature or macOS refuses to launch it. Sign locally.
codesign --force --deep -s - "$APP_DEST" 2>/dev/null || true

echo ""
echo "  Vision Demo installed — synthetic data only; your real Vision.app is untouched."
echo "  Open it:   open \"$APP_DEST\""
echo "  It starts its own Docker stack (project visiondemoapp) on first launch."
