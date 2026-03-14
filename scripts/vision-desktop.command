#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  osascript -e 'display dialog "Bun is required to start Vision Desktop. Install Bun first: https://bun.sh" buttons {"OK"} default button "OK"'
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  osascript -e 'display dialog "Docker Desktop is required. Install/start Docker Desktop and try again." buttons {"OK"} default button "OK"'
  exit 1
fi

open -a Docker || true

cd "$ROOT_DIR"
exec bun run electron:dev
