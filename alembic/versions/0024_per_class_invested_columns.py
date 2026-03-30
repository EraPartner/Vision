"""Add per-asset-class invested columns to portfolio_performance_snapshots

Revision ID: 0024_per_class_invested_columns
Revises: 0023_portfolio_performance_snapshots
Create Date: 2026-03-30
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0024_per_class_invested_columns'
down_revision: Union[str, Sequence[str], None] = '0023_portfolio_performance_snapshots'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            ADD COLUMN IF NOT EXISTS stocks_etfs_invested NUMERIC(18, 6) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS crypto_invested NUMERIC(18, 6) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS metals_invested NUMERIC(18, 6) NOT NULL DEFAULT 0;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            DROP COLUMN IF EXISTS stocks_etfs_invested,
            DROP COLUMN IF EXISTS crypto_invested,
            DROP COLUMN IF EXISTS metals_invested;
    """)
