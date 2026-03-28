"""Add kinesis to price_provider enum

Revision ID: 0022_price_provider_kinesis
Revises: 0021_price_provider_binance
Create Date: 2026-03-28
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0022_price_provider_kinesis'
down_revision: Union[str, Sequence[str], None] = '0021_price_provider_binance'
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
    op.execute("ALTER TYPE price_provider ADD VALUE IF NOT EXISTS 'kinesis';")


def downgrade() -> None:
    # Re-map values unsupported by the downgraded enum.
    op.execute("UPDATE investments_base SET price_provider = 'manual' WHERE price_provider::text = 'kinesis';")

    op.execute("ALTER TABLE investments_base ALTER COLUMN price_provider DROP DEFAULT;")

    _backup_and_drop_dependent_views()

    op.execute("ALTER TYPE price_provider RENAME TO price_provider_with_kinesis;")

    op.execute("""
        CREATE TYPE price_provider AS ENUM (
            'manual', 'binance', 'yahoo', 'custom'
        );
    """)

    op.execute("""
        ALTER TABLE investments_base
        ALTER COLUMN price_provider TYPE price_provider
        USING (price_provider::text)::price_provider;
    """)

    op.execute("ALTER TABLE investments_base ALTER COLUMN price_provider SET DEFAULT 'manual'::price_provider;")

    op.execute("DROP TYPE price_provider_with_kinesis;")

    _recreate_dependent_views_and_trigger()
