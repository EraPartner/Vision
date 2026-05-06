"""Add FK constraints to manual_raw_transactions

manual_raw_transactions.transaction_id / recipient_id / category_id were plain
INTEGER columns with no FK references, allowing orphan rows on parent deletes.

Revision ID: 0024_add_manual_raw_transaction_fks
Revises: 0023_fix_portfolio_snapshots_constraint
Create Date: 2026-05-05
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0024_add_manual_raw_transaction_fks'
down_revision: Union[str, Sequence[str], None] = '0023_fix_portfolio_snapshots_constraint'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Clean up any existing orphan rows before adding FK constraints.
    op.execute("""
        UPDATE manual_raw_transactions
           SET transaction_id = NULL
         WHERE transaction_id IS NOT NULL
           AND transaction_id NOT IN (SELECT id FROM transactions);
    """)
    op.execute("""
        UPDATE manual_raw_transactions
           SET recipient_id = NULL
         WHERE recipient_id IS NOT NULL
           AND recipient_id NOT IN (SELECT id FROM recipients);
    """)
    op.execute("""
        UPDATE manual_raw_transactions
           SET category_id = NULL
         WHERE category_id IS NOT NULL
           AND category_id NOT IN (SELECT id FROM categories);
    """)

    op.execute("""
        ALTER TABLE manual_raw_transactions
            ADD CONSTRAINT fk_mrt_transaction
                FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
    """)
    op.execute("""
        ALTER TABLE manual_raw_transactions
            ADD CONSTRAINT fk_mrt_recipient
                FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE SET NULL;
    """)
    op.execute("""
        ALTER TABLE manual_raw_transactions
            ADD CONSTRAINT fk_mrt_category
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE manual_raw_transactions DROP CONSTRAINT IF EXISTS fk_mrt_transaction;")
    op.execute("ALTER TABLE manual_raw_transactions DROP CONSTRAINT IF EXISTS fk_mrt_recipient;")
    op.execute("ALTER TABLE manual_raw_transactions DROP CONSTRAINT IF EXISTS fk_mrt_category;")
