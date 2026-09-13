# Drop legacy `tx_hash` — OUT-OF-BAND

Status: **applied to the maintained installation; retained for other installations** (2026-09-13).

Run only after all writers run the versioned fingerprint build, writers are stopped, every import
batch containing a legacy staging hash is terminal, and a fresh logical backup has been restored
and checked. The operator has explicitly waived an elapsed-time soak. The script locks all three
affected tables and refuses unfinished batches with a non-null staging hash. Historical hashes in
terminal batches do not block the column drop. Historical transaction hashes are recoverable only
from the pre-contract backup, so this contract has no synthetic down script.

On the maintained installation, KBC import batch `20` was reviewed and committed on 2026-09-13.
The subsequent `bun run db:legacy-status --native` report showed `nonTerminalBatches: []`. Repeat
that check immediately before the maintenance window and confirm it remains empty before stopping
writers.

```bash
psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 \
  -v backup_verified=yes \
  -f alembic/manual/contract_drop_tx_hash/up.sql
```
