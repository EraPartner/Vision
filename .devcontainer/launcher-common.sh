#!/usr/bin/env bash
# Shared host-side helpers for the sandbox launchers (Vision bin/claude,
# Watchman bin/claude, Brain bin/agent, git-agent bin/git-agent, sandbox
# bin/dev). Vendored into each .devcontainer/ by devcontainer-egress/sync.sh and
# sourced by the launcher as "$(dirname "$0")/../launcher-common.sh".
#
# WHY: stage_claude_config(), the Keychain credential block, and the
# autosync-on-exit trap were copy-pasted near-verbatim across all launchers and
# had begun to drift. This is the single source; per-launcher specifics (Brain's
# copilot/opencode staging, git-agent's push token + ssh signing, the charter)
# stay in the individual launchers and run alongside these.
#
# Must stay POSIX-bash-3.2 compatible (macOS /bin/bash). No associative arrays,
# no ${var^^}. Functions use a shared global EXEC_ENV array by design.

# --- Stage a sanitized ~/.claude into the RO bind-mount staging dir -----------
# Usage: sandbox_stage_claude_config <profile>
#   Produces  $HOME/.claude-sandbox/stage/<profile>/dot-claude/   (config tree)
#   and       $HOME/.claude-sandbox/stage/<profile>/claude.json   (.claude.json)
# Copies only the safe, declarative config; rewrites host plugin paths to the
# container path; strips hooks from the staged settings (the PreToolUse guard
# reaches the box out-of-band via the root-owned managed-settings.json bind).
sandbox_stage_claude_config() {
  local profile="$1"
  local src dst item jf f
  src="$(cd "$HOME/.claude" 2>/dev/null && pwd -P || true)"
  dst="$HOME/.claude-sandbox/stage/$profile"
  rm -rf "$dst/dot-claude"; mkdir -p "$dst/dot-claude"
  if [[ -n "$src" && -d "$src" ]]; then
    for item in settings.json keybindings.json CLAUDE.md agents rules commands statusline status-line.sh plugins; do
      [[ -e "$src/$item" ]] && cp -a "$src/$item" "$dst/dot-claude/" 2>/dev/null || true
    done
    find "$dst/dot-claude/statusline" "$dst/dot-claude/plugins" -name .git -type d -prune -exec rm -rf {} + 2>/dev/null || true
    for jf in known_marketplaces.json installed_plugins.json; do
      f="$dst/dot-claude/plugins/$jf"
      [[ -f "$f" ]] && sed -i '' -e "s#$HOME/.claude#/home/dev/.claude#g" -e "s#$src#/home/dev/.claude#g" "$f" 2>/dev/null || true
    done
    find "$dst/dot-claude" -name '.DS_Store' -delete 2>/dev/null || true
    if [[ -f "$dst/dot-claude/settings.json" ]] && command -v jq >/dev/null 2>&1; then
      local hjt; hjt="$(mktemp)"
      jq 'del(.hooks)' "$dst/dot-claude/settings.json" >"$hjt" 2>/dev/null && mv "$hjt" "$dst/dot-claude/settings.json" || rm -f "$hjt"
    fi
  fi
  [[ -f "$HOME/.claude.json" ]] && cp "$HOME/.claude.json" "$dst/claude.json" 2>/dev/null || true
}

# --- Forward the Claude LLM token into a shared EXEC_ENV array ----------------
# Usage: sandbox_forward_llm_creds <keychain-service>
# Appends -e KEY=VAL pairs to the caller's EXEC_ENV array (declare it first).
# Prefers the named macOS Keychain item; falls back to the host env vars.
sandbox_forward_llm_creds() {
  local kc_service="$1" tok var val a have_claude=0
  if command -v security >/dev/null 2>&1; then
    tok="$(security find-generic-password -s "$kc_service" -w 2>/dev/null || true)"
    [[ -n "$tok" ]] && EXEC_ENV+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$tok")
  fi
  for a in ${EXEC_ENV[@]+"${EXEC_ENV[@]}"}; do [[ "$a" == "CLAUDE_CODE_OAUTH_TOKEN="* ]] && have_claude=1; done
  if (( ! have_claude )); then
    for var in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; do
      val="${!var:-}"; [[ -n "$val" ]] && EXEC_ENV+=(-e "${var}=${val}")
    done
  fi
}

# --- Install an exit trap that pushes container config back to the host -------
# Usage: sandbox_install_autosync_trap <profile> <container-id> <enabled:0|1>
# On shell exit, runs `<profile>-claude-sync push <cid>` via fish (idempotent;
# guarded so it fires at most once and degrades to a no-op if fish is absent).
sandbox_install_autosync_trap() {
  local profile="$1" cid="$2" enabled="$3"
  _SANDBOX_AUTOSYNC_PROFILE="$profile"
  _SANDBOX_AUTOSYNC_CID="$cid"
  _SANDBOX_AUTOSYNC_ENABLED="$enabled"
  _SANDBOX_AUTOSYNC_DONE=0
  trap _sandbox_autosync_push EXIT
}
_sandbox_autosync_push() {
  [[ "${_SANDBOX_AUTOSYNC_DONE:-0}" == 1 ]] && return 0
  _SANDBOX_AUTOSYNC_DONE=1
  [[ "${_SANDBOX_AUTOSYNC_ENABLED:-0}" != 1 || -z "${_SANDBOX_AUTOSYNC_CID:-}" ]] && return 0
  command -v fish >/dev/null 2>&1 || return 0
  fish -c "${_SANDBOX_AUTOSYNC_PROFILE}-claude-sync push ${_SANDBOX_AUTOSYNC_CID}" \
    || echo "launcher: auto config-sync push failed — run '${_SANDBOX_AUTOSYNC_PROFILE}-claude-sync push' to retry." >&2
}
