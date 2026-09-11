"""Retire the upgraded-install-only exchange_rate_cache table.

Revision ID: 0105_retire_legacy_exchange_rate_cache
Revises: 0104_drop_dormant_import_bank_resolution
Create Date: 2026-09-09

Fresh consolidated installations do not have this legacy table, so upgrade is
a no-op there. When the table exists, the migration accepts only the exact,
empty legacy shape. Populated, malformed, or dependent relations fail closed.
Downgrade recreates that proven-empty shape; business data is never discarded.

Blast radius: one unused legacy relation on upgraded installations only.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0105_retire_legacy_exchange_rate_cache"
down_revision: Union[str, Sequence[str], None] = (
    "0104_drop_dormant_import_bank_resolution"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Escape colons that follow closing parentheses so SQLAlchemy does not
    # reinterpret ``:true`` inside these SQL string literals as a bind.
    op.execute(
        """
        DO $$
        DECLARE
            relation_kind "char";
            column_shape text[];
            default_shape text[];
            constraint_shape text[];
            index_shape text[];
            user_trigger_count bigint;
            stored_rows bigint;
        BEGIN
            SELECT relkind INTO relation_kind
              FROM pg_class
             WHERE oid = to_regclass('public.exchange_rate_cache');
            IF relation_kind IS NULL THEN
                RETURN;
            END IF;
            IF relation_kind <> 'r' THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: relation kind % is not an ordinary table',
                    relation_kind;
            END IF;

            LOCK TABLE public.exchange_rate_cache IN ACCESS EXCLUSIVE MODE;

            SELECT array_agg(
                       attribute.attname || ':' ||
                       format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
                       attribute.attnotnull::text
                       ORDER BY attribute.attnum
                   )
              INTO column_shape
              FROM pg_attribute AS attribute
             WHERE attribute.attrelid = 'public.exchange_rate_cache'::regclass
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped;
            IF column_shape <> ARRAY[
                'id:integer:true',
                'from_ccy:character(3)\\:true',
                'to_ccy:character(3)\\:true',
                'rate_date:date:true',
                'rate:numeric(20,10)\\:true',
                'fetched_at:timestamp with time zone:true'
            ] THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: unexpected column shape %',
                    column_shape;
            END IF;

            SELECT array_agg(
                       attribute.attname || ':' ||
                       COALESCE(
                           CASE
                               WHEN attribute.attname = 'id' THEN
                                   regexp_replace(
                                       pg_get_expr(definition.adbin, definition.adrelid),
                                       '''public\\.',
                                       ''''
                                   ) || '|' || pg_get_serial_sequence(
                                       'public.exchange_rate_cache', 'id'
                                   )
                               ELSE pg_get_expr(definition.adbin, definition.adrelid)
                           END,
                           '<none>'
                       )
                       ORDER BY attribute.attnum
                   )
              INTO default_shape
              FROM pg_attribute AS attribute
              LEFT JOIN pg_attrdef AS definition
                ON definition.adrelid = attribute.attrelid
               AND definition.adnum = attribute.attnum
             WHERE attribute.attrelid = 'public.exchange_rate_cache'::regclass
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped;
            IF default_shape <> ARRAY[
                'id:nextval(''exchange_rate_cache_id_seq''::regclass)|public.exchange_rate_cache_id_seq',
                'from_ccy:<none>',
                'to_ccy:<none>',
                'rate_date:<none>',
                'rate:<none>',
                'fetched_at:now()'
            ] THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: unexpected defaults %',
                    default_shape;
            END IF;

            SELECT array_agg(
                       contype::text || ':' || pg_get_constraintdef(oid)
                       ORDER BY conname
                   )
              INTO constraint_shape
              FROM pg_constraint
             WHERE conrelid = 'public.exchange_rate_cache'::regclass;
            IF constraint_shape <> ARRAY[
                'c:CHECK ((rate > (0)::numeric))',
                'n:NOT NULL fetched_at',
                'n:NOT NULL from_ccy',
                'n:NOT NULL id',
                'p:PRIMARY KEY (id)',
                'n:NOT NULL rate_date',
                'n:NOT NULL rate',
                'n:NOT NULL to_ccy',
                'u:UNIQUE (from_ccy, to_ccy, rate_date)'
            ] THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: unexpected constraints %',
                    constraint_shape;
            END IF;

            SELECT array_agg(
                       index_class.relname || ':' ||
                       pg_get_indexdef(index_record.indexrelid)
                       ORDER BY index_class.relname
                   )
              INTO index_shape
              FROM pg_index AS index_record
              JOIN pg_class AS index_class
                ON index_class.oid = index_record.indexrelid
             WHERE index_record.indrelid = 'public.exchange_rate_cache'::regclass;
            IF index_shape <> ARRAY[
                'exchange_rate_cache_pkey:CREATE UNIQUE INDEX exchange_rate_cache_pkey ON public.exchange_rate_cache USING btree (id)',
                'idx_exchange_rate_cache_date:CREATE INDEX idx_exchange_rate_cache_date ON public.exchange_rate_cache USING btree (rate_date)',
                'idx_exchange_rate_cache_from_to:CREATE INDEX idx_exchange_rate_cache_from_to ON public.exchange_rate_cache USING btree (from_ccy, to_ccy)',
                'uq_exchange_rate_cache_pair_date:CREATE UNIQUE INDEX uq_exchange_rate_cache_pair_date ON public.exchange_rate_cache USING btree (from_ccy, to_ccy, rate_date)'
            ] THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: unexpected indexes %',
                    index_shape;
            END IF;

            SELECT count(*) INTO user_trigger_count
              FROM pg_trigger
             WHERE tgrelid = 'public.exchange_rate_cache'::regclass
               AND NOT tgisinternal;
            IF user_trigger_count <> 0 THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: % user-defined triggers remain',
                    user_trigger_count;
            END IF;

            SELECT count(*) INTO stored_rows FROM public.exchange_rate_cache;
            IF stored_rows <> 0 THEN
                RAISE EXCEPTION
                    'exchange_rate_cache retirement refused: % rows remain',
                    stored_rows;
            END IF;

            -- destructive-ok: only the exact, empty legacy table reaches this
            -- statement. DROP without CASCADE preserves unexpected dependents.
            DROP TABLE public.exchange_rate_cache;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS exchange_rate_cache (
            id SERIAL PRIMARY KEY,
            from_ccy CHAR(3) NOT NULL,
            to_ccy CHAR(3) NOT NULL,
            rate_date DATE NOT NULL,
            rate NUMERIC(20,10) NOT NULL,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_exchange_rate_cache_pair_date
                UNIQUE (from_ccy, to_ccy, rate_date),
            CONSTRAINT ck_exchange_rate_cache_rate_positive CHECK (rate > 0)
        );
        CREATE INDEX IF NOT EXISTS idx_exchange_rate_cache_date
            ON exchange_rate_cache (rate_date);
        CREATE INDEX IF NOT EXISTS idx_exchange_rate_cache_from_to
            ON exchange_rate_cache (from_ccy, to_ccy);
        """
    )
