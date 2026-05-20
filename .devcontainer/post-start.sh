#!/usr/bin/env bash
# Runs every time the container starts, as the `dev` user, AFTER the root
# ENTRYPOINT has already done perms repair + Postgres start + egress proxy +
# firewall. This hook only refreshes the Claude config from the host stage and
# does the ssh-agent signing sanity check. No sudo (no-new-privileges).

set -euo pipefail

STAGE=/home/dev/.claude-stage

# Auto-pull the sanitized host Claude config into the container on every start.
if [[ -d "$STAGE/dot-claude" && -d /home/dev/.claude ]]; then
  rsync -a --update --ignore-errors "$STAGE/dot-claude/" /home/dev/.claude/ 2>/dev/null || true
fi
# Merge the staged ~/.claude.json into the container's (container values win).
if [[ -f "$STAGE/claude.json" && -f /home/dev/.claude.json ]]; then
  tmp=$(mktemp)
  if jq -s '.[1] * .[0]' /home/dev/.claude.json "$STAGE/claude.json" > "$tmp" 2>/dev/null \
     && [[ -s "$tmp" ]]; then
    mv "$tmp" /home/dev/.claude.json
  else
    rm -f "$tmp"
    echo "[post-start] WARN: jq merge of ~/.claude.json failed — container kept stale state." >&2
  fi
fi

# Prune host-origin auto-exec surfaces from the container's ~/.claude on every
# start. The host stage is an allowlist, but the ~/.claude *volume* persists
# across rebuilds and may retain code-exec files from an older (blocklist-era)
# seed — and rsync --update never deletes. Removing them here converges any
# volume to a safe state regardless of history. (statusLine/status-line.sh runs
# on every render; scheduled-tasks/jobs/daemon/hooks/plugins are auto-run.)
# NOTE: statusline/ + status-line.sh are intentionally NOT pruned — the user's
# statusLine runs in-container by design (see README SECURITY NOTE). Only the
# higher-risk auto-run surfaces the user hasn't opted into are removed.
for p in scheduled-tasks tasks jobs daemon hooks plugins; do
  rm -rf "/home/dev/.claude/$p" 2>/dev/null || true
done
if [[ -f /home/dev/.claude/settings.json ]]; then
  tmp=$(mktemp)
  jq 'del(.hooks)|del(.enabledPlugins)' /home/dev/.claude/settings.json >"$tmp" 2>/dev/null \
    && mv "$tmp" /home/dev/.claude/settings.json || rm -f "$tmp"
fi
if [[ -f /home/dev/.claude.json ]]; then
  tmp=$(mktemp)
  jq 'del(.mcpServers)|del(.hooks)|del(.enabledPlugins)' /home/dev/.claude.json >"$tmp" 2>/dev/null \
    && mv "$tmp" /home/dev/.claude.json || rm -f "$tmp"
fi

# Sanity-check: is the signing public key actually loaded in the host
# ssh-agent we just forwarded? If not, `git commit -S` will fail — emit a hint.
SIGNING_PUB=/home/dev/.ssh/host-signing.pub
if [[ -r "$SIGNING_PUB" ]] && command -v ssh-keygen >/dev/null && command -v ssh-add >/dev/null; then
  want_fp="$(ssh-keygen -lf "$SIGNING_PUB" 2>/dev/null | awk '{print $2}')"
  agent_fps="$(SSH_AUTH_SOCK=/ssh-agent ssh-add -l 2>/dev/null | awk '{print $2}')"
  if [[ -n "$want_fp" ]] && ! grep -qF "$want_fp" <<<"$agent_fps"; then
    cat >&2 <<EOF
[post-start] ⚠  Signing key not loaded in the forwarded host ssh-agent.
  want:  $want_fp  ($(awk '{print $3}' "$SIGNING_PUB"))
  agent: $(SSH_AUTH_SOCK=/ssh-agent ssh-add -l 2>/dev/null | sed 's/^/    /' || echo "    (none)")
  On the host, run e.g.:  ssh-add ~/.ssh/github
  Then signed commits inside the container will work.
EOF
  fi
fi

# Refuse to proceed if the egress firewall didn't verify. The entrypoint writes
# this sentinel only after confirming default-deny is active; its absence means
# the lock may be open. Egress is fail-closed regardless (init-firewall.sh sets
# DROP first), but surface it loudly and fail the lifecycle so it's not missed.
if [[ ! -f /run/vision-firewall-ok ]]; then
  cat >&2 <<'EOF'
[post-start] ✖✖ EGRESS FIREWALL NOT VERIFIED (/run/vision-firewall-ok missing).
[post-start]     The egress lock did not confirm. Check `docker logs` for the
[post-start]     [firewall] error, then restart the container. Do NOT run
[post-start]     --dangerously-skip-permissions until this is resolved.
EOF
  exit 1
fi

echo "[post-start] Ready. Inside the container, run:  bun run dev"
