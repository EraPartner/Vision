#!/bin/bash
# Vision one-time setup for macOS.
#
# Installs Docker Desktop (if missing), starts the daemon, and pre-pulls the
# Vision container image so the first launch of Vision.app is fast. No
# package manager required.
#
# Run by double-click in Finder (right-click → Open the first time to bypass
# Gatekeeper) or `bash vision-setup.command` in Terminal.
set -euo pipefail

VERSION="__VERSION__"
IMAGE="ghcr.io/erapartner/vision:${VERSION}"

# Re-launch the script in Terminal.app when double-clicked from Finder so the
# user can see progress. If we're already attached to a terminal, run inline.
if [ ! -t 1 ]; then
  open -a Terminal "$0"
  exit 0
fi

cat <<EOF
================================================================
  Vision ${VERSION} — first-time setup
================================================================

This will:
  1. Install Docker Desktop if it isn't already installed
  2. Start Docker
  3. Download the Vision container image (~500 MB – 1.2 GB)

You can close this window when it says "Setup complete."

EOF

# ── 1. Docker Desktop ─────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1 && [ ! -d "/Applications/Docker.app" ]; then
  ARCH=$(uname -m)
  case "$ARCH" in
    arm64)  URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg" ;;
    x86_64) URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg" ;;
    *)      echo "ERROR: unsupported architecture: $ARCH"; exit 1 ;;
  esac

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT

  echo "==> Downloading Docker Desktop for ${ARCH} (~600 MB)..."
  curl -fL --progress-bar "$URL" -o "$TMP/Docker.dmg"

  echo "==> Mounting installer..."
  MOUNT=$(hdiutil attach "$TMP/Docker.dmg" -nobrowse -noverify | awk '/\/Volumes\// {print $3; exit}')
  if [ -z "${MOUNT:-}" ] || [ ! -d "$MOUNT/Docker.app" ]; then
    echo "ERROR: Could not mount Docker.dmg or find Docker.app inside."
    echo "Open the DMG manually from $TMP/Docker.dmg and drag Docker.app to /Applications."
    exit 1
  fi

  echo "==> Copying Docker.app to /Applications (you may be prompted for your password)..."
  if ! cp -R "$MOUNT/Docker.app" /Applications/ 2>/dev/null; then
    sudo cp -R "$MOUNT/Docker.app" /Applications/
  fi
  hdiutil detach "$MOUNT" -quiet || true
  echo "==> Docker Desktop installed."
fi

# ── 2. Start Docker daemon ────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "==> Starting Docker Desktop..."
  echo "    First launch may show a permission dialog or Terms of Service prompt."
  echo "    Please accept any prompts that appear."
  open -a Docker
  echo "==> Waiting for Docker to start (up to 2 min)..."
  for i in $(seq 1 60); do
    sleep 2
    if docker info >/dev/null 2>&1; then
      echo "==> Docker is running."
      break
    fi
    if [ "$i" -eq 60 ]; then
      cat <<EOF
ERROR: Docker did not become ready within 2 minutes.

Open Docker Desktop manually from /Applications and wait until the whale
icon in the menu bar stops animating, then re-run this script.
EOF
      exit 1
    fi
  done
fi

# ── 3. Pre-pull Vision image ──────────────────────────────────────────────────
echo "==> Pulling ${IMAGE} (this is the slow step on first run)..."
if ! docker pull "$IMAGE"; then
  cat <<EOF
WARNING: Could not pull the Vision image right now.
  - Check your internet connection.
  - The Vision app will retry the pull on first launch.
  - You can re-run this script later if you want to retry now.
EOF
fi

cat <<EOF

================================================================
  Setup complete.
================================================================

Next steps:

  1. Open the Vision DMG and drag Vision.app to /Applications
  2. Right-click Vision.app the first time → Open → Open
     (bypasses Gatekeeper for an unsigned build)
  3. After the first launch you can double-click normally

Vision starts and stops the Docker containers it needs while it is open.
Quit Docker Desktop yourself if you don't use Docker for anything else.

EOF
