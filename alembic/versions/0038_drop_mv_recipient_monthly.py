"""Drop mv_recipient_monthly (unread materialized view)

Revision ID: 0038_drop_mv_recipient_monthly
Revises: 0037_add_custom_parser_configs
Create Date: 2026-06-01

`mv_recipient_monthly` (added in 0035) was refreshed on every transaction
mutation but never read: the recipient-insight endpoints
(getRecipientInsights / getRecipientByYear / getRecipientPivot) run live scans.
Its monthly granularity also cannot reproduce those reads exactly — they use
per-transaction-date FX, exact first/last-seen dates, and spending-only counts —
so it could not be wired in without changing financial outputs.

Rather than keep paying a REFRESH MATERIALIZED VIEW on every mutation for a view
nothing reads, we drop it. The application no longer refreshes it
(aggregationRefresh.js). The companion `agg_recipient_totals` table and its
triggers are unaffected.

Rollback recreates the original 24-month-windowed view + unique index exactly as
0035 defined it, so downgrading restores the prior schema.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0038_drop_mv_recipient_monthly'
down_revision: Union[str, Sequence[str], None] = '0037_add_custom_parser_configs'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # CASCADE also removes mv_recipient_monthly_idx.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_recipient_monthly CASCADE;")


def downgrade() -> None:
    op.execute("""
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_recipient_monthly AS
        SELECT
            date_trunc('month', t.date)::date     AS month_start,
            EXTRACT(YEAR FROM t.date)::int         AS year,
            EXTRACT(MONTH FROM t.date)::int        AS month,
            COALESCE(r.primary_recipient_id, t.recipient_id) AS recipient_id,
            t.currency                             AS currency,
            COUNT(*)                               AS transaction_count,
            SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS total_income,
            SUM(CASE WHEN t.amount <  0 THEN t.amount ELSE 0 END) AS total_spending,
            SUM(t.amount)                          AS net_amount
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        WHERE t.is_active = true
          AND t.date >= date_trunc('month', CURRENT_DATE) - interval '24 months'
        GROUP BY
            month_start, year, month,
            COALESCE(r.primary_recipient_id, t.recipient_id),
            t.currency
        WITH NO DATA;
    """)
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS mv_recipient_monthly_idx
            ON mv_recipient_monthly (month_start, recipient_id, currency);
    """)
    op.execute("REFRESH MATERIALIZED VIEW mv_recipient_monthly;")
