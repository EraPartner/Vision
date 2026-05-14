"""Add tx_hash to transactions with a partial unique index for import dedup.

Revision ID: 0036_add_transactions_tx_hash
Revises: 0035_add_recipient_aggregations
Create Date: 2026-05-14

The import pipeline computes a per-row `tx_hash` in `import_staging_rows` but
never carried it through to `transactions`. Without a unique guard, the
field-based duplicate check in `commitBatch` / `processRawImportRow` is a
check-then-insert race: a concurrent import (or a re-submitted batch) could
slip an identical row past the SELECT and insert a duplicate.

This adds a nullable `tx_hash TEXT` column plus a *partial* unique index over
`tx_hash IS NOT NULL`. Partial is deliberate:
  - Pre-existing rows and manually-entered transactions keep `tx_hash = NULL`
    and are excluded from the constraint, so the migration cannot fail on
    historical duplicates.
  - New import-pipeline inserts stamp `tx_hash` and gain a real race-safe
    `ON CONFLICT (tx_hash) DO NOTHING` target.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0036_add_transactions_tx_hash'
down_revision: Union[str, Sequence[str], None] = '0035_add_recipient_aggregations'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS tx_hash TEXT;
    """)

    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_tx_hash
        ON transactions (tx_hash)
        WHERE tx_hash IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uniq_transactions_tx_hash;")
    op.execute("ALTER TABLE transactions DROP COLUMN IF EXISTS tx_hash;")
