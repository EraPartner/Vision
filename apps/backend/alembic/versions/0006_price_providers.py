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
        CREATE TYPE price_provider AS ENUM (
            'manual', 'coingecko', 'yahoo', 'kraken', 'custom'
        );
    """)
    op.add_column('investments', sa.Column('price_provider', sa.Enum('manual', 'coingecko', 'yahoo', 'kraken', 'custom', name='price_provider'), server_default='manual', nullable=False))
    op.add_column('investments', sa.Column('price_provider_id', sa.String(200), nullable=True))
    op.add_column('investments', sa.Column('price_provider_url', sa.String(500), nullable=True))
    op.add_column('investments', sa.Column('price_updated_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('investments', 'price_updated_at')
    op.drop_column('investments', 'price_provider_url')
    op.drop_column('investments', 'price_provider_id')
    op.drop_column('investments', 'price_provider')
    op.execute("DROP TYPE IF EXISTS price_provider;")
