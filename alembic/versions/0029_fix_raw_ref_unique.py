"""Fix transaction_raw_references: allow multiple raw sources per transaction

Revision ID: 0029_fix_raw_ref_unique
Revises: 0028_split_amount_check
Create Date: 2026-05-05

The original schema put a single-column UNIQUE on transaction_id, making it a
1:1 mapping between a processed transaction and its raw source. This blocks
multi-source matching (e.g. a reconciled transaction confirmed against both a
CSV import and a manual raw entry). Replaced with a composite UNIQUE on
(transaction_id, raw_source_type, raw_source_id) to prevent exact duplicate
source links while allowing multiple distinct raw sources per transaction.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0029_fix_raw_ref_unique'
down_revision: Union[str, Sequence[str], None] = '0028_split_amount_check'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text("""
        ALTER TABLE transaction_raw_references
            DROP CONSTRAINT IF EXISTS transaction_raw_references_transaction_id_key
    """))
    op.execute(sa.text("""
        ALTER TABLE transaction_raw_references
            ADD CONSTRAINT uq_raw_ref_txn_source
            UNIQUE (transaction_id, raw_source_type, raw_source_id)
    """))


def downgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE transaction_raw_references "
        "DROP CONSTRAINT IF EXISTS uq_raw_ref_txn_source"
    ))
    op.execute(sa.text("""
        ALTER TABLE transaction_raw_references
            ADD CONSTRAINT transaction_raw_references_transaction_id_key
            UNIQUE (transaction_id)
    """))
