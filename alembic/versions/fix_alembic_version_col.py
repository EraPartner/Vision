"""Fix alembic_version column size and rename long revision IDs

Revision ID: fix_avc_col
Revises: 0012_add_indexes
Create Date: 2026-03-20

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'fix_avc_col'
down_revision: Union[str, Sequence[str], None] = '0012_add_indexes'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Fix alembic_version column size and rename long revision IDs."""
    # Expand version_num column to VARCHAR(64) to support longer revision IDs
    op.execute("""
        ALTER TABLE alembic_version 
        ALTER COLUMN version_num TYPE VARCHAR(64)
    """)

    # Rename any existing long revision IDs to shorter aliases
    # This handles databases that already have the long IDs stored
    op.execute("""
        UPDATE alembic_version 
        SET version_num = 'fix_avc'
        WHERE version_num = 'fix_alembic_version_col'
    """)


def downgrade() -> None:
    """Revert to original column size (may truncate long IDs)."""
    op.execute("""
        ALTER TABLE alembic_version 
        ALTER COLUMN version_num TYPE VARCHAR(32)
    """)
