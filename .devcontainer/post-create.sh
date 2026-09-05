#!/usr/bin/env bash
# Runs once when the devcontainer is first created, as the `dev` user.
# Installs JS + Python deps and seeds config. Postgres init/start + role/db
# creation now happen in the root ENTRYPOINT (no sudo here — the container runs
# with no-new-privileges).

set -euo pipefail
cd /workspaces/Vision
AGENT="${SANDBOX_AGENT:-}"
case "$AGENT" in
  claude|codex) ;;
  *)
    echo "[post-create] ABORT: SANDBOX_AGENT is '${AGENT:-unset}'; recreate with the selected provider launcher." >&2
    exit 1
    ;;
esac

# Seed the container's ~/.claude + ~/.claude.json from the SANITIZED staging dir
# the host wrapper produced at /home/dev/.claude-stage (bind RO). Done FIRST,
# before any network install: it needs only the local bind mount, so a later dep
# failure (pip/bun) can never leave Claude unconfigured. The host staging
# (launcher-common.sh) copies only a curated item allowlist (so .credentials.json
# never enters), strips .hooks from settings.json and
# .oauthAccount/.projects/.installMethod from .claude.json. NOTE: mcpServers and
# enabledPlugins ARE propagated by design (user-enabled servers/plugins — see the
# post-start KEEP note); the PreToolUse guard reaches the box out-of-band via the
# root-owned managed-settings.json bind, not through this staged config.
STAGE=/home/dev/.claude-stage
if [[ "$AGENT" == claude && ! -f /home/dev/.claude/settings.json && -d "$STAGE/dot-claude" ]]; then
  echo "[post-create] Seeding ~/.claude from sanitized stage..."
  if ! rsync -a --ignore-errors "$STAGE/dot-claude/" /home/dev/.claude/; then
    echo "[post-create] WARN: ~/.claude rsync seed had errors (some files may be missing)." >&2
  fi
  echo "[post-create] Seeded $(find /home/dev/.claude -mindepth 1 -maxdepth 1 | wc -l) entries into ~/.claude."
fi
if [[ "$AGENT" == claude && ! -f /home/dev/.claude.json && -f "$STAGE/claude.json" ]]; then
  cp "$STAGE/claude.json" /home/dev/.claude.json
  chmod 0600 /home/dev/.claude.json
fi

# Wait for the egress proxy (started by the root entrypoint) before any network
# install — postCreate can race the entrypoint's proxy startup, and with egress
# locked to the proxy UID, installs fail until 127.0.0.1:3128 is listening.
echo "[post-create] Waiting for egress proxy on 127.0.0.1:3128..."
for _ in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null && break
  sleep 1
done

# Supply-chain protection is baked into the root-owned image at a reviewed
# version. This step only writes its shell wrappers; it performs no network
# install and cannot replace the pinned agent binaries.
if ! command -v safe-chain >/dev/null 2>&1; then
  echo "[post-create] ABORT: safe-chain is missing from the image; rebuild it." >&2
  exit 1
fi
if ! safe-chain setup >/dev/null 2>&1; then
  echo "[post-create] ABORT: safe-chain wrapper setup failed; package installs are not screened." >&2
  exit 1
fi
echo "[post-create] safe-chain wired up (baked pin, no runtime fetch)."

# Python venv for alembic. The repo's scripts hardcode ./venv (package.json
# db:current/db:history/db:revision, and $ALEMBIC_BIN), so the path must stay
# ./venv inside the container. The launcher mounts the `vision-venv` named volume
# there, so this builds a Linux venv in container-private storage and the host's
# own ./venv on disk is untouched. .gitignore covers venv/.
if [[ ! -x ./venv/bin/python ]] || ! ./venv/bin/python -c '' 2>/dev/null; then
  echo "[post-create] Building the container's Python venv..."
  # Clear the CONTENTS, never the directory: ./venv is a volume mountpoint and
  # `rm -rf ./venv` fails EBUSY on it, which would abort this script under set -e.
  # (Without the volume it is a plain dir and this is equivalent to rm -rf ./venv.)
  if [[ -d ./venv ]]; then
    find ./venv -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi
  python3 -m venv venv
fi
# pip honors HTTPS_PROXY → squid → pypi.org / files.pythonhosted.org.
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet -r config/requirements.txt

# Runtime database and application settings are injected by the launcher. Do not
# materialize them as a repository .env: the workspace is a host bind mount, so
# that file would escape the container boundary and could affect host-side tools.

# Install JS deps (bun honors HTTPS_PROXY → squid → registry.npmjs.org).
# --frozen-lockfile is the reproducible install: it builds strictly from
# bun.lock and fails loudly on a stale lock (matching the pinned base image /
# SHA-pinned bun / devcontainer-lock).
#
# Every node_modules/ in the tree (root + each workspace) is a named-volume
# mountpoint, so this installs Linux binaries into container-private storage and
# the host's macOS trees are left alone. On first boot the volumes mount EMPTY,
# which is exactly what this install expects; on a rebuild they are already
# populated and this is a fast no-op re-verify.
echo "[post-create] bun install --frozen-lockfile..."
bun install --frozen-lockfile

# Alembic migrations are intentionally NOT run here — the Node backend
# pre-creates alembic_version as VARCHAR(64) before invoking alembic (see
# apps/node-backend/src/database/migrate.js). Mirrors the prod entrypoint.

# Minimal ~/.gitconfig: just mark the bind-mounted workspace safe so read-only
# git ops (log/diff/status) work despite the mount's non-dev ownership. No
# identity/signing/push config — commits & pushes happen on the HOST, and the
# in-container .git is read-only.
if [[ ! -f /home/dev/.gitconfig || ! -s /home/dev/.gitconfig ]]; then
  cat > /home/dev/.gitconfig <<'EOF'
[safe]
    directory = /workspaces/Vision
EOF
fi

echo "[post-create] Done."
echo "[post-create] Start the stack with:  bun run dev"
echo "[post-create] Selected agent:         $AGENT"
