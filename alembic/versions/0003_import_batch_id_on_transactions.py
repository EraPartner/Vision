"""Add import_batch_id FK to transactions for rollback support.

Revision ID: 0003_import_batch_id_on_transactions
Revises: 0002_feature_flags
Create Date: 2026-04-24

Links each committed transaction to the import batch that created it.
NULL for manually-entered or pre-pipeline transactions.

Enables:
  - DELETE /api/import/batches/:id  → deletes associated transactions
  - Import history: count remaining transactions per batch
  - Rollback: soft-undo an entire CSV import in one request

ON DELETE SET NULL preserves transactions if batch row is manually
deleted from the DB.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0003_import_batch_id_on_transactions'
down_revision: Union[str, Sequence[str], None] = '0002_feature_flags'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS import_batch_id BIGINT
                REFERENCES import_batches(id) ON DELETE SET NULL;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_transactions_import_batch_id
        ON transactions (import_batch_id)
        WHERE import_batch_id IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_transactions_import_batch_id;")
    op.execute("ALTER TABLE transactions DROP COLUMN IF EXISTS import_batch_id;")
