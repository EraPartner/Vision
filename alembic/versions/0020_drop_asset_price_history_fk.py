"""Drop asset_price_history foreign key for inheritance compatibility

Revision ID: 0020_drop_asset_price_history_fk
Revises: 0019_asset_price_history_cache
Create Date: 2026-03-27
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0020_drop_asset_price_history_fk'
down_revision: Union[str, Sequence[str], None] = '0019_asset_price_history_cache'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'fk_asset_price_history_investment'
                  AND conrelid = 'asset_price_history'::regclass
            ) THEN
                ALTER TABLE asset_price_history
                  DROP CONSTRAINT fk_asset_price_history_investment;
            END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'fk_asset_price_history_investment'
                  AND conrelid = 'asset_price_history'::regclass
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
