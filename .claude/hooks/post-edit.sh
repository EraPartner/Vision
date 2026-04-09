#!/usr/bin/env bash
# PostToolUse hook — fires after Edit or Write
# Receives tool event as JSON on stdin

set -euo pipefail
PROJECT="/Users/computer/Documents/Personal/Scripts/Projects/Vision"

# Parse file_path from stdin JSON
FILE=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

[ -z "$FILE" ] && exit 0

# TypeScript/TSX: ESLint on the changed file only
if [[ "$FILE" == *.ts || "$FILE" == *.tsx ]]; then
  cd "$PROJECT"
  echo "--- ESLint: $(basename "$FILE") ---"
  bunx eslint "$FILE" --quiet --max-warnings=0 2>&1
fi

# Locale or i18n source files: validate all locales
if echo "$FILE" | grep -qE "(locales|i18n/source)"; then
  cd "$PROJECT"
  echo "--- Locale validation ---"
  bun run validate-locales 2>&1 | tail -15
fi
