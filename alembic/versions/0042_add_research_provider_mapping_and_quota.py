"""Add research aggregation tables: instrument_provider_map + provider_quota.

Revision ID: 0042_add_research_provider_mapping_and_quota
Revises: 0041_add_parser_config_kind
Create Date: 2026-06-16

Supports the multi-provider Research section (ADR-079). Two narrow, additive
tables. Research market data for arbitrary symbols is fetched live and cached
in memory only — it is NEVER persisted here or in asset_price_history. Only two
things persist:

1. `instrument_provider_map` — the user-confirmed cross-provider symbol map, the
   fool-proof anchor against silent wrong-instrument merges. One row per
   (instrument_key, key_type, provider). `instrument_key` is an ISIN for
   stocks/ETFs/bonds (`key_type='isin'`) or a Vision-internal id for
   crypto/metals/custom (`key_type='internal'`). `resolved_name` / `exchange` /
   `currency` are captured from the provider's search result so the confirm UI
   can show what each symbol actually resolves to and the self-audit can compare
   currency across providers. `status` distinguishes a user-`confirmed` mapping
   from an `auto`-proposed one and remembers a `failed` lookup (so the same
   provider is not re-searched every visit). `verified_at` stamps the last
   successful cross-provider sanity check.

2. `provider_quota` — per-provider, per-UTC-day request counters. The quota
   governor's per-minute buckets live in memory, but the per-day counters must
   survive restarts: an in-memory-only counter would let a frequently-restarted
   backend blow a daily cap (e.g. Alpha Vantage's ~25/day). Composite PK
   (provider, window_date) is the ON CONFLICT upsert target for the governor's
   spend() path.

Both `updated_at` columns are maintained by the shared
`update_updated_at_column()` trigger function (defined in the baseline schema).

Blast radius: purely additive — two new tables, no change to any existing table,
column, view, or index. No data backfill. The downgrade drops both tables; it is
destructive only to the research symbol mappings and quota counters (no other
data depends on them, and no FK references them).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0042_add_research_provider_mapping_and_quota"
down_revision: Union[str, Sequence[str], None] = "0041_add_parser_config_kind"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- instrument_provider_map ------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS instrument_provider_map (
            id              SERIAL PRIMARY KEY,
            instrument_key  TEXT NOT NULL,
            key_type        TEXT NOT NULL DEFAULT 'isin',
            provider        TEXT NOT NULL,
            provider_symbol TEXT,
            resolved_name   TEXT,
            exchange        TEXT,
            currency        TEXT,
            status          TEXT NOT NULL DEFAULT 'auto',
            verified_at     TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        ALTER TABLE instrument_provider_map
          DROP CONSTRAINT IF EXISTS ck_instrument_provider_map_key_type;
    """)
    op.execute("""
        ALTER TABLE instrument_provider_map
          ADD CONSTRAINT ck_instrument_provider_map_key_type
          CHECK (key_type IN ('isin','internal'));
    """)

    op.execute("""
        ALTER TABLE instrument_provider_map
          DROP CONSTRAINT IF EXISTS ck_instrument_provider_map_status;
    """)
    op.execute("""
        ALTER TABLE instrument_provider_map
          ADD CONSTRAINT ck_instrument_provider_map_status
          CHECK (status IN ('confirmed','auto','failed'));
    """)

    # One mapping per instrument per provider.
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_provider_map_key_provider
          ON instrument_provider_map (instrument_key, key_type, provider);
    """)
    # Reverse lookup + self-audit (which instrument does this provider symbol back?).
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_instrument_provider_map_provider_symbol
          ON instrument_provider_map (provider, provider_symbol);
    """)

    op.execute(
        "DROP TRIGGER IF EXISTS update_instrument_provider_map_updated_at ON instrument_provider_map;"
    )
    op.execute("""
        CREATE TRIGGER update_instrument_provider_map_updated_at
            BEFORE UPDATE ON instrument_provider_map
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)

    # --- provider_quota ---------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS provider_quota (
            provider    TEXT NOT NULL,
            window_date DATE NOT NULL,
            count       INTEGER NOT NULL DEFAULT 0,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (provider, window_date)
        );
    """)

    op.execute("""
        ALTER TABLE provider_quota
          DROP CONSTRAINT IF EXISTS ck_provider_quota_count_nonneg;
    """)
    op.execute("""
        ALTER TABLE provider_quota
          ADD CONSTRAINT ck_provider_quota_count_nonneg
          CHECK (count >= 0);
    """)

    op.execute(
        "DROP TRIGGER IF EXISTS update_provider_quota_updated_at ON provider_quota;"
    )
    op.execute("""
        CREATE TRIGGER update_provider_quota_updated_at
            BEFORE UPDATE ON provider_quota
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS update_provider_quota_updated_at ON provider_quota;"
    )
    op.execute("DROP TABLE IF EXISTS provider_quota;")

    op.execute(
        "DROP TRIGGER IF EXISTS update_instrument_provider_map_updated_at ON instrument_provider_map;"
    )
    op.execute("DROP INDEX IF EXISTS ix_instrument_provider_map_provider_symbol;")
    op.execute("DROP INDEX IF EXISTS uq_instrument_provider_map_key_provider;")
    op.execute("DROP TABLE IF EXISTS instrument_provider_map;")
