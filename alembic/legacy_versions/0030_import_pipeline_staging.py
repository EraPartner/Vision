"""Import pipeline staging tables — Phase 7 of the non-portfolio refactor.

Revision ID: 0030_import_pipeline_staging
Revises: 0029_recipient_category_uniqueness
Create Date: 2026-04-16

Introduces two tables supporting the staged, atomic, resumable import
pipeline in `services/importPipeline/`:

  * `import_batches` — one row per CSV upload. Tracks lifecycle status,
    counters (rows_total, rows_imported, rows_duplicate, rows_error),
    source file metadata, bank adapter used, and error summary. Enables
    resume-on-restart for long imports and SSE progress reconnects.

  * `import_staging_rows` — per-row staging. Each row carries parsed
    transaction fields plus original raw text for audit. `status`
    tracks per-row lifecycle (`pending|validated|matched|committed|
    duplicate|error`). Chunked `BEGIN/COMMIT` (1000 rows) drains this
    table into canonical `transactions` atomically.

Pipeline flow:
  stage   → writes `pending` rows
  validate→ marks `validated` or `error`
  match   → pg_trgm recipient lookup, stores resolved_recipient_id
  commit  → chunked drain, flips to `committed` or `duplicate`

Both tables are cleared on batch completion (status=complete) after a
7-day retention for troubleshooting.

Rollback: drop tables. Canonical transactions table unaffected.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0030_import_pipeline_staging'
down_revision: Union[str, Sequence[str], None] = '0029_recipient_category_uniqueness'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # import_batches — one row per CSV upload
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS import_batches (
            id BIGSERIAL PRIMARY KEY,
            adapter_name TEXT NOT NULL,
            source_filename TEXT,
            source_size_bytes BIGINT,
            custom_config JSONB,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN (
                    'pending', 'staging', 'validating', 'matching',
                    'committing', 'complete', 'failed', 'aborted'
                )),
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
        CREATE INDEX IF NOT EXISTS idx_import_batches_status
        ON import_batches (status)
        WHERE status NOT IN ('complete', 'failed', 'aborted');
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_import_batches_started_at
        ON import_batches (started_at DESC);
    """)

    # ------------------------------------------------------------------
    # import_staging_rows — per-row staging bound to a batch
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS import_staging_rows (
            id BIGSERIAL PRIMARY KEY,
            batch_id BIGINT NOT NULL
                REFERENCES import_batches(id) ON DELETE CASCADE,
            row_index INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN (
                    'pending', 'validated', 'matched',
                    'committed', 'duplicate', 'error'
                )),
            -- Parsed transaction fields (denormalized for atomic commit)
            tx_date DATE,
            bank_account TEXT,
            recipient_raw TEXT,
            memo TEXT,
            amount NUMERIC(20, 4),
            currency TEXT,
            balance NUMERIC(20, 4),
            recipient_account TEXT,
            recipient_address TEXT,
            recipient_bank_name TEXT,
            comment TEXT,
            raw_data TEXT,
            tx_hash TEXT,
            -- Resolution
            resolved_recipient_id INTEGER,
            resolved_bank_account_id INTEGER,
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_staging_batch_status
        ON import_staging_rows (batch_id, status);
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_staging_tx_hash
        ON import_staging_rows (tx_hash)
        WHERE tx_hash IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS import_staging_rows CASCADE;")
    op.execute("DROP TABLE IF EXISTS import_batches CASCADE;")
