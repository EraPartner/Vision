"""Add CHECK (amount > 0) to transaction_splits and split_payments

Revision ID: 0028_split_amount_check
Revises: 0027_fix_attachments_bigint
Create Date: 2026-05-05

Split amounts must always be positive: a split with amount ≤ 0 is a data
error. The constraint is added as NOT VALID first to skip a full table scan
on large tables, then validated in a second step (which holds only a share
lock, not an exclusive lock).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0028_split_amount_check'
down_revision: Union[str, Sequence[str], None] = '0027_fix_attachments_bigint'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text("""
        ALTER TABLE transaction_splits
            ADD CONSTRAINT chk_split_amount_positive CHECK (amount > 0) NOT VALID
    """))
    op.execute(sa.text(
        "ALTER TABLE transaction_splits VALIDATE CONSTRAINT chk_split_amount_positive"
    ))

    op.execute(sa.text("""
        ALTER TABLE split_payments
            ADD CONSTRAINT chk_split_payment_amount_positive CHECK (amount > 0) NOT VALID
    """))
    op.execute(sa.text(
        "ALTER TABLE split_payments VALIDATE CONSTRAINT chk_split_payment_amount_positive"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE transaction_splits "
        "DROP CONSTRAINT IF EXISTS chk_split_amount_positive"
    ))
    op.execute(sa.text(
        "ALTER TABLE split_payments "
        "DROP CONSTRAINT IF EXISTS chk_split_payment_amount_positive"
    ))
