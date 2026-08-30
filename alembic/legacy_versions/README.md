# Legacy Alembic revisions

This folder preserves historical revision scripts that were removed from the active
`alembic/versions/` chain when Vision adopted a clean baseline.

Do not copy these files into the active chain or run them against a live Vision database. They may
conflict with the current revision graph and data model. If historical recovery work requires one,
first document the revision-graph change and validate it against a disposable PostgreSQL database.
Route any schema write through `apps/node-backend/scripts/db-migrate.js` so Vision's
`alembic_version VARCHAR(64)` preflight is preserved.
