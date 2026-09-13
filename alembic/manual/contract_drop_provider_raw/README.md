# Drop provider-specific raw storage — OUT-OF-BAND

Status: **applied to the maintained installation; retained for other installations** (2026-09-13).

Migration 0108 is the expand step. It copies complete source rows to
`transaction_source_records`, preserves valid and dangling links, and moves manual duplicate claims
to `manual_transaction_dedup_claims`. The operator waived an elapsed-time soak on 2026-09-13. At the
maintenance window, stop every writer and restore-test a fresh logical backup. The contract locks the old and new stores,
supports installations with or without `custom_raw_transactions`, and aborts on count, byte-level
JSONB payload, link, or active-manual-claim differences before dropping anything.

```bash
psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 -v backup_verified=yes \
  -f alembic/manual/contract_drop_provider_raw/up.sql
```

There is no schema-only down script because reconstructing provider-specific types and constraints is
not equivalent to recovery. Roll back by restoring the verified pre-contract backup.
