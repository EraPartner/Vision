"""Add custom provider latest/history fields + metals inheritance compatibility

Revision ID: 0017_investment_custom_provider_history
Revises: 0016_add_fx_rate_to_portfolio_transactions
Create Date: 2026-03-27
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0017_investment_custom_provider_history'
down_revision: Union[str, Sequence[str], None] = '0016_add_fx_rate_to_portfolio_transactions'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'investments_base'
                  AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE investments_base
                    ADD COLUMN IF NOT EXISTS price_provider_latest_url VARCHAR(500),
                    ADD COLUMN IF NOT EXISTS price_provider_latest_path VARCHAR(300),
                    ADD COLUMN IF NOT EXISTS price_provider_history_url VARCHAR(500),
                    ADD COLUMN IF NOT EXISTS price_provider_history_path VARCHAR(300),
                    ADD COLUMN IF NOT EXISTS price_provider_history_ts_path VARCHAR(300),
                    ADD COLUMN IF NOT EXISTS price_provider_history_price_path VARCHAR(300);
            END IF;
        END $$;
    """)

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'investments'
                  AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE investments
                    ADD COLUMN IF NOT EXISTS price_provider_latest_url VARCHAR(500),
                    ADD COLUMN IF NOT EXISTS price_provider_latest_path VARCHAR(300),
                    ADD COLUMN IF NOT EXISTS price_provider_history_url VARCHAR(500),
                    ADD COLUMN IF NOT EXISTS price_provider_history_path VARCHAR(300),
                    ADD COLUMN IF NOT EXISTS price_provider_history_ts_path VARCHAR(300),
                    ADD COLUMN IF NOT EXISTS price_provider_history_price_path VARCHAR(300);
            END IF;
        END $$;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS metals_investments (
            id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass),
            symbol VARCHAR(20),
            current_price NUMERIC(18, 6),
            PRIMARY KEY (id)
        ) INHERITS (investments_base);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_metals_investments_symbol ON metals_investments(symbol);
    """)

    op.execute("""
        CREATE OR REPLACE VIEW investments AS
        SELECT
            ib.id,
            ib.name,
            CASE
                WHEN si.id IS NOT NULL THEN 'stock'
                WHEN ei.id IS NOT NULL THEN 'etf'
                WHEN ci.id IS NOT NULL THEN 'crypto'
                WHEN mi.id IS NOT NULL THEN 'metals'
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
            COALESCE(si.symbol, ei.symbol, ci.symbol, mi.symbol) as symbol,
            COALESCE(si.current_price, ei.current_price, ci.current_price, mi.current_price, rei.current_price, savi.current_price, bi.current_price) as current_price,
            savi.interest_rate as interest_rate,
            bi.maturity_date as maturity_date,
            rei.location as location,
            rei.municipality as municipality,
            rei.cadastral_income as cadastral_income,
            rei.municipality_tax_rate as municipality_tax_rate,
            ib.price_provider_latest_url,
            ib.price_provider_latest_path,
            ib.price_provider_history_url,
            ib.price_provider_history_path,
            ib.price_provider_history_ts_path,
            ib.price_provider_history_price_path
        FROM investments_base ib
        LEFT JOIN stock_investments si ON ib.id = si.id
        LEFT JOIN etf_investments ei ON ib.id = ei.id
        LEFT JOIN crypto_investments ci ON ib.id = ci.id
        LEFT JOIN metals_investments mi ON ib.id = mi.id
        LEFT JOIN real_estate_investments rei ON ib.id = rei.id
        LEFT JOIN savings_investments savi ON ib.id = savi.id
        LEFT JOIN bond_investments bi ON ib.id = bi.id;
    """)

    op.execute("""
        CREATE OR REPLACE FUNCTION investments_view_update_instead()
        RETURNS trigger
        AS $$
        BEGIN
            UPDATE investments_base
               SET name = NEW.name,
                   currency = NEW.currency,
                   notes = NEW.notes,
                   is_active = NEW.is_active,
                   price_provider = NEW.price_provider,
                   price_provider_id = NEW.price_provider_id,
                   price_provider_url = NEW.price_provider_url,
                   price_provider_latest_url = NEW.price_provider_latest_url,
                   price_provider_latest_path = NEW.price_provider_latest_path,
                   price_provider_history_url = NEW.price_provider_history_url,
                   price_provider_history_path = NEW.price_provider_history_path,
                   price_provider_history_ts_path = NEW.price_provider_history_ts_path,
                   price_provider_history_price_path = NEW.price_provider_history_price_path,
                   price_updated_at = NEW.price_updated_at
             WHERE id = OLD.id;

            IF OLD.asset_class = 'stock' THEN
                UPDATE stock_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'etf' THEN
                UPDATE etf_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'crypto' THEN
                UPDATE crypto_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'metals' THEN
                UPDATE metals_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'real_estate' THEN
                UPDATE real_estate_investments
                   SET current_price = NEW.current_price,
                       location = NEW.location,
                       municipality = NEW.municipality,
                       cadastral_income = NEW.cadastral_income,
                       municipality_tax_rate = NEW.municipality_tax_rate
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'savings' THEN
                UPDATE savings_investments
                   SET current_price = NEW.current_price,
                       interest_rate = NEW.interest_rate
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'bond' THEN
                UPDATE bond_investments
                   SET current_price = NEW.current_price,
                       interest_rate = NEW.interest_rate,
                       maturity_date = NEW.maturity_date
                 WHERE id = OLD.id;
            END IF;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)


def downgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION investments_view_update_instead()
        RETURNS trigger
        AS $$
        BEGIN
            UPDATE investments_base
               SET name = NEW.name,
                   currency = NEW.currency,
                   notes = NEW.notes,
                   is_active = NEW.is_active,
                   price_provider = NEW.price_provider,
                   price_provider_id = NEW.price_provider_id,
                   price_provider_url = NEW.price_provider_url,
                   price_updated_at = NEW.price_updated_at
             WHERE id = OLD.id;

            IF OLD.asset_class = 'stock' THEN
                UPDATE stock_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'etf' THEN
                UPDATE etf_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'crypto' THEN
                UPDATE crypto_investments
                   SET symbol = NEW.symbol,
                       current_price = NEW.current_price
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'real_estate' THEN
                UPDATE real_estate_investments
                   SET current_price = NEW.current_price,
                       location = NEW.location,
                       municipality = NEW.municipality,
                       cadastral_income = NEW.cadastral_income,
                       municipality_tax_rate = NEW.municipality_tax_rate
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'savings' THEN
                UPDATE savings_investments
                   SET current_price = NEW.current_price,
                       interest_rate = NEW.interest_rate
                 WHERE id = OLD.id;
            ELSIF OLD.asset_class = 'bond' THEN
                UPDATE bond_investments
                   SET current_price = NEW.current_price,
                       interest_rate = NEW.interest_rate,
                       maturity_date = NEW.maturity_date
                 WHERE id = OLD.id;
            END IF;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)

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

    op.execute("DROP INDEX IF EXISTS idx_metals_investments_symbol;")
    op.execute("DROP TABLE IF EXISTS metals_investments CASCADE;")

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'investments_base'
                  AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE investments_base
                    DROP COLUMN IF EXISTS price_provider_latest_url,
                    DROP COLUMN IF EXISTS price_provider_latest_path,
                    DROP COLUMN IF EXISTS price_provider_history_url,
                    DROP COLUMN IF EXISTS price_provider_history_path,
                    DROP COLUMN IF EXISTS price_provider_history_ts_path,
                    DROP COLUMN IF EXISTS price_provider_history_price_path;
            END IF;
        END $$;
    """)

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'investments'
                  AND c.relkind IN ('r', 'p')
            ) THEN
                ALTER TABLE investments
                    DROP COLUMN IF EXISTS price_provider_latest_url,
                    DROP COLUMN IF EXISTS price_provider_latest_path,
                    DROP COLUMN IF EXISTS price_provider_history_url,
                    DROP COLUMN IF EXISTS price_provider_history_path,
                    DROP COLUMN IF EXISTS price_provider_history_ts_path,
                    DROP COLUMN IF EXISTS price_provider_history_price_path;
            END IF;
        END $$;
    """)
