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
# data volume is initialised). Pair it with DATABASE_URL_APP in .env — see
# .env.example. DATABASE_URL itself stays on the privileged role.
#
# On a database this script never ran against — every existing volume, and
# every desktop install (the packaged compose does not mount this directory) —
# the same role and grants are created at runtime instead, by
# apps/node-backend/src/database/appRoleBootstrap.js. Keep the two in step.
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
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ftm_app;
  -- CREATE on the schema is required: the backend creates/refreshes its
  -- materialized views and their indexes at runtime (materializedViewService).
  GRANT USAGE, CREATE ON SCHEMA public TO ftm_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ftm_app;
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ftm_app;
  -- Tables/sequences created later by Alembic (running as ${POSTGRES_USER})
  -- must stay readable/writable for the app role without manual re-grants.
  ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ftm_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ftm_app;
  -- MAINTAIN (PostgreSQL 17+) covers ANALYZE / VACUUM / REFRESH MATERIALIZED
  -- VIEW without handing ownership over. The runtime bootstrap
  -- (apps/node-backend/src/database/appRoleBootstrap.js) grants the same thing
  -- on databases this first-init script never ran against; keeping the two in
  -- step means a fresh compose install and an upgraded one end up identical.
  -- Version-guarded so an older image does not abort init on a syntax error
  -- (ON_ERROR_STOP=1 is set above).
  DO \$\$
  BEGIN
    IF current_setting('server_version_num')::int >= 170000 THEN
      EXECUTE 'GRANT MAINTAIN ON ALL TABLES IN SCHEMA public TO ftm_app';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public GRANT MAINTAIN ON TABLES TO ftm_app';
    END IF;
  END
  \$\$;
EOSQL
