"""Investment Table Inheritance - Separate tables per investment type

Revision ID: 0013_investment_inheritance
Revises: fix_avc_col
Create Date: 2026-03-22

This migration implements PostgreSQL table inheritance for investments:
- Base investment table with common fields
- Separate tables for each asset class: stocks, etfs, crypto, real_estate, savings, bonds
- Separate transaction tables for each investment type
- Data migration from the old unified investments table
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0013_investment_inheritance'
down_revision: Union[str, Sequence[str], None] = 'fix_avc_col'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create update_updated_at_column function (if not exists)
    op.execute("""
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

    # ============================================================
    # BASE INVESTMENTS TABLE (abstract parent)
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS investments_base (
            id SERIAL PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
            notes TEXT,
            is_active BOOLEAN NOT NULL DEFAULT true,
            price_provider price_provider DEFAULT 'manual',
            price_provider_id VARCHAR(200),
            price_provider_url VARCHAR(500),
            price_updated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    # ============================================================
    # STOCK INVESTMENTS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS stock_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            symbol VARCHAR(20),
            current_price NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    # ============================================================
    # ETF INVESTMENTS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS etf_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            symbol VARCHAR(20),
            current_price NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    # ============================================================
    # CRYPTO INVESTMENTS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS crypto_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            symbol VARCHAR(50),
            current_price NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    # ============================================================
    # REAL ESTATE INVESTMENTS TABLE (includes municipality fields)
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS real_estate_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            current_price NUMERIC(18, 6),
            location VARCHAR(300),
            municipality VARCHAR(200),
            cadastral_income NUMERIC(12, 2),
            municipality_tax_rate NUMERIC(8, 4),
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    # ============================================================
    # SAVINGS INVESTMENTS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS savings_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            current_price NUMERIC(18, 6),
            interest_rate NUMERIC(8, 4),
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    # ============================================================
    # BOND INVESTMENTS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS bond_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            current_price NUMERIC(18, 6),
            interest_rate NUMERIC(8, 4),
            maturity_date DATE,
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    # ============================================================
    # BASE TRANSACTIONS TABLE (abstract parent)
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS portfolio_transactions_base (
            id SERIAL PRIMARY KEY,
            investment_id INTEGER NOT NULL,
            type portfolio_txn_type NOT NULL,
            date DATE NOT NULL,
            amount NUMERIC(18, 4) NOT NULL,
            fees NUMERIC(18, 4) DEFAULT 0,
            taxes NUMERIC(18, 4) DEFAULT 0,
            currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
            note TEXT,
            is_recurring BOOLEAN NOT NULL DEFAULT false,
            recurrence_interval recurrence_interval,
            recurrence_end_date DATE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    # ============================================================
    # STOCK TRANSACTIONS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS stock_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            units NUMERIC(18, 8),
            price_per_unit NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    # ============================================================
    # ETF TRANSACTIONS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS etf_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            units NUMERIC(18, 8),
            price_per_unit NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    # ============================================================
    # CRYPTO TRANSACTIONS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS crypto_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            units NUMERIC(18, 8),
            price_per_unit NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    # ============================================================
    # REAL ESTATE TRANSACTIONS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS real_estate_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    # ============================================================
    # SAVINGS TRANSACTIONS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS savings_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    # ============================================================
    # BOND TRANSACTIONS TABLE
    # ============================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS bond_transactions (
            id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass),
            investment_id INTEGER NOT NULL,
            PRIMARY KEY (id)
        ) INHERITS (portfolio_transactions_base);
    """)

    # ============================================================
    # INDEXES FOR BASE TABLES
    # ============================================================
    op.execute("CREATE INDEX IF NOT EXISTS idx_investments_base_is_active ON investments_base(is_active);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_base_investment_id ON portfolio_transactions_base(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_base_date ON portfolio_transactions_base(date);")

    # ============================================================
    # INDEXES FOR CHILD TABLES
    # ============================================================
    # Stock
    op.execute("CREATE INDEX IF NOT EXISTS idx_stock_investments_symbol ON stock_investments(symbol);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_stock_transactions_investment_id ON stock_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_stock_transactions_date ON stock_transactions(date);")

    # ETF
    op.execute("CREATE INDEX IF NOT EXISTS idx_etf_investments_symbol ON etf_investments(symbol);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_etf_transactions_investment_id ON etf_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_etf_transactions_date ON etf_transactions(date);")

    # Crypto
    op.execute("CREATE INDEX IF NOT EXISTS idx_crypto_investments_symbol ON crypto_investments(symbol);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_crypto_transactions_investment_id ON crypto_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_crypto_transactions_date ON crypto_transactions(date);")

    # Real Estate
    op.execute("CREATE INDEX IF NOT EXISTS idx_real_estate_investments_location ON real_estate_investments(location);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_real_estate_transactions_investment_id ON real_estate_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_real_estate_transactions_date ON real_estate_transactions(date);")

    # Savings
    op.execute("CREATE INDEX IF NOT EXISTS idx_savings_transactions_investment_id ON savings_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_savings_transactions_date ON savings_transactions(date);")

    # Bond
    op.execute("CREATE INDEX IF NOT EXISTS idx_bond_transactions_investment_id ON bond_transactions(investment_id);")
    op.execute("CREATE INDEX IF NOT EXISTS idx_bond_transactions_date ON bond_transactions(date);")

    # ============================================================
    # TRIGGERS FOR UPDATED_AT
    # ============================================================
    tables_with_triggers = [
        'investments_base',
        'stock_investments', 'etf_investments', 'crypto_investments',
        'real_estate_investments', 'savings_investments', 'bond_investments',
        'portfolio_transactions_base',
        'stock_transactions', 'etf_transactions', 'crypto_transactions',
        'real_estate_transactions', 'savings_transactions', 'bond_transactions',
    ]

    for table in tables_with_triggers:
        op.execute(f"""
            DO $$
            BEGIN
                CREATE TRIGGER update_{table}_updated_at
                    BEFORE UPDATE ON {table}
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
            EXCEPTION WHEN duplicate_object THEN
                NULL;
            END$$;
        """)

    # ============================================================
    # RENAME OLD TABLES (for backward compatibility during transition)
    # ============================================================
    op.execute("ALTER TABLE IF EXISTS investments RENAME TO investments_legacy;")
    op.execute("ALTER TABLE IF EXISTS portfolio_transactions RENAME TO portfolio_transactions_legacy;")

    # ============================================================
    # DATA MIGRATION FROM OLD TABLES
    # ============================================================

    # Migrate stock investments
    op.execute("""
        INSERT INTO stock_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, symbol, current_price)
        SELECT id, name, currency, notes, is_active, COALESCE(price_provider, 'manual'), price_provider_id, price_provider_url, price_updated_at, symbol, current_price
        FROM investments_legacy
        WHERE asset_class = 'stock';
    """)

    # Migrate etf investments
    op.execute("""
        INSERT INTO etf_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, symbol, current_price)
        SELECT id, name, currency, notes, is_active, COALESCE(price_provider, 'manual'), price_provider_id, price_provider_url, price_updated_at, symbol, current_price
        FROM investments_legacy
        WHERE asset_class = 'etf';
    """)

    # Migrate crypto investments
    op.execute("""
        INSERT INTO crypto_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, symbol, current_price)
        SELECT id, name, currency, notes, is_active, COALESCE(price_provider, 'manual'), price_provider_id, price_provider_url, price_updated_at, symbol, current_price
        FROM investments_legacy
        WHERE asset_class = 'crypto';
    """)

    # Migrate real estate investments
    op.execute("""
        INSERT INTO real_estate_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, current_price, location, municipality, cadastral_income, municipality_tax_rate)
        SELECT id, name, currency, notes, is_active, COALESCE(price_provider, 'manual'), price_provider_id, price_provider_url, price_updated_at, current_price, location, municipality, cadastral_income, municipality_tax_rate
        FROM investments_legacy
        WHERE asset_class = 'real_estate';
    """)

    # Migrate savings investments
    op.execute("""
        INSERT INTO savings_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, current_price, interest_rate)
        SELECT id, name, currency, notes, is_active, COALESCE(price_provider, 'manual'), price_provider_id, price_provider_url, price_updated_at, current_price, interest_rate
        FROM investments_legacy
        WHERE asset_class = 'savings';
    """)

    # Migrate bond investments
    op.execute("""
        INSERT INTO bond_investments (id, name, currency, notes, is_active, price_provider, price_provider_id, price_provider_url, price_updated_at, current_price, interest_rate, maturity_date)
        SELECT id, name, currency, notes, is_active, COALESCE(price_provider, 'manual'), price_provider_id, price_provider_url, price_updated_at, current_price, interest_rate, maturity_date
        FROM investments_legacy
        WHERE asset_class = 'bond';
    """)

    # ============================================================
    # MIGRATE TRANSACTIONS (using investment asset_class to route)
    # ============================================================

    # Stock transactions
    op.execute("""
        INSERT INTO stock_transactions (id, investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
        SELECT pt.id, pt.investment_id, pt.type, pt.date, pt.amount, pt.units, pt.price_per_unit, pt.fees, pt.taxes, pt.currency, pt.note, pt.is_recurring, pt.recurrence_interval, pt.recurrence_end_date
        FROM portfolio_transactions_legacy pt
        JOIN investments_legacy i ON pt.investment_id = i.id
        WHERE i.asset_class = 'stock';
    """)

    # ETF transactions
    op.execute("""
        INSERT INTO etf_transactions (id, investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
        SELECT pt.id, pt.investment_id, pt.type, pt.date, pt.amount, pt.units, pt.price_per_unit, pt.fees, pt.taxes, pt.currency, pt.note, pt.is_recurring, pt.recurrence_interval, pt.recurrence_end_date
        FROM portfolio_transactions_legacy pt
        JOIN investments_legacy i ON pt.investment_id = i.id
        WHERE i.asset_class = 'etf';
    """)

    # Crypto transactions
    op.execute("""
        INSERT INTO crypto_transactions (id, investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
        SELECT pt.id, pt.investment_id, pt.type, pt.date, pt.amount, pt.units, pt.price_per_unit, pt.fees, pt.taxes, pt.currency, pt.note, pt.is_recurring, pt.recurrence_interval, pt.recurrence_end_date
        FROM portfolio_transactions_legacy pt
        JOIN investments_legacy i ON pt.investment_id = i.id
        WHERE i.asset_class = 'crypto';
    """)

    # Real estate transactions
    op.execute("""
        INSERT INTO real_estate_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
        SELECT pt.id, pt.investment_id, pt.type, pt.date, pt.amount, pt.fees, pt.taxes, pt.currency, pt.note, pt.is_recurring, pt.recurrence_interval, pt.recurrence_end_date
        FROM portfolio_transactions_legacy pt
        JOIN investments_legacy i ON pt.investment_id = i.id
        WHERE i.asset_class = 'real_estate';
    """)

    # Savings transactions
    op.execute("""
        INSERT INTO savings_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
        SELECT pt.id, pt.investment_id, pt.type, pt.date, pt.amount, pt.fees, pt.taxes, pt.currency, pt.note, pt.is_recurring, pt.recurrence_interval, pt.recurrence_end_date
        FROM portfolio_transactions_legacy pt
        JOIN investments_legacy i ON pt.investment_id = i.id
        WHERE i.asset_class = 'savings';
    """)

    # Bond transactions
    op.execute("""
        INSERT INTO bond_transactions (id, investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
        SELECT pt.id, pt.investment_id, pt.type, pt.date, pt.amount, pt.fees, pt.taxes, pt.currency, pt.note, pt.is_recurring, pt.recurrence_interval, pt.recurrence_end_date
        FROM portfolio_transactions_legacy pt
        JOIN investments_legacy i ON pt.investment_id = i.id
        WHERE i.asset_class = 'bond';
    """)

    # ============================================================
    # CREATE LEGACY VIEW (for backward compatibility during transition)
    # ============================================================
    op.execute("""
        CREATE OR REPLACE VIEW investments AS
        SELECT
            ib.id,
            ib.name,
            CASE
                WHEN si.id IS NOT NULL THEN 'stock'
                WHEN ei.id IS NOT NULL THEN 'etf'
                WHEN ci.id IS NOT NULL THEN 'crypto'
                WHEN rei.id IS NOT NULL THEN 'real_estate'
                WHEN savi.id IS NOT NULL THEN 'savings'
                WHEN bi.id IS NOT NULL THEN 'bond'
            END as asset_class,
            ib.currency,
            ib.notes,
            ib.is_active,
            ib.price_provider,
            ib.price_provider_id,
            ib.price_provider_url,
            ib.price_updated_at,
            ib.created_at,
            ib.updated_at,
            COALESCE(si.symbol, ei.symbol, ci.symbol) as symbol,
            COALESCE(si.current_price, ei.current_price, ci.current_price, rei.current_price, savi.current_price, bi.current_price) as current_price,
            savi.interest_rate as interest_rate,
            bi.maturity_date as maturity_date,
            rei.location as location,
            rei.municipality as municipality,
            rei.cadastral_income as cadastral_income,
            rei.municipality_tax_rate as municipality_tax_rate
        FROM investments_base ib
        LEFT JOIN stock_investments si ON ib.id = si.id
        LEFT JOIN etf_investments ei ON ib.id = ei.id
        LEFT JOIN crypto_investments ci ON ib.id = ci.id
        LEFT JOIN real_estate_investments rei ON ib.id = rei.id
        LEFT JOIN savings_investments savi ON ib.id = savi.id
        LEFT JOIN bond_investments bi ON ib.id = bi.id;
    """)

    # Create legacy view for portfolio_transactions
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
            ptb.updated_at
        FROM portfolio_transactions_base ptb
        LEFT JOIN stock_transactions st ON ptb.id = st.id
        LEFT JOIN etf_transactions et ON ptb.id = et.id
        LEFT JOIN crypto_transactions ct ON ptb.id = ct.id;
    """)

    # ============================================================
    # CREATE COMPOSITE TABLES (unified views for each type)
    # These are useful for queries that need all investment data
    # ============================================================
    op.execute("""
        CREATE OR REPLACE VIEW stock_investments_full AS
        SELECT ib.*, si.symbol, si.current_price
        FROM investments_base ib
        JOIN stock_investments si ON ib.id = si.id;
    """)

    op.execute("""
        CREATE OR REPLACE VIEW etf_investments_full AS
        SELECT ib.*, ei.symbol, ei.current_price
        FROM investments_base ib
        JOIN etf_investments ei ON ib.id = ei.id;
    """)

    op.execute("""
        CREATE OR REPLACE VIEW crypto_investments_full AS
        SELECT ib.*, ci.symbol, ci.current_price
        FROM investments_base ib
        JOIN crypto_investments ci ON ib.id = ci.id;
    """)

    op.execute("""
        CREATE OR REPLACE VIEW real_estate_investments_full AS
        SELECT ib.*, rei.current_price, rei.location, rei.municipality, rei.cadastral_income, rei.municipality_tax_rate
        FROM investments_base ib
        JOIN real_estate_investments rei ON ib.id = rei.id;
    """)

    op.execute("""
        CREATE OR REPLACE VIEW savings_investments_full AS
        SELECT ib.*, savi.current_price, savi.interest_rate
        FROM investments_base ib
        JOIN savings_investments savi ON ib.id = savi.id;
    """)

    op.execute("""
        CREATE OR REPLACE VIEW bond_investments_full AS
        SELECT ib.*, bi.current_price, bi.interest_rate, bi.maturity_date
        FROM investments_base ib
        JOIN bond_investments bi ON ib.id = bi.id;
    """)


def downgrade() -> None:
    # Drop views first
    op.execute("DROP VIEW IF EXISTS bond_investments_full CASCADE;")
    op.execute("DROP VIEW IF EXISTS savings_investments_full CASCADE;")
    op.execute("DROP VIEW IF EXISTS real_estate_investments_full CASCADE;")
    op.execute("DROP VIEW IF EXISTS crypto_investments_full CASCADE;")
    op.execute("DROP VIEW IF EXISTS etf_investments_full CASCADE;")
    op.execute("DROP VIEW IF EXISTS stock_investments_full CASCADE;")
    op.execute("DROP VIEW IF EXISTS portfolio_transactions CASCADE;")
    op.execute("DROP VIEW IF EXISTS investments CASCADE;")

    # Drop child tables
    op.execute("DROP TABLE IF EXISTS bond_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS savings_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS real_estate_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS crypto_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS etf_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS stock_transactions CASCADE;")
    op.execute("DROP TABLE IF EXISTS portfolio_transactions_base CASCADE;")

    op.execute("DROP TABLE IF EXISTS bond_investments CASCADE;")
    op.execute("DROP TABLE IF EXISTS savings_investments CASCADE;")
    op.execute("DROP TABLE IF EXISTS real_estate_investments CASCADE;")
    op.execute("DROP TABLE IF EXISTS crypto_investments CASCADE;")
    op.execute("DROP TABLE IF EXISTS etf_investments CASCADE;")
    op.execute("DROP TABLE IF EXISTS stock_investments CASCADE;")
    op.execute("DROP TABLE IF EXISTS investments_base CASCADE;")
