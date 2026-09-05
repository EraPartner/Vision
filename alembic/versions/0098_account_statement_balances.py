"""Add per-currency account statement balances (ADR-089 D2).

Revision ID: 0098_account_statement_balances
Revises: 0097_dividend_amount_convention
Create Date: 2026-09-04

The legacy scalar columns remain during the compatibility window. Existing
values are copied into the account's declared currency; new code treats this
side table as authoritative and mirrors that one compatibility projection.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0098_account_statement_balances"
down_revision: Union[str, Sequence[str], None] = "0097_dividend_amount_convention"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE account_statement_balances (
            account_id INTEGER NOT NULL,
            currency VARCHAR(3) NOT NULL,
            balance NUMERIC(18,4) NOT NULL,
            balance_date DATE NOT NULL,
            CONSTRAINT pk_account_statement_balances
                PRIMARY KEY (account_id, currency),
            CONSTRAINT fk_account_statement_balances_account
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            CONSTRAINT chk_account_statement_balances_currency_iso
                CHECK (currency ~ '^[A-Z]{3}$')
        );

        INSERT INTO account_statement_balances
            (account_id, currency, balance, balance_date)
        SELECT id, currency, statement_balance, statement_balance_date
          FROM accounts
         WHERE statement_balance IS NOT NULL
           AND statement_balance_date IS NOT NULL;
        """
    )


def downgrade() -> None:
    # The scalar compatibility columns never left the schema, so downgrade is
    # lossless for each account's declared-currency row. Foreign-currency rows
    # have no representation before D2 and are intentionally discarded.
    op.execute(
        """
        UPDATE accounts
           SET statement_balance = NULL,
               statement_balance_date = NULL;

        UPDATE accounts a
           SET statement_balance = s.balance,
               statement_balance_date = s.balance_date
          FROM account_statement_balances s
         WHERE s.account_id = a.id
           AND s.currency = a.currency;

        DROP TABLE account_statement_balances;
        """
    )
