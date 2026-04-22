"""Add gift to portfolio transaction type enum

Revision ID: 0015_add_gift_portfolio_txn_type
Revises: 0014_investments_view_update_trigger
Create Date: 2026-03-24
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0015_add_gift_portfolio_txn_type'
down_revision: Union[str, Sequence[str], None] = '0014_investments_view_update_trigger'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_enum e
                JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = 'portfolio_txn_type'
                  AND e.enumlabel = 'gift'
            ) THEN
                ALTER TYPE portfolio_txn_type ADD VALUE 'gift';
            END IF;
        END$$;
    """)


def downgrade() -> None:
    # PostgreSQL enums cannot safely drop a single value in-place.
    pass
