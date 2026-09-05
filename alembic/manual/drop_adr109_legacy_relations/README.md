# Drop ADR-109 legacy investment relations — OUT-OF-BAND

Status: **authored, not applied** (2026-09-04).

Migration 0087 converted inheritance-shaped installations to the canonical flat
`investments` and `portfolio_transactions` tables. It retained the renamed source relations as a
data-bearing rollback copy. This operation removes those copies after the conversion has soaked.
Fresh flat installations have no such relations and the script is an explicit no-op. A partial or
wrong-kind residue set aborts before any `CASCADE`.

## Preconditions

1. Stop every Vision writer.
2. Confirm the database is at or beyond `0087_flat_investments_conversion`.
3. Create a fresh logical database backup and verify that it can be listed and restored into a
   disposable database. The legacy relations are deliberately outside `BACKUP_COVERED_TABLES`
   because they are not part of the head application schema; a full `pg_dump` still captures them.
4. Confirm the canonical flat tables exist as ordinary tables and their row counts match the
   application before cleanup.

```bash
psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 -v backup_verified=yes \
  -f alembic/manual/drop_adr109_legacy_relations/up.sql
```

There is no reconstructive down script. Rollback means restoring the verified pre-cleanup logical
backup. This is why the backup gate is part of the SQL, and why the operation is not in the
auto-applied Alembic chain. A durable `public.adr109_legacy_cleanup_marker` table is created when
the cleanup runs. Migration 0087 checks that marker and refuses an Alembic downgrade rather than
recording 0086 against an unrecoverable flat schema.

After applying, run `alembic current`, the portfolio repository tests, a portfolio read/write
smoke, and a backup/restore smoke. Keep the backup until those checks pass.
