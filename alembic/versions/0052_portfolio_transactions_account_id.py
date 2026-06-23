"""Per-account positioning: account_id on portfolio_transactions (ADR-091).

Revision ID: 0052_portfolio_transactions_account_id
Revises: 0051_account_id_dual_write_trigger
Create Date: 2026-06-18

Holdings are global today — portfolio_transactions (the lots) carry no account, so "100 AAPL at
IBKR vs 50 at Degiro" can't be expressed and there's no per-account cost basis. ADR-091 adds a
nullable account_id; a position becomes (investment_id, account_id).

SCHEMA-SHAPE AWARE: `portfolio_transactions` may be a real table (flat schema) OR a JOIN VIEW over
`portfolio_transactions_base` + per-asset-class child tables (PostgreSQL table inheritance,
ADR-004). You cannot ADD COLUMN to a view, so when the inheritance schema is present this adds
account_id to the BASE table (inherited by every child) and recreates the view to expose it; in
the flat schema it adds the column directly.

account_id is nullable (ON DELETE RESTRICT on the base table, per ADR-087). The FK is not
inherited by child tables (a PostgreSQL inheritance limitation), so it enforces only for base-table
rows — acceptable; the column itself is inherited and writable on every child.

Blast radius: one nullable column (+ inherited) + an index + a view recreate. No data change.
Downgrade drops them and restores the original view.

NOTE: migrations are not auto-run by the agent — authored here; applied on the next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0052_portfolio_transactions_account_id"
down_revision: Union[str, Sequence[str], None] = "0051_account_id_dual_write_trigger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The portfolio_transactions view body. "%(ACCT)s" expands to the extra account_id column (or "").
_VIEW = """
        CREATE OR REPLACE VIEW portfolio_transactions AS
         SELECT ptb.id,
                ptb.investment_id,
                ptb.type,
                ptb.date,
                ptb.amount,
                COALESCE(st.units, et.units, ct.units, mt.units) AS units,
                COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit, mt.price_per_unit) AS price_per_unit,
                ptb.fees,
                ptb.taxes,
                ptb.currency,
                ptb.note,
                ptb.is_recurring,
                ptb.recurrence_interval,
                ptb.recurrence_end_date,
                ptb.created_at,
                ptb.updated_at,
                ptb.fx_rate_to_eur%(ACCT)s
           FROM portfolio_transactions_base ptb
             LEFT JOIN stock_transactions st ON ptb.id = st.id
             LEFT JOIN etf_transactions et ON ptb.id = et.id
             LEFT JOIN crypto_transactions ct ON ptb.id = ct.id
             LEFT JOIN metals_transactions mt ON ptb.id = mt.id;
"""

_VIEW_WITH_ACCT = _VIEW % {"ACCT": ",\n                ptb.account_id"}
_VIEW_WITHOUT_ACCT = _VIEW % {"ACCT": ""}


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.portfolio_transactions_base') IS NOT NULL THEN
            ALTER TABLE portfolio_transactions_base
                ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT;
            CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_base_account_id
                ON portfolio_transactions_base (account_id);
        """
        + _VIEW_WITH_ACCT
        + """
          ELSE
            ALTER TABLE portfolio_transactions
                ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT;
            CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_account_id
                ON portfolio_transactions (account_id);
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.portfolio_transactions_base') IS NOT NULL THEN
        """
        + _VIEW_WITHOUT_ACCT
        + """
            DROP INDEX IF EXISTS idx_portfolio_transactions_base_account_id;
            ALTER TABLE portfolio_transactions_base DROP COLUMN IF EXISTS account_id;
          ELSE
            DROP INDEX IF EXISTS idx_portfolio_transactions_account_id;
            ALTER TABLE portfolio_transactions DROP COLUMN IF EXISTS account_id;
          END IF;
        END $$;
        """
    )
