"""Balance reconciliation: accounts.statement_balance + statement_balance_date (ADR-094).

Revision ID: 0054_account_statement_balance
Revises: 0053_trade_cash_legs
Create Date: 2026-06-18

ADR-094 stores an authoritative statement balance per account so Vision can diff it against the
computed ledger balance and surface drift. Two nullable columns; drift itself is computed, not
stored.

Blast radius: two nullable columns on accounts; no rewrite. Downgrade drops them.

NOTE: migrations are not auto-run by the agent — authored here; applied on the next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0054_account_statement_balance"
down_revision: Union[str, Sequence[str], None] = "0053_trade_cash_legs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE accounts
            ADD COLUMN IF NOT EXISTS statement_balance NUMERIC(15,2),
            ADD COLUMN IF NOT EXISTS statement_balance_date DATE;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE accounts DROP COLUMN IF EXISTS statement_balance_date;
        ALTER TABLE accounts DROP COLUMN IF EXISTS statement_balance;
        """
    )
