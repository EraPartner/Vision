---
name: db-migrations
description: Create, review, apply, or roll back Vision SQLite schema changes with the versioned migration runner. Use for data-model changes, schema work, db/migrations files, migration requests, or database upgrade and downgrade operations.
---

# Vision database migrations

Read `docs/guides/migrations.md`, `docs/reference/sqlite-sql-dialect.md`, the data-model
reference under `docs/reference/` and ADR-263 before changing the schema. Migrations are numbered
SQLite files in `db/migrations/`; `0001_baseline.sql` is the 2.0.0 schema and is never edited,
nor is any other applied migration (the ledger checks each file's SHA-256). The backend applies
pending files on boot in one transaction with foreign keys off, then runs `foreign_key_check`.

```bash
bun run db:new -- describe_the_change   # creates db/migrations/NNNN_describe_the_change.sql
bun run db:migrate                      # apply pending migrations (VISION_DATABASE_PATH)
bun run db:migrate:down                 # revert the latest one (needs NNNN_name.down.sql)
bun run db:status
bun run db:codegen                      # regenerate schema.generated.ts and schemaMap.generated.ts
```

- Create the migration, a tested `NNNN_name.down.sql` rollback, and a blast-radius note together.
- Use Vision's storage types (`DECIMAL_TEXT(p,s)` for money with its `__vtype` CHECK, and so on)
  and only SQLite 3.39 or Vision functions. No `BEGIN`, `COMMIT`, `PRAGMA`, `VACUUM`, `ATTACH`.
- Changes `ALTER TABLE` cannot make (type, default, NOT NULL, CHECK, foreign key) use the
  table-rebuild procedure in the migration guide.
- A destructive statement needs `-- destructive-ok: <reason>` directly above it and Tor's OK.
- Do not run `db:migrate` against user data without explicit approval.
- Regenerate the Kysely types after the migration and commit them with it.
- Run the backend tests: `tests/database/migrations.test.ts` (every version path) and
  `tests/database/sqlDialect.test.ts` (dialect and destructive rules) must pass.
- Record significant data-model decisions in a new append-only ADR.
- Report whether upgrade and rollback were executed or only reviewed.
