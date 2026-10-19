---
name: db-migrations
description: Create, review, apply, or roll back Vision PostgreSQL schema changes with the Kysely migrator. Use for data-model changes, schema work, db/migrations files, migration requests, or database upgrade and downgrade operations.
---

# Vision database migrations

Read the data-model reference under `docs/reference/` and ADR-222 before changing the schema.
Migrations are numbered SQL files in `db/migrations/`; `0001_baseline.sql` is the squashed schema
and is never edited. The backend applies pending files on boot in one transaction.

```bash
bun run db:new -- describe_the_change   # creates db/migrations/NNNN_describe_the_change.sql
bun run db:migrate                      # apply pending migrations (DATABASE_URL)
bun run db:migrate:down                 # revert the latest one (needs NNNN_name.down.sql)
bun run db:status
bun run db:lint                         # squawk on db/migrations
bun run db:codegen                      # regenerate apps/node-backend/src/database/schema.generated.ts
```

- Create the migration, a tested `NNNN_name.down.sql` rollback, and a blast-radius note together.
- Do not run `db:migrate` against user data without explicit approval.
- Regenerate the Kysely types after the migration and commit them with it.
- Run `bun run db:lint` and the relevant backend tests on a disposable PostgreSQL 18 database.
- Record significant data-model decisions in a new append-only ADR.
- Report whether upgrade and rollback were executed or only reviewed.
