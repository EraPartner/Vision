"""Merge heads: merge 919f058d7d1e and d4f7a9b8c123

Revision ID: e5f6g7h8i901
Revises: 919f058d7d1e, d4f7a9b8c123
Create Date: 2026-02-28 12:30:00.000000

This is a merge revision that unifies two independent branches so Alembic
sees a single head. The revision performs no schema changes.
"""
from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = 'e5f6g7h8i901'
down_revision: Union[str, Sequence[str], None] = ('919f058d7d1e', 'd4f7a9b8c123')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Merge revision: no schema changes."""
    pass


def downgrade() -> None:
    """Downgrade: no-op (merging branches isn't reversible automatically)."""
    pass
