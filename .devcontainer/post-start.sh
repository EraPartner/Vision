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

# Self-heal: if a previous boot left /home/dev/.claude root-owned (e.g. an
# older container created before post-create.sh learned to chown loudly),
# fix it before the rsync below tries to write into it.
if [[ -d /home/dev/.claude && "$(stat -c %U /home/dev/.claude 2>/dev/null)" != "dev" ]]; then
  echo "[post-start] /home/dev/.claude is not dev-owned — chowning..."
  sudo chown -R dev:dev /home/dev/.claude || \
    echo "[post-start] WARN: chown of /home/dev/.claude failed." >&2
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

# Pre-flight: verify the container actually has a network. If Docker Desktop
# detached us from the bridge (happens on host sleep/resume, DD update, or its
# background reaper), there's no eth0 and DNS is unreachable. Applying the
# firewall in that state would replace any previously-working rules with
# default-DROP + empty ipset, making the failure mode (ECONNREFUSED on every
# domain) much harder to diagnose. Skip the apply and print recovery steps.
check_network() {
  local has_iface=0
  for iface in /sys/class/net/eth*; do
    [[ -e "$iface" ]] && has_iface=1
  done
  # /proc/net/route format: Iface Destination Gateway ... ; default route has
  # Destination == 00000000 (0.0.0.0).
  local default_iface
  default_iface=$(awk 'NR>1 && $2=="00000000" {print $1; exit}' /proc/net/route 2>/dev/null)
  (( has_iface )) && [[ -n "$default_iface" ]]
}

# Briefly wait for the network to come up — on cold boot eth0 can lag the
# postStart hook by a second or two.
network_ok=0
for _ in 1 2 3 4 5; do
  if check_network; then network_ok=1; break; fi
  sleep 2
done

if (( ! network_ok )); then
  cat >&2 <<EOF
[post-start] ⚠  Container has no external network interface or default route.
[post-start]    Skipping firewall apply (a default-DROP policy on top of broken
[post-start]    networking would just hide the real problem).
[post-start]
[post-start]    Most common cause: Docker Desktop detached the container from
[post-start]    its bridge network (host sleep/resume, DD update, or DD reaper).
[post-start]    Symptoms: ECONNREFUSED on api.anthropic.com, empty firewall
[post-start]    ipset, "network unreachable" from dig.
[post-start]
[post-start]    On your HOST shell (not inside the container), run:
[post-start]      docker network connect bridge $HOSTNAME
[post-start]
[post-start]    Then re-apply the firewall:
[post-start]      devcontainer exec --workspace-folder /workspaces/Vision \\
[post-start]        sudo /workspaces/Vision/.devcontainer/init-firewall.sh
EOF
elif [[ -x /workspaces/Vision/.devcontainer/init-firewall.sh ]]; then
  # Apply firewall rules. Failure here is non-fatal so the container still
  # boots into a usable state (you can re-run init-firewall.sh manually).
  echo "[post-start] Applying firewall..."
  sudo /workspaces/Vision/.devcontainer/init-firewall.sh || \
    echo "[post-start] Firewall apply failed — check NET_ADMIN/NET_RAW caps."
fi

echo "[post-start] Ready. Inside the container, run:  bun run dev"
