---
name: db-migrations
description: Create, review, apply, or roll back Vision PostgreSQL schema changes with Alembic. Use for data-model changes, schema work, alembic/versions files, migration requests, or database upgrade and downgrade operations.
---

# Vision database migrations

Read the data-model reference under `docs/reference/` before changing the schema. Migrations live
in `alembic/versions/` and use the Python virtual environment in `venv/`.

```bash
bun run db:revision -- "describe the change"
bun run db:upgrade
bun run db:downgrade
bun run db:current
bun run db:history
```

- Create the migration, a tested rollback, and a blast-radius note together.
- Do not run `db:upgrade` against user data without explicit approval.
- Run `bun run db:check-destructive` and relevant backend tests.
- Record significant data-model decisions in a new append-only ADR.
- Report whether upgrade and rollback were executed or only reviewed.
