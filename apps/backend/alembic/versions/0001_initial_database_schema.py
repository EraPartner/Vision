"""Initial baseline revision

Revision ID: 0001_initial
Revises: 
Create Date: 2026-02-28 13:00:00.000000

This baseline revision marks the current database schema as the starting point
for Alembic migrations in this repository. It performs no schema changes.
"""
from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '0001_initial'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Baseline no-op."""
    pass


def downgrade() -> None:
    """No-op downgrade for baseline."""
    pass
