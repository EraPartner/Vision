"""Add INSTEAD OF UPDATE trigger for investments view

Revision ID: 0014_investments_view_update_trigger
Revises: 0013_investment_inheritance
Create Date: 2026-03-23

"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0014_investments_view_update_trigger'
down_revision: Union[str, Sequence[str], None] = '0013_investment_inheritance'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public'
                   AND c.relname = 'investments'
                   AND c.relkind = 'v'
            ) THEN
                DROP TRIGGER IF EXISTS update_investments_view_instead ON investments;
                CREATE TRIGGER update_investments_view_instead
                    INSTEAD OF UPDATE ON investments
                    FOR EACH ROW
                    EXECUTE FUNCTION investments_view_update_instead();
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
                   AND c.relname = 'investments'
                   AND c.relkind = 'v'
            ) THEN
                DROP TRIGGER IF EXISTS update_investments_view_instead ON investments;
            END IF;
        END $$;
    """)

    op.execute("DROP FUNCTION IF EXISTS investments_view_update_instead();")
