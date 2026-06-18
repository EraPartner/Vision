"""Trade cash legs: transactions.portfolio_transaction_id + transfer_source='trade' (ADR-090).

Revision ID: 0053_trade_cash_legs
Revises: 0052_portfolio_transactions_account_id
Create Date: 2026-06-18

ADR-090 models a trade's cash movement as a paired `transactions` row (the cash leg) on the
account's sleeve, linked to its trade and isolated from the ADR-083 transfer reconciler:

  - `transactions.portfolio_transaction_id` → a plain INTEGER referencing a portfolio transaction
    id. It is intentionally NOT a foreign key: under the table-inheritance schema (ADR-004)
    `portfolio_transactions` is a VIEW and the real rows live in per-asset-class child tables, so a
    FK can reference neither the view nor (usefully) the inherited base — a PostgreSQL limitation.
    The trade→leg cascade on delete is therefore handled in app code (deleting a portfolio
    transaction deletes its cash legs), not by ON DELETE CASCADE.
  - Extend `ck_transactions_transfer_source` (on the real `transactions` table) to allow 'trade'.
    Trade legs are is_transfer=true (so the `AND NOT is_transfer` exclusion keeps them out of
    income/spending) AND transfer_source='trade' — which the ADR-083 reconciler never touches
    (it only acts on transfer_source IS NULL or = 'auto'), so a single-sided trade leg is never
    wrongly released as an orphan.

Blast radius: one nullable column + one partial index + a CHECK swap on transactions. No row
rewrite. Downgrade drops the index/column and restores the auto|manual-only CHECK.

NOTE: migrations are not auto-run by the agent — authored here; applied on the next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0053_trade_cash_legs"
down_revision: Union[str, Sequence[str], None] = (
    "0052_portfolio_transactions_account_id"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS portfolio_transaction_id INTEGER;

        CREATE INDEX IF NOT EXISTS idx_transactions_portfolio_txn
            ON transactions (portfolio_transaction_id)
            WHERE portfolio_transaction_id IS NOT NULL;

        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual'));

        DROP INDEX IF EXISTS idx_transactions_portfolio_txn;
        ALTER TABLE transactions DROP COLUMN IF EXISTS portfolio_transaction_id;
        """
    )
