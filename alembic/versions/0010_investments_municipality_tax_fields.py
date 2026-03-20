"""Add municipality tax fields to investments

Revision ID: 0010_inv_muni_tax
Revises: 0009_transaction_splits
Create Date: 2026-03-13

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0010_inv_muni_tax'
down_revision: Union[str, Sequence[str], None] = '0009_transaction_splits'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add municipality, cadastral income, and municipality tax rate fields."""
    op.execute("""
        ALTER TABLE investments
            ADD COLUMN IF NOT EXISTS municipality VARCHAR(200),
            ADD COLUMN IF NOT EXISTS cadastral_income NUMERIC(12,2),
            ADD COLUMN IF NOT EXISTS municipality_tax_rate NUMERIC(8,4);
    """)


def downgrade() -> None:
    """Remove municipality tax related fields from investments."""
    op.execute("""
        ALTER TABLE investments
            DROP COLUMN IF EXISTS municipality_tax_rate,
            DROP COLUMN IF EXISTS cadastral_income,
            DROP COLUMN IF EXISTS municipality;
    """)
