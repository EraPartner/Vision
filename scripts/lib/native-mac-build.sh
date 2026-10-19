#!/usr/bin/env bash
# Shared native payload prerequisites for Vision.app and Vision Demo.app.
# Source after REPO_PATH and CHROMIUM_VERSION are set.

VISION_NATIVE_BUILD_TEMP_ROOT=""

cleanup_native_macos_build() {
  local build_root="${VISION_NATIVE_BUILD_TEMP_ROOT:-}"
  [ -n "$build_root" ] || return 0

  local temp_base="${TMPDIR:-/tmp}"
  temp_base="${temp_base%/}"
  case "$build_root" in
    "$temp_base"/vision-native-build-*)
      rm -rf -- "$build_root"
      ;;
    *)
      echo "WARN: refusing to remove unexpected native build directory: $build_root" >&2
      ;;
  esac
  VISION_NATIVE_BUILD_TEMP_ROOT=""
  unset VISION_FRONTEND_DIST
}

prepare_native_macos_build() {
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "ERROR: the native Vision application currently requires Apple Silicon macOS."
    return 1
  fi

  local tool
  for tool in bun node; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: $tool is required to build Vision from source."
      return 1
    fi
  done

  echo "==> Installing locked application dependencies..."
  cd "$REPO_PATH" || return 1
  bun install --frozen-lockfile --ignore-scripts
  cd "$REPO_PATH/packaging/electron" || return 1
  bun install --frozen-lockfile

  local puppeteer="$REPO_PATH/apps/node-backend/node_modules/.bin/puppeteer"
  if [ ! -x "$puppeteer" ]; then
    echo "ERROR: the locked Puppeteer browser installer is missing after dependency installation."
    return 1
  fi

  echo "==> Preparing pinned Chrome Headless Shell $CHROMIUM_VERSION..."
  VISION_CHROMIUM_SOURCE="$($puppeteer browsers install \
    "chrome-headless-shell@$CHROMIUM_VERSION" --format '{{path}}')"
  if [ ! -x "$VISION_CHROMIUM_SOURCE" ]; then
    echo "ERROR: the pinned Chrome Headless Shell executable was not produced."
    return 1
  fi
  export VISION_CHROMIUM_SOURCE

  echo "==> Building Vision's frontend in an isolated staging directory..."
  local temp_base="${TMPDIR:-/tmp}"
  temp_base="${temp_base%/}"
  VISION_NATIVE_BUILD_TEMP_ROOT="$(
    mktemp -d "$temp_base/vision-native-build-XXXXXX"
  )"
  VISION_FRONTEND_DIST="$VISION_NATIVE_BUILD_TEMP_ROOT/frontend-dist"
  export VISION_FRONTEND_DIST

  cd "$REPO_PATH" || return 1
  bun scripts/generate-locales.ts
  cd "$REPO_PATH/apps/frontend" || return 1
  "$REPO_PATH/apps/frontend/node_modules/.bin/vite" build \
    --outDir "$VISION_FRONTEND_DIST" \
    --emptyOutDir
}
