"""Add price provider fields to investments table

Revision ID: 0006_price_providers
Revises: 0005_manual_raw_transactions
Create Date: 2026-03-08

Adds price_provider and price_provider_id columns to investments table
for live price fetching from CoinGecko, Yahoo Finance, Kraken, or custom JSON endpoints.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0006_price_providers'
down_revision: Union[str, Sequence[str], None] = '0005_manual_raw_transactions'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            CREATE TYPE price_provider AS ENUM (
                'manual', 'coingecko', 'yahoo', 'kraken', 'custom'
            );
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END$$;
    """)
    op.execute("""
        ALTER TABLE investments
        ADD COLUMN IF NOT EXISTS price_provider price_provider NOT NULL DEFAULT 'manual';
    """)
    op.execute("""
        ALTER TABLE investments
        ADD COLUMN IF NOT EXISTS price_provider_id VARCHAR(200);
    """)
    op.execute("""
        ALTER TABLE investments
        ADD COLUMN IF NOT EXISTS price_provider_url VARCHAR(500);
    """)
    op.execute("""
        ALTER TABLE investments
        ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMPTZ;
    """)


def downgrade() -> None:
    op.drop_column('investments', 'price_updated_at')
    op.drop_column('investments', 'price_provider_url')
    op.drop_column('investments', 'price_provider_id')
    op.drop_column('investments', 'price_provider')
    op.execute("DROP TYPE IF EXISTS price_provider;")
