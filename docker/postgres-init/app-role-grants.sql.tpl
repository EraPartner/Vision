-- Grant set for the least-privilege application role — SINGLE SOURCE OF TRUTH.
--
-- Consumed by BOTH bootstrap paths:
--   * docker/postgres-init/01-app-role.sh — first-init path (fresh Docker
--     volumes), applied via `psql -v app_role=... -f` variable substitution.
--   * apps/node-backend/src/database/roleBootstrap.js — runtime path for
--     ALREADY-INITIALISED databases (existing installs never re-run the init
--     scripts); substitutes the same :"var" placeholders in JS.
--
-- The `.tpl` extension is deliberate: the postgres image's entrypoint executes
-- every *.sql / *.sh file in /docker-entrypoint-initdb.d unconditionally, and
-- this file must only ever run through 01-app-role.sh (which gates on
-- POSTGRES_APP_PASSWORD). Unknown extensions are ignored by the entrypoint.
--
-- Placeholders (psql-style quoted-identifier variables):
--   :"app_role"   — the non-superuser runtime role (ftm_app)
--   :"owner_role" — the privileged role that owns tables / runs Alembic DDL
--   :"db_name"    — the application database
--
-- Keep this file to simple ';'-terminated statements (no DO blocks, no
-- procedural SQL): roleBootstrap.js splits it naively on ';'.

GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";

-- CREATE on the schema is required: the backend creates/refreshes its
-- materialized views and their indexes at runtime (materializedViewService).
GRANT USAGE, CREATE ON SCHEMA public TO :"app_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- Tables/sequences created later by Alembic (running as :"owner_role") must
-- stay readable/writable for the app role without manual re-grants.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
