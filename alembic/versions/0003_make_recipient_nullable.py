"""Make recipient_id nullable on planned_transactions

Revision ID: 0003_make_recipient_nullable
Revises: 0002_add_url
Create Date: 2026-02-28 13:30:00.000000

Allow planned transactions to be created without an associated recipient.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0003_make_recipient_nullable'
down_revision: Union[str, Sequence[str], None] = '0002_add_url'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Make `recipient_id` nullable.

    Uses batch mode for SQLite to ensure ALTER works correctly.
    """
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == 'sqlite':
        with op.batch_alter_table('planned_transactions') as batch_op:
            batch_op.alter_column('recipient_id', existing_type=sa.Integer(), nullable=True)
    else:
        op.alter_column('planned_transactions', 'recipient_id', existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    """Revert `recipient_id` to NOT NULL.

    This will fail if any rows have NULL `recipient_id`. Run a data migration
    to populate or remove such rows before downgrading.
    """
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Defensive check: prevent making column NOT NULL when NULL values exist
    null_count = 0
    try:
        result = bind.execute(sa.text("SELECT COUNT(*) AS c FROM planned_transactions WHERE recipient_id IS NULL"))
        row = result.fetchone()
        if row is not None:
            null_count = int(row[0])
    except Exception:
        # If the SELECT fails for some dialects, continue and let ALTER raise if necessary
        null_count = 0

    if null_count > 0:
        raise RuntimeError(f"Cannot downgrade: {null_count} planned_transactions have NULL recipient_id. Fix data before downgrading.")

    if dialect == 'sqlite':
        with op.batch_alter_table('planned_transactions') as batch_op:
            batch_op.alter_column('recipient_id', existing_type=sa.Integer(), nullable=False)
    else:
        op.alter_column('planned_transactions', 'recipient_id', existing_type=sa.Integer(), nullable=False)
