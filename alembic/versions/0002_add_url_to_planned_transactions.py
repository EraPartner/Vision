"""Add url column to planned_transactions

Revision ID: 0002_add_url
Revises: 0001_initial
Create Date: 2026-02-28 13:05:00.000000

Adds a nullable URL column to planned_transactions using SQLAlchemy-Utils URLType.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy_utils import URLType

# revision identifiers, used by Alembic.
revision: str = '0002_add_url'
down_revision: Union[str, Sequence[str], None] = '0001_initial'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the `url` column to `planned_transactions`.

    The column is nullable to avoid impacting existing rows.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('planned_transactions'):
        return

    existing_columns = {column['name'] for column in inspector.get_columns('planned_transactions')}
    if 'url' in existing_columns:
        return

    op.add_column('planned_transactions', sa.Column('url', URLType(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name
    inspector = sa.inspect(bind)

    if not inspector.has_table('planned_transactions'):
        return

    existing_columns = {column['name'] for column in inspector.get_columns('planned_transactions')}
    if 'url' not in existing_columns:
        return

    if dialect == 'sqlite':
        with op.batch_alter_table('planned_transactions') as batch_op:
            batch_op.drop_column('url')
    else:
        op.drop_column('planned_transactions', 'url')
