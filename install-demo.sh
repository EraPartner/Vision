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

# ── 1) Regenerate the synthetic dataset, then bake it into the demo DB image ──
# Keeps the demo data in sync with the current schema/features. Skip with
# SKIP_DEMO_DATA_REGEN=1 to just re-bake the existing demo-db/01-demo.sql.
if [ "${SKIP_DEMO_DATA_REGEN:-0}" != "1" ]; then
  echo "==> Regenerating synthetic dataset (demo-db/01-demo.sql) against the head schema..."
  "$ELECTRON_DIR/demo-db/regenerate.sh" || echo "    WARN: regen failed — baking the existing 01-demo.sql instead."
fi
echo "==> Building vision-demo-db:latest (synthetic data preloaded)..."
docker build -t vision-demo-db:latest "$ELECTRON_DIR/demo-db"

# ── 2) App image — ALWAYS rebuild from current source ─────────────────────────
# The demo compose uses pull_policy: never, so it serves this locally-built image.
# Rebuilding every run is what makes a re-run actually pick up your code changes
# (mirrors how the real install.sh app rebuilds from source on each launch).
echo "==> Building vision-app:latest from current source..."
docker compose -f "$REPO_PATH/docker-compose.yml" build app
docker image inspect vision-app:latest >/dev/null 2>&1 || { echo "ERROR: failed to produce vision-app:latest"; exit 1; }

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

# ── 5) Refresh a running demo stack so the new images + data take effect now ───
# A fresh volume makes the demo DB re-run initdb and reload 01-demo.sql. The
# embedded compose dir only exists once the app has been launched at least once;
# on a first install it isn't here yet, so the app creates the stack on launch.
DEMO_COMPOSE_DIR="$HOME/Library/Application Support/$APP_NAME/embedded_compose"
if [ -f "$DEMO_COMPOSE_DIR/docker-compose.yml" ]; then
  echo "==> Refreshing the running demo stack (new images + fresh synthetic data)..."
  ( cd "$DEMO_COMPOSE_DIR" && docker compose down -v --remove-orphans && docker compose up -d )
else
  echo "==> No existing demo stack yet — launch \"$APP_NAME.app\" to start it."
fi

echo ""
echo "  Vision Demo installed — synthetic data only; your real Vision.app is untouched."
echo "  Open it:   open \"$APP_DEST\""
echo "  It starts its own Docker stack (project visiondemoapp) on first launch."
