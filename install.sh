#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
APP_DEST="/Applications/Vision.app"
CHROMIUM_VERSION="150.0.7871.24"

# shellcheck source=scripts/lib/mac-install.sh
source "$REPO_PATH/scripts/lib/mac-install.sh"

echo "==> Vision native application builder"
echo "    Repo: $REPO_PATH"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "ERROR: the native Vision application currently requires Apple Silicon macOS."
  exit 1
fi

for tool in bun node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool is required to build Vision.app from source."
    exit 1
  fi
done

if [ -n "${VISION_PYTHON_BIN:-}" ]; then
  PYTHON_BIN="$VISION_PYTHON_BIN"
else
  PYTHON_BIN="$(command -v python3 || true)"
fi
if [ -z "$PYTHON_BIN" ] || [ ! -x "$PYTHON_BIN" ]; then
  echo "ERROR: Python is required at build time for the standalone migration runner."
  exit 1
fi

if ! "$PYTHON_BIN" -c 'import alembic, dotenv, psycopg2, sqlalchemy, PyInstaller; assert alembic.__version__ == "1.19.1"; assert PyInstaller.__version__ == "6.22.2"' >/dev/null 2>&1; then
  cat <<EOF
ERROR: the pinned migration build dependencies are missing from:
  $PYTHON_BIN

Create a dedicated build environment, then rerun this script with it:
  python3 -m venv .venv-native-build
  .venv-native-build/bin/pip install --require-hashes -r config/requirements.txt
  .venv-native-build/bin/pip install PyInstaller==6.22.2
  VISION_PYTHON_BIN="$REPO_PATH/.venv-native-build/bin/python" ./install.sh
EOF
  exit 1
fi
export VISION_PYTHON_BIN="$PYTHON_BIN"

echo "==> Installing locked application dependencies..."
cd "$REPO_PATH"
bun install --frozen-lockfile --ignore-scripts
cd "$REPO_PATH/packaging/electron"
bun install --frozen-lockfile

PUPPETEER="$REPO_PATH/apps/node-backend/node_modules/.bin/puppeteer"
if [ ! -x "$PUPPETEER" ]; then
  echo "ERROR: the locked Puppeteer browser installer is missing after dependency installation."
  exit 1
fi

echo "==> Preparing pinned Chrome Headless Shell $CHROMIUM_VERSION..."
VISION_CHROMIUM_SOURCE="$($PUPPETEER browsers install \
  "chrome-headless-shell@$CHROMIUM_VERSION" --format '{{path}}')"
if [ ! -x "$VISION_CHROMIUM_SOURCE" ]; then
  echo "ERROR: the pinned Chrome Headless Shell executable was not produced."
  exit 1
fi
export VISION_CHROMIUM_SOURCE

echo "==> Building Vision's frontend and private native services..."
cd "$REPO_PATH"
bun run build
cd "$REPO_PATH/packaging/electron"
CSC_IDENTITY_AUTO_DISCOVERY=false \
  node scripts/build-native-package.js

APP_SRC="$(find_built_app \
  "$REPO_PATH/packaging/electron/dist/mac-arm64/Vision.app" \
  "$REPO_PATH/packaging/electron/dist/mac/Vision.app")" || {
  echo "ERROR: could not find the completed Vision.app."
  exit 1
}

install_app_bundle "$APP_SRC" "$APP_DEST"

echo ""
echo "  Vision installed successfully."
echo "  Open /Applications/Vision.app or run:"
echo "    open /Applications/Vision.app"
echo ""
echo "  Vision now starts its bundled PostgreSQL 18 service on loopback."
echo "  Docker and the Homebrew PostgreSQL service are not required."
