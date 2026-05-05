"""Fix NUMERIC(15,2) precision on transactions.amount to NUMERIC(18,4)

Revision ID: 0025_fix_numeric_precision
Revises: 0024_add_manual_raw_transaction_fks
Create Date: 2026-05-05

NUMERIC(15,2) caps at 13 integer digits and 2 decimal places. Financial
amounts that need 4 decimal places (e.g. micro-transactions, crypto) are
silently truncated. NUMERIC(18,4) provides 14 integer digits and 4 decimal
places without changing storage for existing integer-cent values.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0025_fix_numeric_precision'
down_revision: Union[str, Sequence[str], None] = '0024_add_manual_raw_transaction_fks'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(18,4)"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(15,2)"
    ))
