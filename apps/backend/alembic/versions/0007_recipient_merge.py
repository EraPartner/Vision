"""Add primary_recipient_id for recipient merging/grouping.

Revision ID: 0007
Revises: 0006
Create Date: 2026-03-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add primary_recipient_id self-referencing FK to recipients table."""
    op.add_column('recipients', sa.Column('primary_recipient_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_recipients_primary_recipient',
        'recipients', 'recipients',
        ['primary_recipient_id'], ['id'],
        ondelete='SET NULL',
    )
    op.create_index('idx_recipients_primary_recipient_id', 'recipients', ['primary_recipient_id'])


def downgrade() -> None:
    """Remove primary_recipient_id column."""
    op.drop_index('idx_recipients_primary_recipient_id', table_name='recipients')
    op.drop_constraint('fk_recipients_primary_recipient', 'recipients', type_='foreignkey')
    op.drop_column('recipients', 'primary_recipient_id')
