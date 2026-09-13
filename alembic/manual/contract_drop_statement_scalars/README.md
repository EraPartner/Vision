# Drop account statement scalar projections — OUT-OF-BAND

Status: **applied to the maintained installation; retained for other installations** (2026-09-13).

The first-party frontend and backend read and write `account_statement_balances`; account metadata
requests reject the scalar fields. Before applying this physical contract elsewhere, stop writers
and make and restore-test a fresh logical backup. `up.sql` locks both tables and aborts unless every populated
declared-currency scalar exactly matches its collection entry. `down.sql` reconstructs the projection
from the collection.

Exercise the dropped-schema application paths and the down script in a disposable PostgreSQL 18
database with:

```bash
VISION_TEST_DB_TASK=statement-contract scripts/with-test-db.sh
```

```bash
psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 -v backup_verified=yes \
  -f alembic/manual/contract_drop_statement_scalars/up.sql
```
