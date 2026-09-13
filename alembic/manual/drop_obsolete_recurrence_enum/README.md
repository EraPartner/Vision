# Drop obsolete recurrence enum — OUT-OF-BAND

Status: **applied to the maintained installation; retained for other installations** (2026-09-13).

Migration 0099 moved the canonical portfolio column to checked text. The old PostgreSQL enum remains
only for ADR-109 rollback relations and migration downgrade support. Run this contract only after the
same installation has completed the ADR-109 cleanup and its post-cleanup backup/restore acceptance.

Stop all writers, make and restore-test a fresh logical backup, then run:

```bash
psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 -v backup_verified=yes \
  -f alembic/manual/drop_obsolete_recurrence_enum/up.sql
```

The script requires the ADR-109 marker, rejects remaining `legacy_inh_*` relations, and queries
`pg_depend` before dropping the type. The backup acknowledgement must equal `yes`; a different
present value is rejected. `down.sql` recreates the exact historical enum values, but it
does not recreate deleted ADR-109 relations. Full rollback of the maintenance window remains the
verified pre-contract backup.
