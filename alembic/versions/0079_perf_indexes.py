"""Performance index cleanup + targeted adds for hot query paths.

Revision ID: 0079_perf_indexes
Revises: 0078_fk_covering_indexes
Create Date: 2026-07-14

Consolidated index maintenance. No data change; every statement is idempotent
(IF [NOT] EXISTS) so the migration is safe to re-run.

1. Drop two exact-duplicate indexes. Each is byte-identical (same columns, same
   order) to an index Postgres already maintains to back a UNIQUE constraint,
   so it is pure write/maintenance overhead with zero read benefit:
     - idx_asset_price_history_investment_date  (investment_id, price_date)
       duplicates the index backing uq_asset_price_history_investment_date
       UNIQUE (investment_id, price_date)  [0001].
     - idx_pps_date_currency                    (snapshot_date, currency)
       duplicates the index backing uq_pps_date_currency
       UNIQUE (snapshot_date, currency)    [0023].
   Only these two exact twins are dropped; no prefix/partial siblings.

2. ABS(amount) expression index. filterBuilder.js builds `ABS(t.amount) >= $n`
   for unsigned magnitude filters, which the plain btree on `amount` (0044,
   idx_transactions_amount_date) cannot serve. Add an expression index on
   (ABS(amount), date).

3. Composite indexes replacing single-column-only coverage:
     - planned_transactions (is_active, is_executed, planned_date) — the planned
       list filters active + not-yet-executed and orders by planned_date; only
       single-column indexes existed (0001).
     - portfolio_transactions (investment_id, date, id) and
       (investment_id, account_id) — per-investment position/lot scans. Only
       single-column indexes existed (0001/0052). portfolio_transactions may be
       a real table (flat schema) OR a JOIN VIEW over portfolio_transactions_base
       (inheritance schema, ADR-004/0052); you cannot index a view, so — exactly
       as 0052 does — the index lands on the base table when it exists and on the
       flat table otherwise. All four columns live on the base table.

4. Partial "latest stamped balance" index. Running-balance probes look up the
   most recent active, balance-stamped row per account
   (account_id, date DESC, id DESC WHERE is_active AND balance IS NOT NULL).
   No existing index covered it (idx_transactions_active omits account_id and
   the balance predicate).

Blast radius: two index drops + five index adds. Downgrade recreates the two
dropped duplicates and drops the five adds.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0079_perf_indexes"
down_revision: Union[str, Sequence[str], None] = "0078_fk_covering_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Drop exact-duplicate indexes (each backed by an identical UNIQUE index).
    op.execute("DROP INDEX IF EXISTS idx_asset_price_history_investment_date;")
    op.execute("DROP INDEX IF EXISTS idx_pps_date_currency;")

    # 2. ABS(amount) expression index for unsigned magnitude filters.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_transactions_abs_amount_date
            ON transactions (ABS(amount), date);
        """
    )

    # 3a. planned_transactions composite for the active/not-executed list.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planned_active_executed_date
            ON planned_transactions (is_active, is_executed, planned_date);
        """
    )

    # 3b. portfolio_transactions composites — schema-shape aware (base vs flat).
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.portfolio_transactions_base') IS NOT NULL THEN
            CREATE INDEX IF NOT EXISTS idx_ptxn_investment_date_id
                ON portfolio_transactions_base (investment_id, date, id);
            CREATE INDEX IF NOT EXISTS idx_ptxn_investment_account
                ON portfolio_transactions_base (investment_id, account_id);
          ELSE
            CREATE INDEX IF NOT EXISTS idx_ptxn_investment_date_id
                ON portfolio_transactions (investment_id, date, id);
            CREATE INDEX IF NOT EXISTS idx_ptxn_investment_account
                ON portfolio_transactions (investment_id, account_id);
          END IF;
        END $$;
        """
    )

    # 4. Partial index for latest-stamped-balance probes per account.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_transactions_account_stamped
            ON transactions (account_id, date DESC, id DESC)
            WHERE is_active = true AND balance IS NOT NULL;
        """
    )


def downgrade() -> None:
    # Drop the adds (4, 3b, 3a, 2).
    op.execute("DROP INDEX IF EXISTS idx_transactions_account_stamped;")
    # Index names are global (not table-qualified), so a plain drop by name
    # removes the index whichever table the upgrade placed it on.
    op.execute("DROP INDEX IF EXISTS idx_ptxn_investment_date_id;")
    op.execute("DROP INDEX IF EXISTS idx_ptxn_investment_account;")
    op.execute("DROP INDEX IF EXISTS idx_planned_active_executed_date;")
    op.execute("DROP INDEX IF EXISTS idx_transactions_abs_amount_date;")

    # Recreate the two dropped duplicates exactly as originally defined
    # (0001 and 0023 respectively).
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_asset_price_history_investment_date
            ON asset_price_history (investment_id, price_date);
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pps_date_currency
            ON portfolio_performance_snapshots (snapshot_date, currency);
        """
    )
