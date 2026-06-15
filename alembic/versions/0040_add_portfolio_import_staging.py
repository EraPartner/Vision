"""Add portfolio import staging tables.

Revision ID: 0040_add_portfolio_import_staging
Revises: 0039_add_value_fx_neutral_to_snapshots
Create Date: 2026-06-15

Portfolio CSV import (brokerage/exchange trades → portfolio_transactions) runs
through the same stage → validate → match → review → commit pipeline as the
bank-statement import, but with portfolio semantics. The recipient-shaped
import_staging_rows table doesn't fit (no recipient/category, but units/price/
type/instrument matching instead), so this adds dedicated tables.

`portfolio_import_batches` mirrors `import_batches` plus the import-wide defaults
chosen in the UI (default_asset_class, default_type) and an `awaiting_review`
status (a wrong instrument match silently corrupts cost basis, so portfolio
imports route to review unless every row matched by exact symbol).

`portfolio_import_staging_rows` holds the parsed/normalized row, the resolved /
user-overridden investment match, and per-row error so the review screen can
group by instrument and surface oversell / unmatched / bad-date failures.

Blast radius: additive only — two new tables, no change to existing tables.
Rollback drops both (staging rows cascade from the batch FK).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0040_add_portfolio_import_staging"
down_revision: Union[str, Sequence[str], None] = (
    "0039_add_value_fx_neutral_to_snapshots"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS portfolio_import_batches (
          id BIGSERIAL PRIMARY KEY,
          adapter_name TEXT NOT NULL,
          source_filename TEXT,
          source_size_bytes BIGINT,
          custom_config JSONB,
          default_asset_class asset_class,
          default_type portfolio_txn_type,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','staging','validating','matching','awaiting_review','committing','complete','failed','aborted')),
          rows_total INTEGER NOT NULL DEFAULT 0,
          rows_imported INTEGER NOT NULL DEFAULT 0,
          rows_duplicate INTEGER NOT NULL DEFAULT 0,
          rows_error INTEGER NOT NULL DEFAULT 0,
          error_summary TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        );
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS portfolio_import_staging_rows (
          id BIGSERIAL PRIMARY KEY,
          batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE CASCADE,
          row_index INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','validated','matched','committed','duplicate','error')),
          tx_date DATE,
          type_raw TEXT,
          type portfolio_txn_type,
          symbol_raw TEXT,
          name_raw TEXT,
          units NUMERIC(18, 8),
          price_per_unit NUMERIC(18, 6),
          amount NUMERIC(18, 4),
          fees NUMERIC(18, 4),
          taxes NUMERIC(18, 4),
          currency TEXT,
          fx_rate_to_eur NUMERIC(20, 10),
          note TEXT,
          raw_data TEXT,
          tx_hash TEXT,
          resolved_investment_id INTEGER REFERENCES investments(id) ON DELETE SET NULL,
          user_override_investment_id INTEGER REFERENCES investments(id) ON DELETE SET NULL,
          match_source TEXT,
          match_similarity REAL,
          committed_txn_id INTEGER,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_portfolio_import_batches_status
          ON portfolio_import_batches (status)
          WHERE status NOT IN ('complete','failed','aborted');
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_portfolio_import_batches_started_at
          ON portfolio_import_batches (started_at DESC);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pf_staging_batch_status
          ON portfolio_import_staging_rows (batch_id, status);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pf_staging_tx_hash
          ON portfolio_import_staging_rows (tx_hash)
          WHERE tx_hash IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS portfolio_import_staging_rows;")
    op.execute("DROP TABLE IF EXISTS portfolio_import_batches;")
