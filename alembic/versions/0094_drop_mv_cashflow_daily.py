"""Drop mv_cashflow_daily, a derived view with zero readers.

Revision ID: 0094_drop_mv_cashflow_daily
Revises: 0093_cashflow_cache_date_types
Create Date: 2026-09-04

The runtime service created, indexed, analyzed, and refreshed this seven-month
daily aggregate after every relevant mutation, but no application query reads
it. Current cash-flow charts use repository queries and forecast cache tables.
The service stops managing it in the same release, following the zero-reader
precedent for mv_recipient_monthly (0038) and mv_bank_balances (0082).

Downgrade restores the last historical definition WITH NO DATA and its unique
index. It remains outside the current runtime-managed set after downgrade, so a
manual refresh would be required before querying the restored rollback object.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0094_drop_mv_cashflow_daily"
down_revision: Union[str, Sequence[str], None] = "0093_cashflow_cache_date_types"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # destructive-ok: this is a derived projection with zero readers; the
    # coupled runtime change no longer creates or refreshes it. CASCADE also
    # removes its owned unique index. Downgrade restores the historical shape.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_cashflow_daily CASCADE;")


def downgrade() -> None:
    op.execute(
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cashflow_daily AS
        SELECT
          t.date,
          EXTRACT(DAY FROM t.date)::int AS day_of_month,
          date_trunc('month', t.date)::date AS month_start,
          t.currency,
          SUM(t.amount) AS net
        FROM transactions t
        WHERE t.is_active = true AND t.is_transfer = false
          AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        GROUP BY t.date, day_of_month, month_start, t.currency
        ORDER BY t.date
        WITH NO DATA;
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cashflow_daily
          ON mv_cashflow_daily (date, currency);
        """
    )
