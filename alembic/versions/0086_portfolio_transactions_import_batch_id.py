"""Rollback support: import_batch_id on the portfolio transaction tables.

Revision ID: 0086_portfolio_transactions_import_batch_id
Revises: 0085_mv_monthly_summary_alias_category
Create Date: 2026-08-01

Bank-import rollback has been one statement since 0003 — `DELETE FROM transactions WHERE
import_batch_id = $1`. The portfolio side never got the equivalent column: rollback re-read
`portfolio_import_staging_rows.committed_txn_id` and issued one hard-delete per committed row
(N round trips for an N-row brokerage CSV). This adds the missing column so the portfolio path
collapses to the same single bulk DELETE.

Mirrors 0003's shape exactly: BIGINT (portfolio_import_batches.id is BIGSERIAL), nullable
(NULL = manually-entered or pre-pipeline lot), `REFERENCES portfolio_import_batches(id)
ON DELETE SET NULL` so manually deleting a batch row preserves the lots it created, and a
PARTIAL index `WHERE import_batch_id IS NOT NULL` — the column is NULL for the overwhelming
majority of rows and the only query shape is "the lots of batch X".

SCHEMA-SHAPE AWARE (same two-shape handling as 0052/0079, until the ADR-109 conversion lands):
`portfolio_transactions` may be a real table (flat schema, what fresh installs get from 0001)
OR a JOIN VIEW over `portfolio_transactions_base` + per-asset-class child tables (legacy
table-inheritance, ADR-004). You cannot ADD COLUMN to a view, so on inheritance installs the
column lands on the BASE table (inherited by every child, which is where the import path's
INSERT actually goes) and the view is recreated to expose it; on flat installs it is added
directly. The FK is not inherited by child tables (a PostgreSQL inheritance limitation), so on
legacy installs it enforces only for base-table rows — acceptable, and identical to how 0052's
account_id FK behaves there. `portfolio_import_batches` is a real table on every install
(0040), never a view, so the FK is unconditional — no `relkind` guard is needed.

The view body below is 0052's `_VIEW_WITH_ACCT` verbatim plus the new column; 0052 was the last
revision to (re)define this view, so that is the definition every legacy install currently has.
Downgrade restores exactly that body via DROP + CREATE (CREATE OR REPLACE cannot remove a
column, Postgres 42P16 — same reason 0052's downgrade does it this way), then drops the index
and the column.

Blast radius: one nullable column (+ inherited on legacy) + one partial index + a view column.
No data change; every existing lot reads back with import_batch_id NULL.

ROLLOUT — migrations are not auto-run by the agent; this applies on the next app boot
(`runMigrations` in main.js, and `docker-entrypoint.sh` for containers). The application code
that stamps and reads the column is written to tolerate BOTH states, in both directions, so the
ordering of code-vs-migration is not load-bearing:
  * before this migration applies, the commit path probes for the column (pg_attribute) and
    omits it from the INSERT, and rollback skips the bulk DELETE entirely;
  * after it applies, lots committed BEFORE it still carry NULL import_batch_id, so rollback
    keeps the per-id `committed_txn_id` path as a fallback for exactly those rows. No batch is
    ever stranded un-rollbackable by the migration boundary.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0086_portfolio_transactions_import_batch_id"
down_revision: Union[str, Sequence[str], None] = "0085_mv_monthly_summary_alias_category"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The portfolio_transactions view body as 0052 left it. "%(BATCH)s" expands to the extra
# import_batch_id column (or "") — same templating idiom as 0052's "%(ACCT)s".
_VIEW = """
        CREATE OR REPLACE VIEW portfolio_transactions AS
         SELECT ptb.id,
                ptb.investment_id,
                ptb.type,
                ptb.date,
                ptb.amount,
                COALESCE(st.units, et.units, ct.units, mt.units) AS units,
                COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit, mt.price_per_unit) AS price_per_unit,
                ptb.fees,
                ptb.taxes,
                ptb.currency,
                ptb.note,
                ptb.is_recurring,
                ptb.recurrence_interval,
                ptb.recurrence_end_date,
                ptb.created_at,
                ptb.updated_at,
                ptb.fx_rate_to_eur,
                ptb.account_id%(BATCH)s
           FROM portfolio_transactions_base ptb
             LEFT JOIN stock_transactions st ON ptb.id = st.id
             LEFT JOIN etf_transactions et ON ptb.id = et.id
             LEFT JOIN crypto_transactions ct ON ptb.id = ct.id
             LEFT JOIN metals_transactions mt ON ptb.id = mt.id;
"""

_VIEW_WITH_BATCH = _VIEW % {"BATCH": ",\n                ptb.import_batch_id"}
_VIEW_WITHOUT_BATCH = _VIEW % {"BATCH": ""}

# Downgrade must REMOVE a column from the view; CREATE OR REPLACE VIEW cannot (42P16), so the
# pre-0086 body has to go through DROP + CREATE. Nothing depends on this view (same check 0052
# made), so a plain DROP is safe — no CASCADE.
_VIEW_WITHOUT_BATCH_RECREATE = _VIEW_WITHOUT_BATCH.replace(
    "CREATE OR REPLACE VIEW portfolio_transactions AS",
    "DROP VIEW portfolio_transactions;\n        CREATE VIEW portfolio_transactions AS",
)


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.portfolio_transactions_base') IS NOT NULL THEN
            ALTER TABLE portfolio_transactions_base
                ADD COLUMN IF NOT EXISTS import_batch_id BIGINT
                    REFERENCES portfolio_import_batches(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_base_import_batch_id
                ON portfolio_transactions_base (import_batch_id)
                WHERE import_batch_id IS NOT NULL;
        """
        + _VIEW_WITH_BATCH
        + """
          ELSE
            ALTER TABLE portfolio_transactions
                ADD COLUMN IF NOT EXISTS import_batch_id BIGINT
                    REFERENCES portfolio_import_batches(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_import_batch_id
                ON portfolio_transactions (import_batch_id)
                WHERE import_batch_id IS NOT NULL;
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.portfolio_transactions_base') IS NOT NULL THEN
        """
        + _VIEW_WITHOUT_BATCH_RECREATE
        + """
            DROP INDEX IF EXISTS idx_portfolio_transactions_base_import_batch_id;
            ALTER TABLE portfolio_transactions_base DROP COLUMN IF EXISTS import_batch_id;
          ELSE
            DROP INDEX IF EXISTS idx_portfolio_transactions_import_batch_id;
            ALTER TABLE portfolio_transactions DROP COLUMN IF EXISTS import_batch_id;
          END IF;
        END $$;
        """
    )
