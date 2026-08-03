#!/bin/sh
# Optional least-privilege application role (security backlog: "Backend DB role
# is the Postgres bootstrap superuser").
#
# The official postgres image bootstraps POSTGRES_USER (ftm_user) as a
# superuser, and by default the backend's runtime pool connects as that same
# role — so any SQL injection or compromised dependency has instance-level
# reach. This script creates a non-superuser `ftm_app` role for the runtime
# pool, keeping the privileged `ftm_user` for Alembic DDL only.
#
# Opt-in: no-op unless POSTGRES_APP_PASSWORD is set in .env BEFORE the first
# `docker compose up` (docker-entrypoint-initdb.d scripts run only when the
# data volume is initialised). See .env.example for the paired DATABASE_URL /
# DATABASE_URL_MIGRATIONS settings.
#
# The password is interpolated into SQL below, so it must not contain a single
# quote — .env.example generates it with `openssl rand -hex 32`, which cannot.
set -eu

if [ -z "${POSTGRES_APP_PASSWORD:-}" ]; then
  echo "[postgres-init] POSTGRES_APP_PASSWORD not set - skipping ftm_app role creation (single-role setup)."
  exit 0
fi

case "$POSTGRES_APP_PASSWORD" in
  *"'"*)
    echo "[postgres-init] POSTGRES_APP_PASSWORD must not contain a single quote." >&2
    exit 1
    ;;
esac

echo "[postgres-init] Creating least-privilege application role ftm_app."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
  CREATE ROLE ftm_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
EOSQL

# Grant set lives in app-role-grants.sql.tpl (single source of truth, shared
# with the runtime bootstrap in apps/node-backend/src/database/roleBootstrap.js).
# The path is the compose mount point of docker/postgres-init — hardcoded
# because init scripts may be *sourced* by the postgres entrypoint, making
# $0-relative paths unreliable.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_role=ftm_app \
  -v owner_role="$POSTGRES_USER" \
  -v db_name="$POSTGRES_DB" \
  -f /docker-entrypoint-initdb.d/app-role-grants.sql.tpl
