#!/bin/bash
# launch.command - double-click this in Finder to run Vision.app next to it
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Vision.app"

if [ ! -d "$APP" ]; then
  echo "Vision.app not found in $DIR"
  exit 1
fi

# Remove macOS download quarantine (safe on files you trust)
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Open the app
open "$APP" || {
  echo "Failed to open $APP — try right-click → Open in Finder to bypass Gatekeeper."
  exit 2
}
