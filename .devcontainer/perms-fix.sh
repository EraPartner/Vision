#!/usr/bin/env bash
# /usr/local/sbin/vision-perms-fix
#
# Image-baked helper that performs ONLY the specific ownership / permission
# repairs the devcontainer needs at start time. It is invoked by the root
# ENTRYPOINT (the container has no sudo — it runs with no-new-privileges, and
# all privileged setup happens in the entrypoint). The repo copy at
# .devcontainer/perms-fix.sh is the source — the Dockerfile COPYs it in
# read-only to dev.
#
# Takes no arguments and performs no operations parameterised by the caller.

set -euo pipefail

fix_dir_owner() {
  local dir="$1"
  local owner="$2"
  if [[ -d "$dir" ]] && [[ "$(stat -c %U "$dir")" != "$owner" ]]; then
    chown -R "$owner:$owner" "$dir"
  fi
}

# Named-volume mountpoints come up as root:root on first mount, regardless of
# the image-side directory perms. Repair to dev / postgres ownership so the
# respective users can write.
fix_dir_owner /home/dev/.claude       dev
fix_dir_owner /home/dev/.config       dev
fix_dir_owner /var/lib/postgresql     postgres

# Docker Desktop's forwarded ssh-agent socket lands as root:root mode 0660.
# Previously we chmod 666'd it — that's world-writable and any process in the
# container (including a malicious npm postinstall) could drive the host
# ssh-agent. Take ownership and tighten to 0600 so only dev can use it.
if [[ -S /ssh-agent ]]; then
  chown dev:dev /ssh-agent
  chmod 0600 /ssh-agent
fi

exit 0
