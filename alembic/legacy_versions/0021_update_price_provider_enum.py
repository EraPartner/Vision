"""Update price_provider enum to replace coingecko/kraken with binance

Revision ID: 0021_price_provider_binance
Revises: 0020_drop_asset_price_history_fk
Create Date: 2026-03-28

Replaces CoinGecko and Kraken with Binance as the crypto price provider.
"""
from typing import Sequence, Union
from alembic import op

revision: str = '0021_price_provider_binance'
down_revision: Union[str, Sequence[str], None] = '0020_drop_asset_price_history_fk'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _backup_and_drop_dependent_views() -> None:
    op.execute("""
        CREATE TEMP TABLE IF NOT EXISTS _tmp_price_provider_dependent_views (
            view_name TEXT PRIMARY KEY,
            view_def TEXT NOT NULL
        ) ON COMMIT DROP;
    """)

    op.execute("""
        INSERT INTO _tmp_price_provider_dependent_views (view_name, view_def)
        SELECT v.relname, pg_get_viewdef(v.oid, true)
          FROM pg_depend d
          JOIN pg_rewrite r ON r.oid = d.objid
          JOIN pg_class v ON v.oid = r.ev_class
          JOIN pg_namespace n ON n.oid = v.relnamespace
          JOIN pg_class t ON t.oid = d.refobjid
          LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
         WHERE d.classid = 'pg_rewrite'::regclass
           AND d.refclassid = 'pg_class'::regclass
           AND v.relkind = 'v'
           AND n.nspname = 'public'
           AND t.relname = 'investments_base'
           AND (
                d.refobjsubid = 0
                OR a.attname = 'price_provider'
           )
        ON CONFLICT (view_name) DO NOTHING;
    """)

    op.execute("""
        DO $$
        DECLARE v RECORD;
        BEGIN
            FOR v IN SELECT view_name FROM _tmp_price_provider_dependent_views LOOP
                IF v.view_name = 'investments' THEN
                    DROP TRIGGER IF EXISTS update_investments_view_instead ON investments;
                END IF;
                EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', v.view_name);
            END LOOP;
        END $$;
    """)


def _recreate_dependent_views_and_trigger() -> None:
    op.execute("""
        DO $$
        DECLARE v RECORD;
        BEGIN
            FOR v IN SELECT view_name, view_def FROM _tmp_price_provider_dependent_views LOOP
                EXECUTE format('CREATE OR REPLACE VIEW %I AS %s', v.view_name, v.view_def);
            END LOOP;

            IF EXISTS (
                SELECT 1 FROM _tmp_price_provider_dependent_views WHERE view_name = 'investments'
            ) AND EXISTS (
                SELECT 1 FROM pg_proc WHERE proname = 'investments_view_update_instead'
            ) THEN
                DROP TRIGGER IF EXISTS update_investments_view_instead ON investments;
                CREATE TRIGGER update_investments_view_instead
                    INSTEAD OF UPDATE ON investments
                    FOR EACH ROW
                    EXECUTE FUNCTION investments_view_update_instead();
            END IF;
        END $$;
    """)


def upgrade() -> None:
    # Drop default first to avoid enum cast errors during type swap
    op.execute("ALTER TABLE investments_base ALTER COLUMN price_provider DROP DEFAULT;")

    # The investments view depends on this column type and must be rebuilt
    _backup_and_drop_dependent_views()

    # Rename old enum type
    op.execute("""
        ALTER TYPE price_provider RENAME TO price_provider_old;
    """)
    
    # Create new enum type with binance instead of coingecko/kraken
    op.execute("""
        CREATE TYPE price_provider AS ENUM (
            'manual', 'binance', 'yahoo', 'custom'
        );
    """)
    
    # Convert existing values (use investments_base, not investments view)
    op.execute("""
        ALTER TABLE investments_base 
        ALTER COLUMN price_provider TYPE price_provider 
        USING (
            CASE price_provider::text
                WHEN 'coingecko' THEN 'binance'::text
                WHEN 'kraken' THEN 'binance'::text
                ELSE price_provider::text
            END
        )::price_provider;
    """)

    # Add default back using the new enum type
    op.execute("ALTER TABLE investments_base ALTER COLUMN price_provider SET DEFAULT 'manual'::price_provider;")

    # Drop old enum type
    op.execute("DROP TYPE price_provider_old;")

    _recreate_dependent_views_and_trigger()


def downgrade() -> None:
    # Drop the default first (required for type change)
    op.execute("ALTER TABLE investments_base ALTER COLUMN price_provider DROP DEFAULT;")

    # The investments view depends on this column type and must be rebuilt
    _backup_and_drop_dependent_views()
    
    # Rename current enum type
    op.execute("ALTER TYPE price_provider RENAME TO price_provider_new;")
    
    # Create old enum type
    op.execute("""
        CREATE TYPE price_provider AS ENUM (
            'manual', 'coingecko', 'yahoo', 'kraken', 'custom'
        );
    """)
    
    # Convert back (binance -> coingecko as fallback)
    op.execute("""
        ALTER TABLE investments_base 
        ALTER COLUMN price_provider TYPE price_provider 
        USING (
            CASE price_provider::text
                WHEN 'binance' THEN 'coingecko'::text
                ELSE price_provider::text
            END
        )::price_provider;
    """)
    
    op.execute("DROP TYPE price_provider_new;")
    
    # Add default back
    op.execute("ALTER TABLE investments_base ALTER COLUMN price_provider SET DEFAULT 'manual'::price_provider;")

    _recreate_dependent_views_and_trigger()
