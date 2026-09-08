"""Canonicalize portfolio recurrence spelling to biweekly.

Revision ID: 0099_canonical_biweekly_recurrence
Revises: 0098_account_statement_balances
Create Date: 2026-09-07

Blast radius: rewrites only the recurrence_interval column on
portfolio_transactions. The legacy enum remains available for downgrade and
for frozen legacy relations. Current writes use a named CHECK on TEXT so the
legacy spelling can be removed without mutating the shared enum globally.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0099_canonical_biweekly_recurrence"
down_revision: Union[str, Sequence[str], None] = "0098_account_statement_balances"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        -- destructive-ok: ADR-109 active portfolio rows are rewritten in this
        -- same migration and current code accepts both wire spellings while
        -- emitting only the canonical value; the legacy enum remains intact.
        ALTER TABLE portfolio_transactions
          ALTER COLUMN recurrence_interval TYPE TEXT
          USING recurrence_interval::text;

        UPDATE portfolio_transactions
           SET recurrence_interval = 'biweekly'
         WHERE recurrence_interval = 'bi-weekly';

        ALTER TABLE portfolio_transactions
          ADD CONSTRAINT chk_portfolio_transactions_recurrence_interval
          CHECK (
            recurrence_interval IS NULL OR recurrence_interval IN (
              'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'
            )
          );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_transactions
          DROP CONSTRAINT chk_portfolio_transactions_recurrence_interval;

        UPDATE portfolio_transactions
           SET recurrence_interval = 'bi-weekly'
         WHERE recurrence_interval = 'biweekly';

        ALTER TABLE portfolio_transactions
          ALTER COLUMN recurrence_interval TYPE recurrence_interval
          USING recurrence_interval::recurrence_interval;
        """
    )
