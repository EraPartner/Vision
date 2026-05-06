"""Fix NUMERIC(15,2) precision on transactions.amount to NUMERIC(18,4)

Revision ID: 0025_fix_numeric_precision
Revises: 0024_add_manual_raw_transaction_fks
Create Date: 2026-05-05

NUMERIC(15,2) caps at 13 integer digits and 2 decimal places. Financial
amounts that need 4 decimal places (e.g. micro-transactions, crypto) are
silently truncated. NUMERIC(18,4) provides 14 integer digits and 4 decimal
places without changing storage for existing integer-cent values.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0025_fix_numeric_precision'
down_revision: Union[str, Sequence[str], None] = '0024_add_manual_raw_transaction_fks'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_VIEWS_DDL = [
    (
        'mv_monthly_summary',
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_summary AS
        SELECT
          date_trunc('month', t.date)::date AS month_start,
          EXTRACT(MONTH FROM t.date)::int   AS month,
          EXTRACT(YEAR  FROM t.date)::int   AS year,
          t.currency,
          COUNT(*) AS transaction_count,
          SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS total_income,
          SUM(CASE WHEN t.amount  < 0 THEN t.amount ELSE 0 END) AS total_spending,
          SUM(t.amount)                                          AS net_amount,
          c.id AS category_id,
          COALESCE(c.id, -1)                                     AS category_id_key,
          COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS category_name
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
        WHERE t.is_active = true
          AND t.date >= date_trunc('month', CURRENT_DATE) - interval '12 months'
        GROUP BY month_start, month, year, t.currency, c.id, category_name
        ORDER BY month_start
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS mv_monthly_summary_idx "
        "ON mv_monthly_summary (month_start, currency, category_id_key)",
    ),
    (
        'mv_category_totals',
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_category_totals AS
        SELECT
          COALESCE(c.id, -1)                                     AS category_id,
          COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name,
          COUNT(*) AS count,
          SUM(t.amount) AS total,
          t.currency
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
        WHERE t.is_active = true
        GROUP BY
          COALESCE(c.id, -1),
          COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED'),
          t.currency
        ORDER BY count DESC
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS mv_category_totals_idx "
        "ON mv_category_totals (category_id, currency)",
    ),
    (
        'mv_cashflow_daily',
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cashflow_daily AS
        SELECT
          t.date,
          EXTRACT(DAY FROM t.date)::int         AS day_of_month,
          date_trunc('month', t.date)::date      AS month_start,
          t.currency,
          SUM(t.amount) AS net
        FROM transactions t
        WHERE t.is_active = true
          AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        GROUP BY t.date, day_of_month, month_start, t.currency
        ORDER BY t.date
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS mv_cashflow_daily_idx "
        "ON mv_cashflow_daily (date, currency)",
    ),
    (
        'mv_bank_balances',
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_bank_balances AS
        SELECT
          bank_account,
          t.currency,
          COUNT(*) AS transaction_count,
          MIN(t.date) AS first_transaction,
          MAX(t.date) AS last_transaction,
          SUM(t.amount) AS balance
        FROM transactions t
        WHERE t.is_active = true AND bank_account IS NOT NULL
        GROUP BY bank_account, t.currency
        ORDER BY bank_account
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS mv_bank_balances_idx "
        "ON mv_bank_balances (bank_account, currency)",
    ),
]


def _drop_views(conn) -> None:
    for name, _, _ in reversed(_VIEWS_DDL):
        conn.execute(sa.text(f"DROP MATERIALIZED VIEW IF EXISTS {name} CASCADE"))


def _create_views(conn) -> None:
    for _, view_ddl, index_ddl in _VIEWS_DDL:
        conn.execute(sa.text(view_ddl))
        conn.execute(sa.text(index_ddl))


def upgrade() -> None:
    conn = op.get_bind()
    _drop_views(conn)
    conn.execute(sa.text(
        "ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(18,4)"
    ))
    _create_views(conn)


def downgrade() -> None:
    conn = op.get_bind()
    _drop_views(conn)
    conn.execute(sa.text(
        "ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(15,2)"
    ))
    _create_views(conn)
