"""Add portfolio performance snapshots table

Revision ID: 0023_portfolio_performance_snapshots
Revises: 0022_price_provider_kinesis
Create Date: 2026-03-29
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0023_portfolio_performance_snapshots'
down_revision: Union[str, Sequence[str], None] = '0022_price_provider_kinesis'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS portfolio_performance_snapshots (
            id SERIAL PRIMARY KEY,
            snapshot_date DATE NOT NULL UNIQUE,
            invested NUMERIC(18, 6) NOT NULL DEFAULT 0,
            value NUMERIC(18, 6) NOT NULL DEFAULT 0,
            stocks_etfs_value NUMERIC(18, 6) NOT NULL DEFAULT 0,
            crypto_value NUMERIC(18, 6) NOT NULL DEFAULT 0,
            metals_value NUMERIC(18, 6) NOT NULL DEFAULT 0,
            cash_value NUMERIC(18, 6) NOT NULL DEFAULT 0,
            gain_loss NUMERIC(18, 6) NOT NULL DEFAULT 0,
            return_pct NUMERIC(10, 4) NOT NULL DEFAULT 0,
            inflation_adjusted_value NUMERIC(18, 6) NOT NULL DEFAULT 0,
            cumulative_inflation NUMERIC(10, 4) NOT NULL DEFAULT 1,
            real_return_pct NUMERIC(10, 4) NOT NULL DEFAULT 0,
            currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_portfolio_performance_snapshots_date
            ON portfolio_performance_snapshots (snapshot_date);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_portfolio_performance_snapshots_currency
            ON portfolio_performance_snapshots (currency);
    """)

    op.execute("""
        DO $$
        BEGIN
            CREATE TRIGGER update_portfolio_performance_snapshots_computed_at
                BEFORE UPDATE ON portfolio_performance_snapshots
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END $$;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS portfolio_performance_snapshots CASCADE;")
