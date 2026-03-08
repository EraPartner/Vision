"""Add url column to planned_transactions

Revision ID: d4f7a9b8c123
Revises: c1d2e3f4b5a6
Create Date: 2026-02-28 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy_utils import URLType

# revision identifiers, used by Alembic.
revision: str = 'd4f7a9b8c123'
down_revision: Union[str, Sequence[str], None] = 'c1d2e3f4b5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the `url` column to `planned_transactions`.

    The column is nullable to avoid impacting existing rows. We use a
    URLType for proper URL handling and portability across backends.
    """
    op.add_column('planned_transactions', sa.Column('url', URLType(), nullable=True))


def downgrade() -> None:
    """Remove the `url` column from `planned_transactions`."""
    # Use batch_alter_table for SQLite compatibility when dropping columns
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == 'sqlite':
        # SQLite does not support DROP COLUMN; use batch API which recreates table
        with op.batch_alter_table('planned_transactions') as batch_op:
            batch_op.drop_column('url')
    else:
        op.drop_column('planned_transactions', 'url')
