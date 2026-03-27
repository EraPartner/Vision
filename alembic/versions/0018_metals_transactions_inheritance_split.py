"""Split metals into dedicated transaction inheritance table

Revision ID: 0018_metals_transactions_inheritance_split
Revises: 0017_investment_custom_provider_history
Create Date: 2026-03-27
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0018_metals_transactions_inheritance_split'
down_revision: Union[str, Sequence[str], None] = '0017_investment_custom_provider_history'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS metals_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            units NUMERIC(18, 8),
            price_per_unit NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    op.execute("CREATE INDEX IF NOT EXISTS idx_metals_transactions_investment_id ON metals_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_metals_transactions_date ON metals_transactions(date);")

    op.execute("""
        DO $$
        BEGIN
            CREATE TRIGGER update_metals_transactions_updated_at
                BEFORE UPDATE ON metals_transactions
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END $$;
    """)

    op.execute("""
        INSERT INTO metals_transactions (
            id, investment_id, type, date, amount, fees, taxes, currency,
            note, is_recurring, recurrence_interval, recurrence_end_date,
            created_at, updated_at, fx_rate_to_eur, units, price_per_unit
        )
        SELECT
            st.id, st.investment_id, st.type, st.date, st.amount, st.fees, st.taxes, st.currency,
            st.note, st.is_recurring, st.recurrence_interval, st.recurrence_end_date,
            st.created_at, st.updated_at, st.fx_rate_to_eur, st.units, st.price_per_unit
        FROM stock_transactions st
        JOIN investments i ON i.id = st.investment_id
        WHERE i.asset_class = 'metals'
          AND NOT EXISTS (
              SELECT 1 FROM metals_transactions mt WHERE mt.id = st.id
          );
    """)

    op.execute("""
        DELETE FROM stock_transactions st
        USING investments i
        WHERE i.id = st.investment_id
          AND i.asset_class = 'metals';
    """)

    op.execute("""
        CREATE OR REPLACE VIEW portfolio_transactions AS
        SELECT
            ptb.id,
            ptb.investment_id,
            ptb.type,
            ptb.date,
            ptb.amount,
            COALESCE(st.units, et.units, ct.units, mt.units) as units,
            COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit, mt.price_per_unit) as price_per_unit,
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
        LEFT JOIN crypto_transactions ct ON ptb.id = ct.id
        LEFT JOIN metals_transactions mt ON ptb.id = mt.id;
    """)


def downgrade() -> None:
    op.execute("""
        INSERT INTO stock_transactions (
            id, investment_id, type, date, amount, fees, taxes, currency,
            note, is_recurring, recurrence_interval, recurrence_end_date,
            created_at, updated_at, fx_rate_to_eur, units, price_per_unit
        )
        SELECT
            mt.id, mt.investment_id, mt.type, mt.date, mt.amount, mt.fees, mt.taxes, mt.currency,
            mt.note, mt.is_recurring, mt.recurrence_interval, mt.recurrence_end_date,
            mt.created_at, mt.updated_at, mt.fx_rate_to_eur, mt.units, mt.price_per_unit
        FROM metals_transactions mt
        WHERE NOT EXISTS (
            SELECT 1 FROM stock_transactions st WHERE st.id = mt.id
        );
    """)

    op.execute("""
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
    """)

    op.execute("DROP TABLE IF EXISTS metals_transactions CASCADE;")
