#!/usr/bin/env bash
set -euo pipefail

# Build Vision Native (apps/native/, ADR-204) in Release and install it to
# /Applications. Vision Native runs only against the synthetic Vision Demo data.

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
NATIVE_PATH="$REPO_PATH/apps/native"
APP_DEST="/Applications/Vision Native.app"
DERIVED_DATA="$NATIVE_PATH/build"
TEAM_ID="${VISION_NATIVE_TEAM_ID:-}"

# shellcheck source=scripts/lib/mac-install.sh
source "$REPO_PATH/scripts/lib/mac-install.sh"

echo "==> Vision Native builder"
echo "    Repo: $REPO_PATH"

for tool in xcodegen xcodebuild; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool is required (xcodegen: brew install xcodegen; xcodebuild: install Xcode)."
    exit 1
  fi
done

echo "==> Generating the Xcode project..."
xcodegen generate --spec "$NATIVE_PATH/project.yml"

if [ -n "$TEAM_ID" ]; then
  echo "==> Signing with personal team $TEAM_ID (automatic signing)."
  SIGNING_ARGS=(
    "DEVELOPMENT_TEAM=$TEAM_ID"
    "CODE_SIGN_STYLE=Automatic"
    -allowProvisioningUpdates
  )
else
  echo "WARNING: VISION_NATIVE_TEAM_ID is not set; signing ad-hoc."
  echo "         Ad-hoc signatures change on every build, so macOS may ask for"
  echo "         Keychain access again after each install (ADR-204, ADR-158)."
  SIGNING_ARGS=(
    "DEVELOPMENT_TEAM="
    "CODE_SIGN_STYLE=Manual"
    "CODE_SIGN_IDENTITY=-"
    "CODE_SIGNING_ALLOWED=YES"
  )
fi

echo "==> Building Vision Native (Release)..."
xcodebuild \
  -project "$NATIVE_PATH/VisionNative.xcodeproj" \
  -scheme "Vision Native" \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  "${SIGNING_ARGS[@]}" \
  build

APP_SRC="$(find_built_app \
  "$DERIVED_DATA/Build/Products/Release/Vision Native.app")" || {
  echo "ERROR: could not find the completed Vision Native.app."
  exit 1
}

# install_app_bundle quits a running copy, removes only "$APP_DEST" and copies
# the new bundle with ditto.
install_app_bundle "$APP_SRC" "$APP_DEST"

echo ""
echo "  Vision Native installed successfully."
echo "  Open it with:"
echo "    open \"$APP_DEST\""
echo ""
echo "  It connects to VISION_NATIVE_BACKEND_URL or to the running Vision Demo app."
