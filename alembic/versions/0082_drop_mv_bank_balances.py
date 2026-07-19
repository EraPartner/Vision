"""Drop mv_bank_balances — a dead materialized view with zero readers.

Revision ID: 0082_drop_mv_bank_balances
Revises: 0081_portfolio_batch_complete_with_errors
Create Date: 2026-07-19

`mv_bank_balances` (an all-time `SUM(amount) GROUP BY account_id, currency` over
`transactions`) was refreshed after every transaction mutation, both import
paths, the DB editor, maintenance refresh, and boot warmup — one of the two
all-time table scans paid per edit — yet nothing reads it. A grep across `apps/`
finds only its creator/refresher, its own test, and comments; the two candidate
consumers (the bank-balances widget and account-balance computation) run live SQL
instead, and ADR-094 explicitly rejected this view's `Σ(amount)` semantics as
wrong (it drops opening balances). Its grain is also the deprecated `bank_account`
string on older installs.

The materialized-view service no longer creates, indexes, or refreshes it, so this
drops the view (its unique index drops with it via CASCADE), halving the all-time
refresh work per mutation with zero behavior change. Same precedent as
`mv_recipient_monthly` (migration 0038) and `agg_recipient_totals` (migration 0080).

Downgrade recreates the view WITH NO DATA on its current `(account_id, currency)`
grain plus its unique index (matching the definition the service used immediately
before this migration); the next boot / mutation would have refreshed it. Nothing
depends on it, so recreating it empty is safe.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0082_drop_mv_bank_balances"
down_revision: Union[str, Sequence[str], None] = "0081_portfolio_batch_complete_with_errors"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The unique index mv_bank_balances_idx is owned by the view — CASCADE drops it too.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_bank_balances CASCADE;")


def downgrade() -> None:
    op.execute(
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_bank_balances AS
        SELECT
          t.account_id,
          a.name AS bank_account,
          t.currency,
          COUNT(*) AS transaction_count,
          MIN(t.date) AS first_transaction,
          MAX(t.date) AS last_transaction,
          SUM(t.amount) AS balance
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.is_active = true AND t.account_id IS NOT NULL
        GROUP BY t.account_id, a.name, t.currency
        ORDER BY a.name
        WITH NO DATA;
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS mv_bank_balances_idx
          ON mv_bank_balances (account_id, currency);
        """
    )
