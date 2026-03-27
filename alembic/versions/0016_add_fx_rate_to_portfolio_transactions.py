"""Add fx_rate_to_eur to portfolio transactions

Revision ID: 0016_add_fx_rate_to_portfolio_transactions
Revises: 0015_add_gift_portfolio_txn_type
Create Date: 2026-03-25
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0016_add_fx_rate_to_portfolio_transactions'
down_revision: Union[str, Sequence[str], None] = '0015_add_gift_portfolio_txn_type'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE IF EXISTS portfolio_transactions_base ADD COLUMN IF NOT EXISTS fx_rate_to_eur NUMERIC(20, 10);")
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public'
                   AND c.relname = 'portfolio_transactions'
                   AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE portfolio_transactions ADD COLUMN IF NOT EXISTS fx_rate_to_eur NUMERIC(20, 10);
            END IF;
        END $$;
    """)
    op.execute("ALTER TABLE IF EXISTS portfolio_transactions_legacy ADD COLUMN IF NOT EXISTS fx_rate_to_eur NUMERIC(20, 10);")

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public'
                   AND c.relname = 'portfolio_transactions'
                   AND c.relkind = 'v'
            ) THEN
                CREATE OR REPLACE VIEW portfolio_transactions AS
                SELECT
                    ptb.id,
                    ptb.investment_id,
                    ptb.type,
                    ptb.date,
                    ptb.amount,
                    COALESCE(st.units, et.units, ct.units) as units,
                    COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit) as price_per_unit,
                    ptb.fees,
                    ptb.taxes,
                    ptb.currency,
                    ptb.note,
                    ptb.is_recurring,
                    ptb.recurrence_interval,
                    ptb.recurrence_end_date,
                    ptb.created_at,
                    ptb.updated_at,
                    ptb.fx_rate_to_eur
                FROM portfolio_transactions_base ptb
                LEFT JOIN stock_transactions st ON ptb.id = st.id
                LEFT JOIN etf_transactions et ON ptb.id = et.id
                LEFT JOIN crypto_transactions ct ON ptb.id = ct.id;
            END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public'
                   AND c.relname = 'portfolio_transactions'
                   AND c.relkind = 'v'
            ) THEN
                CREATE OR REPLACE VIEW portfolio_transactions AS
                SELECT
                    ptb.id,
                    ptb.investment_id,
                    ptb.type,
                    ptb.date,
                    ptb.amount,
                    COALESCE(st.units, et.units, ct.units) as units,
                    COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit) as price_per_unit,
                    ptb.fees,
                    ptb.taxes,
                    ptb.currency,
                    ptb.note,
                    ptb.is_recurring,
                    ptb.recurrence_interval,
                    ptb.recurrence_end_date,
                    ptb.created_at,
                    ptb.updated_at
                FROM portfolio_transactions_base ptb
                LEFT JOIN stock_transactions st ON ptb.id = st.id
                LEFT JOIN etf_transactions et ON ptb.id = et.id
                LEFT JOIN crypto_transactions ct ON ptb.id = ct.id;
            END IF;
        END $$;
    """)

    op.execute("ALTER TABLE IF EXISTS portfolio_transactions_legacy DROP COLUMN IF EXISTS fx_rate_to_eur;")
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public'
                   AND c.relname = 'portfolio_transactions'
                   AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE portfolio_transactions DROP COLUMN IF EXISTS fx_rate_to_eur;
            END IF;
        END $$;
    """)
    op.execute("ALTER TABLE IF EXISTS portfolio_transactions_base DROP COLUMN IF EXISTS fx_rate_to_eur;")
