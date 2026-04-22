"""Add primary_recipient_id for recipient merging/grouping.

Revision ID: 0007_recipient_merge
Revises: 0006_price_providers
Create Date: 2026-03-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0007_recipient_merge'
down_revision: Union[str, Sequence[str], None] = '0006_price_providers'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add primary_recipient_id self-referencing FK to recipients table."""
    op.execute("""
        ALTER TABLE recipients
        ADD COLUMN IF NOT EXISTS primary_recipient_id INTEGER;
    """)
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'fk_recipients_primary_recipient'
            ) THEN
                ALTER TABLE recipients
                ADD CONSTRAINT fk_recipients_primary_recipient
                FOREIGN KEY (primary_recipient_id)
                REFERENCES recipients(id)
                ON DELETE SET NULL;
            END IF;
        END$$;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_recipients_primary_recipient_id
        ON recipients (primary_recipient_id);
    """)


def downgrade() -> None:
    """Remove primary_recipient_id column."""
    op.drop_index('idx_recipients_primary_recipient_id', table_name='recipients')
    op.drop_constraint('fk_recipients_primary_recipient', 'recipients', type_='foreignkey')
    op.drop_column('recipients', 'primary_recipient_id')
