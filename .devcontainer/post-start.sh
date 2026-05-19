#!/usr/bin/env bash
# Runs every time the container starts (including after a stop/start cycle).
# Ensures Postgres is running and applies the firewall.

set -euo pipefail

PG_VERSION=18
PG_CLUSTER=main

# Start postgres if not already running.
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  echo "[post-start] Starting Postgres ${PG_VERSION}/${PG_CLUSTER}..."
  sudo pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" start || true
fi

# Make the forwarded ssh-agent socket readable by `dev`. Docker Desktop
# mounts it as root:root mode 0660, which locks the non-root user out.
if [[ -S /ssh-agent ]]; then
  sudo chmod 666 /ssh-agent 2>/dev/null || true
fi

# Auto-pull host Claude config into the container on every start.
# Read-only: rsync only reads from /home/dev/.claude-host (host bind RO)
# and writes to /home/dev/.claude (container volume) — no risk to host.
# Also merge host's ~/.claude.json into the container's via jq (host wins
# only on new keys; existing container values are preserved). The host
# bind paths only exist when the user's mounts are wired; tolerate absence.
if [[ -d /home/dev/.claude-host && -d /home/dev/.claude ]]; then
  rsync -a --update --ignore-errors \
    --exclude='.credentials.json' \
    --exclude='backups' --exclude='daemon.log' \
    --exclude='cache' --exclude='paste-cache' \
    --exclude='telemetry' --exclude='debug' \
    --exclude='session-env' --exclude='shell-snapshots' \
    /home/dev/.claude-host/ /home/dev/.claude/ 2>/dev/null || true
fi
if [[ -f /home/dev/.claude-json-seed && -f /home/dev/.claude.json ]]; then
  tmp=$(mktemp) && \
    jq -s '.[1] * .[0]' /home/dev/.claude.json /home/dev/.claude-json-seed > "$tmp" 2>/dev/null && \
    mv "$tmp" /home/dev/.claude.json 2>/dev/null || rm -f "$tmp"
fi

# Sanity-check: is the signing public key actually loaded in the host
# ssh-agent we just forwarded? If not, `git commit -S` will fail with
# "No private key found for public key …" — emit a clear hint instead.
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

# Apply firewall rules. Failure here is non-fatal so the container still
# boots into a usable state (you can re-run init-firewall.sh manually).
if [[ -x /workspaces/Vision/.devcontainer/init-firewall.sh ]]; then
  echo "[post-start] Applying firewall..."
  sudo /workspaces/Vision/.devcontainer/init-firewall.sh || \
    echo "[post-start] Firewall apply failed — check NET_ADMIN/NET_RAW caps."
fi

echo "[post-start] Ready. Inside the container, run:  bun run dev"
