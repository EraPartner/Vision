#!/usr/bin/env bash
# Stop hook — fires when Claude finishes a response
# If source code files were modified, instructs Claude to run vision-kb-updater

PROJECT="/Users/computer/Documents/Personal/Scripts/Projects/Vision"
cd "$PROJECT"

CHANGED=$(git diff --name-only HEAD 2>/dev/null; git diff --name-only 2>/dev/null)
CODE_CHANGED=$(echo "$CHANGED" | grep -E '\.(ts|tsx|js|jsx)$' | grep -v '\.claude' | head -5 || true)

if [ -n "$CODE_CHANGED" ]; then
  echo ""
  echo "IMPORTANT: Source code files were modified this session:"
  echo "$(echo "$CODE_CHANGED" | sed 's/^/  - /')"
  echo ""
  echo "You MUST invoke the vision-kb-updater agent now to keep the Obsidian knowledge base in sync."
  echo "Do not consider this task complete until vision-kb-updater has run."
fi
