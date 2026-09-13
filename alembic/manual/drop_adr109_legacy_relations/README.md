# Drop ADR-109 legacy investment relations — OUT-OF-BAND

Status: **applied to the maintained installation; retained for other installations** (2026-09-13).

Migration 0087 converted inheritance-shaped installations to the canonical flat
`investments` and `portfolio_transactions` tables. It retained the renamed source relations as a
data-bearing rollback copy. This operation removes those copies after an explicit operator decision.
Fresh flat installations have no such relations; the script records the cleanup marker and otherwise
does no work. A partial or wrong-kind required residue set aborts before any `CASCADE`. The 24
ADR-109 rollback relations are mandatory on converted installations. The older
`investments_legacy` and `portfolio_transactions_legacy` snapshots are optional because ADR-109 did
not create them; when present, they receive the same archive, digest, and drop treatment.

The maintained installation's operator explicitly waived the former 30-day elapsed-time gate on
2026-09-13. Migration 0087 must still pass its PostgreSQL 18 legacy-fixture
upgrade/parity/downgrade gate. The cleanup stays manual and will not be promoted into the
auto-applied chain.

## Preconditions

1. Stop every Vision writer.
2. Confirm the database is at or beyond `0087_flat_investments_conversion`.
3. Create a fresh logical database backup and verify that it can be listed and restored into a
   disposable PostgreSQL 18 database. Run portfolio reads and one disposable write/rollback smoke on
   that restored database. The legacy relations are deliberately outside `BACKUP_COVERED_TABLES`
   because they are not part of the head application schema; a full `pg_dump` still captures them.
4. Confirm the canonical flat tables exist as ordinary tables, remain internally consistent, and
   match current application reads before cleanup. Do not require current row equality with the
   `legacy_inh_*` relations: those are a frozen conversion-time rollback snapshot, so later price,
   metadata, transaction, and deletion changes create expected drift. Record aggregate ID and row
   drift for review instead. The script preserves every source-table row in
   `adr109_legacy_archive` and aborts unless per-relation counts and order-independent SHA-256
   digests match. This archive is a non-lossy quarantine for legacy-only rows; it is not permission
   to skip canonical parity review.

```bash
psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 \
  -v backup_verified=yes -v canonical_parity_verified=yes \
  -f alembic/manual/drop_adr109_legacy_relations/up.sql
```

The two acknowledgement values must equal `yes`; presence alone is not accepted. They attest to
the restore-tested backup and the explicit canonical-integrity and frozen-snapshot drift review. The script then takes access-exclusive locks on the canonical
tables and every rollback table before archiving, verifying, or dropping data.

There is no reconstructive down script. Rollback means restoring the verified pre-cleanup logical
backup. This is why the backup and evidence gates are part of the SQL, and why the operation is not in the
auto-applied Alembic chain. A durable `public.adr109_legacy_cleanup_marker` table is created when
the cleanup runs. Migration 0087 checks that marker and refuses an Alembic downgrade rather than
recording 0086 against an unrecoverable flat schema. The durable archive and marker must both be
present in the post-cleanup logical backup and restore smoke.

After applying, run `alembic current`, the portfolio repository tests, a portfolio read/write
smoke, and a backup/restore smoke. Keep the backup until those checks pass.
