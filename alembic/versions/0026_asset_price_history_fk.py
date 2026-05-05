"""Add FK constraint on asset_price_history.investment_id

Revision ID: 0026_asset_price_history_fk
Revises: 0025_fix_numeric_precision
Create Date: 2026-05-05

asset_price_history.investment_id was a plain INTEGER with no FK reference,
allowing orphan price rows after an investment is deleted. Adds REFERENCES
investments(id) ON DELETE CASCADE and cleans up any existing orphans first.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0026_asset_price_history_fk'
down_revision: Union[str, Sequence[str], None] = '0025_fix_numeric_precision'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Remove orphan rows before enforcing the constraint
    op.execute(sa.text("""
        DELETE FROM asset_price_history
        WHERE investment_id NOT IN (SELECT id FROM investments)
    """))
    op.execute(sa.text("""
        ALTER TABLE asset_price_history
            ADD CONSTRAINT fk_aph_investment
            FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
    """))


def downgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE asset_price_history DROP CONSTRAINT IF EXISTS fk_aph_investment"
    ))
