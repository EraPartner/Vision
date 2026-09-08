#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]] || ! command -v apt-get >/dev/null; then
  echo "PostgreSQL 18 CI setup requires an Ubuntu or Debian runner." >&2
  exit 1
fi

if [[ -x /usr/lib/postgresql/18/bin/postgres ]]; then
  echo "PostgreSQL 18 is already installed."
  exit 0
fi

sudo install -d -m 0755 /usr/share/postgresql-common
curl -fsSL --retry 3 --retry-all-errors \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | sudo tee /usr/share/postgresql-common/pgdg.asc >/dev/null

codename=$(awk -F= '$1 == "VERSION_CODENAME" { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release)
if [[ ! "$codename" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "Could not determine the runner distribution codename." >&2
  exit 1
fi

printf 'deb [signed-by=/usr/share/postgresql-common/pgdg.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$codename" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-18

/usr/lib/postgresql/18/bin/postgres --version
