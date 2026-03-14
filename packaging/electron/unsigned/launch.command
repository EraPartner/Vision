#!/bin/bash
set -euo pipefail

# launch.command - double-click this in Finder to install/open Vision.app
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="$DIR/Vision.app"

if [ ! -d "$SRC_APP" ]; then
  echo "Vision.app not found in $DIR"
  exit 1
fi

TARGET_DIR="/Applications"
TARGET_APP="$TARGET_DIR/Vision.app"

# Install to /Applications when writable; otherwise use ~/Applications.
if [ ! -w "$TARGET_DIR" ]; then
  TARGET_DIR="$HOME/Applications"
  TARGET_APP="$TARGET_DIR/Vision.app"
  mkdir -p "$TARGET_DIR"
fi

rm -rf "$TARGET_APP"
cp -R "$SRC_APP" "$TARGET_APP"

# Remove quarantine from the installed app (safe on files you trust).
xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true

open "$TARGET_APP" || {
  echo "Failed to open $TARGET_APP — try right-click -> Open in Finder to bypass Gatekeeper."
  exit 2
}
