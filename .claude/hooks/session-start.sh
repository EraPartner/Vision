#!/bin/bash
# SessionStart hook for Claude Code cloud sessions (CLAUDE_CODE_REMOTE=true).
# Installs workspace dependencies so lint, typecheck, tests, ast-grep and the
# edit-check hook work from the first command, then warms the incremental
# tsc caches used by .claude/hooks/check-edit.ts in the background.
# Local sessions (Tor's Mac, Remote Control) manage their own install.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Idempotent: a no-op install takes well under a second. The root `prepare`
# script also installs packaging/electron dependencies. Its output goes to
# stderr because SessionStart stdout is added to Claude's context.
bun install 1>&2

cache=node_modules/.cache/claude-edit-check
mkdir -p "$cache"
for project in apps/frontend/tsconfig.app.json apps/node-backend/tsconfig.json; do
  info="$cache/$(echo "$project" | tr / _).tsbuildinfo"
  nohup node_modules/.bin/tsc -p "$project" --noEmit --incremental \
    --tsBuildInfoFile "$info" >/dev/null 2>&1 &
done
