"""Add missing indexes for joins and active queries

Revision ID: 0012_add_indexes
Revises: 0011_planned_loans
Create Date: 2026-03-13

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0012_add_indexes'
down_revision: Union[str, Sequence[str], None] = '0011_planned_loans'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Index FK for joins on recipient bank account
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_transactions_recipient_bank_account_id
          ON transactions (recipient_bank_account_id);

        -- Partial variants optimized for the common case: active rows per-entity ordered by date
        CREATE INDEX IF NOT EXISTS idx_transactions_recipient_date_active
          ON transactions (recipient_id, date DESC) WHERE is_active = true;

        CREATE INDEX IF NOT EXISTS idx_transactions_category_date_active
          ON transactions (category_id, date DESC) WHERE is_active = true;

        CREATE INDEX IF NOT EXISTS idx_transactions_bank_date_active
          ON transactions (bank_account, date DESC) WHERE is_active = true;

        -- Support reverse lookup: find the planned execution(s) for a given executed transaction
        CREATE INDEX IF NOT EXISTS idx_pte_executed_tx_id
          ON planned_transaction_executions (executed_transaction_id);

        -- Index the manual_raw_transactions.transaction_id column to speed joins/lookups
        CREATE INDEX IF NOT EXISTS idx_manual_transaction_id
          ON manual_raw_transactions (transaction_id);
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX IF EXISTS idx_transactions_recipient_bank_account_id;
        DROP INDEX IF EXISTS idx_transactions_recipient_date_active;
        DROP INDEX IF EXISTS idx_transactions_category_date_active;
        DROP INDEX IF EXISTS idx_transactions_bank_date_active;
        DROP INDEX IF EXISTS idx_pte_executed_tx_id;
        DROP INDEX IF EXISTS idx_manual_transaction_id;
    """)
