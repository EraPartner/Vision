#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
APP_DEST="/Applications/Vision.app"
CHROMIUM_VERSION="150.0.7871.24"

# shellcheck source=scripts/lib/mac-install.sh
source "$REPO_PATH/scripts/lib/mac-install.sh"
# shellcheck source=scripts/lib/native-mac-build.sh
source "$REPO_PATH/scripts/lib/native-mac-build.sh"
trap cleanup_native_macos_build EXIT

echo "==> Vision native application builder"
echo "    Repo: $REPO_PATH"

prepare_native_macos_build
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
