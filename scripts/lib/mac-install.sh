#!/usr/bin/env bash
# Shared macOS install helpers for install.sh and install-demo.sh.
# Source this file after REPO_PATH is set:
#   source "$REPO_PATH/scripts/lib/mac-install.sh"
#
# These factor out the shared Docker-Demo wait loop, the built-app candidate
# scan, and the copy/de-quarantine install block. Normal Vision installation no
# longer calls the Docker helper; Vision Demo remains an explicitly isolated
# Docker deployment.

# Wait up to ~60s (30 × 2s) for the Docker daemon to come up. Callers handle the
# "starting…" / "ready" / failure messaging so each script keeps its own wording.
# Returns 0 once `docker info` succeeds, 1 if it never does.
wait_for_docker_daemon() {
  local i
  for i in $(seq 1 30); do
    sleep 2
    docker info >/dev/null 2>&1 && return 0
    [ "$i" -eq 30 ] && return 1
  done
  return 1
}

# Echo the first existing candidate .app path to stdout; return 1 if none exist.
# Usage: APP_SRC="$(find_built_app "cand1" "cand2" ...)" || { echo ERROR; exit 1; }
find_built_app() {
  local candidate
  for candidate in "$@"; do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Install a built .app bundle to its destination: replace any existing copy,
# copy the new one, and strip the quarantine flag so Gatekeeper won't block a
# self-built app. Usage: install_app_bundle "$APP_SRC" "$APP_DEST"
install_app_bundle() {
  local src="$1" dest="$2"
  local appname
  appname="$(basename "$dest" .app)"
  echo "==> Installing to $dest..."
  if [ -d "$dest" ]; then
    # Best-effort: quit a running copy first so its native children can shut down
    # cleanly before the application bundle is replaced. Ignored if not running.
    osascript -e "tell application \"$appname\" to quit" >/dev/null 2>&1 || true
    rm -rf "$dest"
  fi
  # ditto (not cp -r) preserves .app symlink / xattr / resource-fork fidelity.
  ditto "$src" "$dest"
  xattr -cr "$dest" 2>/dev/null || true
}
