"""Add persistent asset historical quote cache table

Revision ID: 0019_asset_price_history_cache
Revises: 0018_metals_transactions_inheritance_split
Create Date: 2026-03-27
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0019_asset_price_history_cache'
down_revision: Union[str, Sequence[str], None] = '0018_metals_transactions_inheritance_split'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS asset_price_history (
            id SERIAL PRIMARY KEY,
            investment_id INTEGER NOT NULL,
            price_date DATE NOT NULL,
            close_price NUMERIC(18, 6) NOT NULL,
            source VARCHAR(50) NOT NULL DEFAULT 'provider',
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ,
            CONSTRAINT uq_asset_price_history_investment_date UNIQUE (investment_id, price_date)
        );
    """)

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_constraint c
                JOIN pg_class r ON r.oid = c.confrelid
                WHERE c.conname = 'fk_asset_price_history_investment'
                  AND c.conrelid = 'asset_price_history'::regclass
                  AND r.relname = 'investments_base'
            ) THEN
                ALTER TABLE asset_price_history
                  DROP CONSTRAINT fk_asset_price_history_investment;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint c
                WHERE c.conname = 'fk_asset_price_history_investment'
                  AND c.conrelid = 'asset_price_history'::regclass
            ) AND EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'investments'
                  AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE asset_price_history
                  ADD CONSTRAINT fk_asset_price_history_investment
                  FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE;
            END IF;
        END $$;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_asset_price_history_investment_date
            ON asset_price_history (investment_id, price_date);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_asset_price_history_date
            ON asset_price_history (price_date);
    """)

    op.execute("""
        DO $$
        BEGIN
            CREATE TRIGGER update_asset_price_history_updated_at
                BEFORE UPDATE ON asset_price_history
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END $$;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS asset_price_history CASCADE;")
