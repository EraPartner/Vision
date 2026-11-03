#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
port=${VISION_CI_PORT:-3002}

cd "$repo_root"
bun run build
env -u VISION_DATABASE_PATH \
  LIVE_API_BASE="http://127.0.0.1:${port}" \
  VISION_CI_PORT="$port" \
  VISION_DIST_DIR="$repo_root/dist" \
  VISION_NATIVE_COMMAND_DIR=apps/frontend \
  bash .github/scripts/with-native-stack.sh bun run vitest run "$@"
