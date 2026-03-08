"""Add portfolio investments and transactions tables

Revision ID: 0004_portfolio_tables
Revises: 0003_make_recipient_nullable
Create Date: 2026-03-08 10:00:00.000000
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0004_portfolio_tables'
down_revision: Union[str, Sequence[str], None] = '0003_make_recipient_nullable'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Ensure the update_updated_at_column function exists
    op.execute("""
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    # Asset class enum
    op.execute("""
        CREATE TYPE asset_class AS ENUM (
            'stock', 'etf', 'crypto', 'real_estate', 'savings', 'bond'
        );
    """)

    # Portfolio transaction type enum
    op.execute("""
        CREATE TYPE portfolio_txn_type AS ENUM (
            'buy', 'sell', 'dividend', 'fee', 'tax', 'interest', 'rent_income', 'appreciation'
        );
    """)

    # Recurrence interval enum
    op.execute("""
        CREATE TYPE recurrence_interval AS ENUM (
            'daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'yearly'
        );
    """)

    # Investments table
    op.execute("""
        CREATE TABLE investments (
            id SERIAL PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            symbol VARCHAR(20),
            asset_class asset_class NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
            current_price NUMERIC(18, 6),
            interest_rate NUMERIC(8, 4),
            maturity_date DATE,
            location VARCHAR(300),
            notes TEXT,
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
    """)

    # Portfolio transactions table
    op.execute("""
        CREATE TABLE portfolio_transactions (
            id SERIAL PRIMARY KEY,
            investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
            type portfolio_txn_type NOT NULL,
            date DATE NOT NULL,
            amount NUMERIC(18, 4) NOT NULL,
            units NUMERIC(18, 8),
            price_per_unit NUMERIC(18, 6),
            fees NUMERIC(18, 4) DEFAULT 0,
            taxes NUMERIC(18, 4) DEFAULT 0,
            currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
            note TEXT,
            is_recurring BOOLEAN NOT NULL DEFAULT false,
            recurrence_interval recurrence_interval,
            recurrence_end_date DATE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
    """)

    # Indexes
    op.execute("CREATE INDEX idx_investments_asset_class ON investments(asset_class);")
    op.execute("CREATE INDEX idx_investments_is_active ON investments(is_active);")
    op.execute("CREATE INDEX idx_portfolio_txn_investment_id ON portfolio_transactions(investment_id);")
    op.execute("CREATE INDEX idx_portfolio_txn_date ON portfolio_transactions(date);")
    op.execute("CREATE INDEX idx_portfolio_txn_type ON portfolio_transactions(type);")

    # Updated_at triggers
    op.execute("""
        CREATE TRIGGER update_investments_updated_at
            BEFORE UPDATE ON investments
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_portfolio_transactions_updated_at
            BEFORE UPDATE ON portfolio_transactions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS portfolio_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS investments CASCADE;")
    op.execute("DROP TYPE IF EXISTS recurrence_interval;")
    op.execute("DROP TYPE IF EXISTS portfolio_txn_type;")
    op.execute("DROP TYPE IF EXISTS asset_class;")
