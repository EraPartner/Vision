#!/usr/bin/env bash
# Build and install Vision Demo.app with a private native PostgreSQL runtime and
# deterministic synthetic data. It never opens the real Vision data directory.
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$REPO_PATH/packaging/electron"
APP_NAME="Vision Demo"
APP_DEST="/Applications/$APP_NAME.app"
CHROMIUM_VERSION="150.0.7871.24"
VISION_INSTALLER_COMMAND="./install-demo.sh"
export VISION_INSTALLER_COMMAND

# shellcheck source=scripts/lib/mac-install.sh
source "$REPO_PATH/scripts/lib/mac-install.sh"
# shellcheck source=scripts/lib/native-mac-build.sh
source "$REPO_PATH/scripts/lib/native-mac-build.sh"
trap cleanup_native_macos_build EXIT

echo "==> Vision Demo native installer"
echo "    Repo: $REPO_PATH"

prepare_native_macos_build

echo "==> Building $APP_NAME.app with deterministic synthetic data..."
cd "$ELECTRON_DIR"
CSC_IDENTITY_AUTO_DISCOVERY=false \
  node scripts/build-native-package.js --demo

APP_SRC="$(find_built_app \
  "$ELECTRON_DIR/dist-demo/mac-arm64/$APP_NAME.app" \
  "$ELECTRON_DIR/dist-demo/mac/$APP_NAME.app")" || {
  echo "ERROR: built app not found under $ELECTRON_DIR/dist-demo/."
  exit 1
}

install_app_bundle "$APP_SRC" "$APP_DEST"

echo ""
echo "  Vision Demo installed with synthetic data only."
echo "  Open it: open \"$APP_DEST\""
echo "  It uses its own bundled PostgreSQL 18 runtime; Docker is not required."
echo "  Your real Vision database and attachments are untouched."
