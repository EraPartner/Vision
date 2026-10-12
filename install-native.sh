#!/usr/bin/env bash
set -euo pipefail

# Build Vision Native (apps/native/, ADR-204) in Release, stage its runtime payload
# (PostgreSQL 18, the compiled backend, Alembic, Chrome Headless Shell and the
# synthetic Demo seed) into the app, and install it to /Applications. Vision Native
# runs only on synthetic Demo data in its own application-data directory.
#
# VISION_NATIVE_VARIANT picks the build (phase 1e):
#   demo (default) -> /Applications/Vision Native Demo.app, data in
#                     ~/Library/Application Support/Vision Native Demo, PostgreSQL 54332
#   standard       -> /Applications/Vision Native.app, data in
#                     ~/Library/Application Support/Vision Native, PostgreSQL 54331
#
# VISION_NATIVE_SKIP_PAYLOAD=1 builds without a payload (the app then explains how to
# provide one). The payload uses the same prepare scripts as install-demo.sh.

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
NATIVE_PATH="$REPO_PATH/apps/native"
ELECTRON_DIR="$REPO_PATH/packaging/electron"
VARIANT="${VISION_NATIVE_VARIANT:-demo}"
case "$VARIANT" in
  demo) APP_NAME="Vision Native Demo" ;;
  standard) APP_NAME="Vision Native" ;;
  *)
    echo "ERROR: VISION_NATIVE_VARIANT must be demo or standard (got: $VARIANT)."
    exit 1
    ;;
esac
APP_DEST="/Applications/$APP_NAME.app"
DERIVED_DATA="$NATIVE_PATH/build"
PAYLOAD_DIR="$NATIVE_PATH/build/payload"
LOCAL_XCCONFIG="$NATIVE_PATH/Config/Local.xcconfig"
CHROMIUM_VERSION="150.0.7871.24"
VISION_INSTALLER_COMMAND="./install-native.sh"
export VISION_INSTALLER_COMMAND
TEAM_ID="${VISION_NATIVE_TEAM_ID:-}"

# shellcheck source=scripts/lib/mac-install.sh
source "$REPO_PATH/scripts/lib/mac-install.sh"

echo "==> Vision Native builder"
echo "    Repo: $REPO_PATH"
echo "    Variant: $VARIANT ($APP_NAME)"

# The documented Local.xcconfig line `VISION_NATIVE_TEAM_ID = <id>` must win over the
# ad-hoc fallback below, which would otherwise override it on the command line.
if [ -z "$TEAM_ID" ] && [ -f "$LOCAL_XCCONFIG" ]; then
  TEAM_ID="$(sed -n 's/^[[:space:]]*VISION_NATIVE_TEAM_ID[[:space:]]*=[[:space:]]*\([A-Za-z0-9]*\)[[:space:]]*$/\1/p' "$LOCAL_XCCONFIG" | head -n 1)"
  if [ -n "$TEAM_ID" ]; then
    echo "==> Using VISION_NATIVE_TEAM_ID from $LOCAL_XCCONFIG"
  fi
fi

for tool in xcodegen xcodebuild; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool is required (xcodegen: brew install xcodegen; xcodebuild: install Xcode)."
    exit 1
  fi
done

STAGE_PAYLOAD=0
PAYLOAD_ARGS=()
if [ "${VISION_NATIVE_SKIP_PAYLOAD:-}" = "1" ]; then
  echo "WARNING: VISION_NATIVE_SKIP_PAYLOAD=1; building without the runtime payload."
else
  # shellcheck source=scripts/lib/native-mac-build.sh
  source "$REPO_PATH/scripts/lib/native-mac-build.sh"
  trap cleanup_native_macos_build EXIT

  # Dependencies, the pinned Chrome Headless Shell and the frontend build, exactly as
  # install-demo.sh prepares them.
  prepare_native_macos_build

  echo "==> Preparing the native runtime payload..."
  mkdir -p "$PAYLOAD_DIR"
  cd "$ELECTRON_DIR"
  bun build.ts
  VISION_NATIVE_RUNTIME_DESTINATION="$PAYLOAD_DIR/native-runtime" \
    node out/scripts/prepare-native-runtime.js

  echo "==> Building the synthetic Demo seed..."
  VISION_NATIVE_PAYLOAD_ROOT="$PAYLOAD_DIR/native-runtime" \
    node out/scripts/build-demo-seed.js
  rm -rf "$PAYLOAD_DIR/demo-seed"
  ditto "$ELECTRON_DIR/demo-seed" "$PAYLOAD_DIR/demo-seed"
  cd "$REPO_PATH"

  STAGE_PAYLOAD=1
  PAYLOAD_ARGS=("VISION_NATIVE_PAYLOAD_DIR=$PAYLOAD_DIR")
fi

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

echo "==> Building $APP_NAME (Release)..."
xcodebuild \
  -project "$NATIVE_PATH/VisionNative.xcodeproj" \
  -scheme "Vision Native" \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  "VISION_NATIVE_VARIANT=$VARIANT" \
  "${SIGNING_ARGS[@]}" \
  ${PAYLOAD_ARGS[@]+"${PAYLOAD_ARGS[@]}"} \
  build

APP_SRC="$(find_built_app \
  "$DERIVED_DATA/Build/Products/Release/$APP_NAME.app")" || {
  echo "ERROR: could not find the completed $APP_NAME.app."
  exit 1
}

if [ "$STAGE_PAYLOAD" = "1" ]; then
  for staged in runtime/manifest.json demo-seed/manifest.json demo-seed/demo-seed.dump; do
    if [ ! -f "$APP_SRC/Contents/Resources/$staged" ]; then
      echo "ERROR: the built app is missing Contents/Resources/$staged."
      exit 1
    fi
  done
  if ! codesign --verify --strict "$APP_SRC"; then
    echo "ERROR: the built app's signature does not verify after staging the payload."
    exit 1
  fi
fi

# install_app_bundle quits a running copy, removes only "$APP_DEST" and copies
# the new bundle with ditto.
install_app_bundle "$APP_SRC" "$APP_DEST"

echo ""
echo "  $APP_NAME installed successfully."
echo "  Open it with:"
echo "    open \"$APP_DEST\""
echo ""
echo "  It starts its own PostgreSQL 18 cluster and backend on synthetic Demo data in"
echo "  ~/Library/Application Support/$APP_NAME/. Your Vision and Vision Demo data are untouched."
if [ "$VARIANT" = "demo" ]; then
  echo "  Reset its synthetic dataset with: bun run demo:reset-vision-native (then reopen it)."
fi
