"""Fix portfolio_performance_snapshots: composite UNIQUE + drop broken trigger

Fixes two CRITICAL bugs from round-2 bug hunt:
1. snapshot_date UNIQUE → UNIQUE (snapshot_date, currency) for multi-currency support
2. Drop trigger that called update_updated_at_column() on a table without updated_at

Revision ID: 0023_fix_portfolio_snapshots_constraint
Revises: 0022_updated_at_not_null_defaults
Create Date: 2026-05-05
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0023_fix_portfolio_snapshots_constraint'
down_revision: Union[str, Sequence[str], None] = '0022_updated_at_not_null_defaults'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Drop the wrong single-column constraint
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            DROP CONSTRAINT IF EXISTS portfolio_performance_snapshots_snapshot_date_key;
    """)

    # 2. Add correct composite constraint
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            ADD CONSTRAINT uq_pps_date_currency UNIQUE (snapshot_date, currency);
    """)

    # 3. Drop the broken trigger that references updated_at (column doesn't exist)
    # destructive-ok: shipped 2026-05-05, annotated retroactively. The trigger was already
    # non-functional — it referenced an updated_at column that does not exist on this table, so it
    # raised on every UPDATE. Dropping it removes a fault, not behaviour. No data touched.
    op.execute("""
        DROP TRIGGER IF EXISTS update_portfolio_performance_snapshots_computed_at
            ON portfolio_performance_snapshots;
    """)

    # 4. Replace the single-date index with a composite one that covers the new constraint
    op.execute("""
        DROP INDEX IF EXISTS idx_portfolio_performance_snapshots_date;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pps_date_currency
            ON portfolio_performance_snapshots (snapshot_date, currency);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pps_date_currency;")
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_portfolio_performance_snapshots_date
            ON portfolio_performance_snapshots (snapshot_date);
    """)
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            DROP CONSTRAINT IF EXISTS uq_pps_date_currency;
    """)
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            ADD CONSTRAINT portfolio_performance_snapshots_snapshot_date_key UNIQUE (snapshot_date);
    """)
