---
name: db-migrations
description: Vision database schema changes via Alembic — creating, applying, or rolling back PostgreSQL migrations. Use when a change touches the data model, schema, alembic/versions/, or the user mentions migrations/database changes.
---

# DB migrations (Alembic via bun scripts)

Migrations live in `alembic/versions/`; the bun scripts need the Python venv with Alembic
(`venv/`). Data-model reference: `docs/reference/` (data model) — read it before schema changes.

```bash
bun run db:revision -- "describe the change"   # create a new migration
bun run db:upgrade                              # apply
bun run db:downgrade                            # roll back one
bun run db:current | db:history                 # state / history
```

Rules (from CLAUDE.md, non-negotiable):

- **Migrations are not auto-run** — create the migration, ship a rollback plan, and let the user
  apply it. Never run `db:upgrade` against the user's data unasked.
- Every schema change ships with: the Alembic migration, a tested rollback, and a blast-radius
  note (verification tier "high").
- Record significant data-model decisions as a new ADR in `docs/adr/` (append-only).
