"""Add exchange_rate_cache table for arbitrary FX pair caching

Revision ID: 0025_exchange_rate_cache
Revises: 0024_per_class_invested_columns
Create Date: 2026-04-16

Supports Phase 0 of the non-portfolio refactor: Postgres-backed FX cache that
complements the existing `exchange_rates` (X -> EUR only) by caching any
from_ccy/to_ccy pair for a specific date. This replaces the in-memory cross
conversion math that currently lives in currencyConversionService.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0025_exchange_rate_cache'
down_revision: Union[str, Sequence[str], None] = '0024_per_class_invested_columns'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS exchange_rate_cache (
            id SERIAL PRIMARY KEY,
            from_ccy CHAR(3) NOT NULL,
            to_ccy CHAR(3) NOT NULL,
            rate_date DATE NOT NULL,
            rate NUMERIC(20, 10) NOT NULL,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_exchange_rate_cache_pair_date
                UNIQUE (from_ccy, to_ccy, rate_date),
            CONSTRAINT ck_exchange_rate_cache_rate_positive
                CHECK (rate > 0)
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_exchange_rate_cache_date
            ON exchange_rate_cache (rate_date);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_exchange_rate_cache_from_to
            ON exchange_rate_cache (from_ccy, to_ccy);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS exchange_rate_cache CASCADE;")
