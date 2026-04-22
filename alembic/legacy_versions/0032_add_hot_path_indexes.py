"""Add hot-path covering index for category+recipient aggregation queries.

Revision ID: 0032_add_hot_path_indexes
Revises: 0031_ai_chat_tables
Create Date: 2026-04-20

The existing ``idx_transactions_active`` partial index already covers the
top-level ``(date DESC) WHERE is_active = true`` hot path, and 0012
covers the per-entity ``(<entity>, date DESC) WHERE is_active = true``
variants. What's missing is a covering index for the combined
category+recipient filter used by several infoRepository aggregations
that group by both dimensions at once.
"""
from typing import Sequence, Union

from alembic import op


revision: str = '0032_add_hot_path_indexes'
down_revision: Union[str, Sequence[str], None] = '0031_ai_chat_tables'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_transactions_category_recipient_active
          ON transactions (category_id, recipient_id)
          WHERE is_active = true;
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX IF EXISTS idx_transactions_category_recipient_active;
    """)
