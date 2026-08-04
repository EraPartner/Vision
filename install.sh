#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(cd "$(dirname "$0")" && pwd)"
APP_DEST="/Applications/Vision.app"
USERDATA="$HOME/Library/Application Support/Vision"
SETTINGS="$USERDATA/settings.json"

# shellcheck source=scripts/lib/mac-install.sh
source "$REPO_PATH/scripts/lib/mac-install.sh"

echo "==> Vision installer"
echo "    Repo: $REPO_PATH"

# ── Homebrew ──────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  cat <<'EOF'
==> Homebrew is not installed.

This installer can run the official Homebrew installation script from:
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh

For maximum security you should review that script before executing it.
The Vision installer will NOT pipe an unverified script straight into bash.

Recommended:
  1. Install Homebrew yourself by following the instructions at https://brew.sh
  2. Re-run this installer.

Or, if you understand the risk and accept it, set the environment variable
VISION_ALLOW_BREW_PIPE=1 before re-running:

    VISION_ALLOW_BREW_PIPE=1 ./install.sh
EOF
  if [ "${VISION_ALLOW_BREW_PIPE:-0}" != "1" ]; then
    exit 1
  fi
  echo "==> VISION_ALLOW_BREW_PIPE=1 set — installing Homebrew via official script."
  BREW_INSTALL_TMP="$(mktemp -t vision_brew_install.XXXXXX)"
  trap 'rm -f "$BREW_INSTALL_TMP"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 \
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
    -o "$BREW_INSTALL_TMP"
  ACTUAL_SHA="$(shasum -a 256 "$BREW_INSTALL_TMP" | awk '{print $1}')"
  echo "    Downloaded Homebrew installer to: $BREW_INSTALL_TMP"
  echo "    SHA-256: $ACTUAL_SHA"
  if [ "${VISION_BREW_INSTALL_SHA256:-}" != "" ]; then
    EXPECTED="${VISION_BREW_INSTALL_SHA256}"
    if [ "$EXPECTED" != "$ACTUAL_SHA" ]; then
      echo "ERROR: Homebrew installer checksum mismatch."
      echo "  expected: $EXPECTED"
      echo "  actual:   $ACTUAL_SHA"
      exit 1
    fi
    echo "    Checksum verified."
  elif [ "${VISION_BREW_INSTALL_AUTO_CONFIRM:-0}" = "1" ]; then
    echo "    VISION_BREW_INSTALL_AUTO_CONFIRM=1 — skipping interactive confirmation."
  else
    echo ""
    echo "    No VISION_BREW_INSTALL_SHA256 was provided to verify the download."
    echo "    Compare the SHA-256 above against the published value before continuing."
    echo "    See: https://github.com/Homebrew/install"
    echo ""
    printf "    Continue and execute this installer? [y/N] "
    read -r confirm </dev/tty
    case "$confirm" in
      y|Y|yes|YES) ;;
      *)
        echo "    Aborted by user."
        exit 1
        ;;
    esac
  fi
  /bin/bash "$BREW_INSTALL_TMP"
  rm -f "$BREW_INSTALL_TMP"
  trap - EXIT
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
  if wait_for_docker_daemon; then
    echo "    Docker is ready."
  else
    echo "ERROR: Docker did not start in time. Please start Docker Desktop manually and re-run."
    exit 1
  fi
fi

# ── Bun ───────────────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "==> Installing Bun..."
  brew install bun
fi

# ── Electron dependencies ─────────────────────────────────────────────────────
echo "==> Installing Electron dependencies..."
cd "$REPO_PATH/packaging/electron"
# --frozen-lockfile: build the .app from the committed bun.lock, so what a user
# installs matches what was tested rather than re-resolving against package.json.
bun install --frozen-lockfile

# ── Build .app ────────────────────────────────────────────────────────────────
echo "==> Building Vision.app (this takes a minute)..."
bun run dist

# Find the built .app (arm64 or x64)
APP_SRC="$(find_built_app \
  "$REPO_PATH/packaging/electron/dist/mac-arm64/Vision.app" \
  "$REPO_PATH/packaging/electron/dist/mac/Vision.app" \
  "$REPO_PATH/packaging/electron/dist/mac-x64/Vision.app")" || {
  echo "ERROR: Could not find built Vision.app in packaging/electron/dist/"
  exit 1
}

# ── Install to /Applications ──────────────────────────────────────────────────
install_app_bundle "$APP_SRC" "$APP_DEST"

# ── Write repoPath to Vision settings ────────────────────────────────────────
# Tells the packaged app to build from local source instead of pulling GHCR image.
echo "==> Configuring Vision to use local repo..."
mkdir -p "$USERDATA"

if [ -f "$SETTINGS" ]; then
  # Merge repoPath into existing settings (bun is guaranteed installed above;
  # node is not, so run this snippet through bun — it evaluates the same JS).
  bun -e "
    const fs = require('fs');
    const p = process.argv[1];
    let s = {};
    try {
      s = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.warn('Warning: ' + p + ' is not valid JSON (' + err.message + '); using empty settings.');
    }
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
