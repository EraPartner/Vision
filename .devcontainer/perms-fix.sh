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

# Dependency volumes (`node_modules/`, `./venv`) are mounted INSIDE the
# bind-mounted workspace so the container's Linux trees never touch the host's.
# They come up root:root and empty like any fresh volume, so `dev` could not
# install into them.
#
# The list is DERIVED from /proc/self/mountinfo rather than hardcoded, so adding
# a workspace in bin/claude can't silently leave a volume unwritable — and, more
# importantly, it is gated on the path actually BEING a mountpoint. With an older
# launcher (no volumes attached) these paths are plain bind-mounted workspace,
# and a chown -R there would rewrite the ownership of the user's own files on the
# host. No mount, no chown.
while read -r mp; do
  fix_dir_owner "$mp" dev
done < <(awk '$5 ~ "^/workspaces/Vision/" && ($5 ~ /\/node_modules$/ || $5 ~ /\/venv$/) { print $5 }' \
           /proc/self/mountinfo 2>/dev/null)

exit 0
