"""Separate exact import provenance from versioned duplicate identity.

Revision ID: 0103_import_identity_provenance
Revises: 0102_retire_adr090_transaction_schema
Create Date: 2026-09-09

Adds immutable account identities, non-unique source-record hashes, and
versioned occurrence fingerprints. Historical tx_hash values are neither
rewritten nor backfilled because their inputs mixed literal and reconstructed
records. New application writes use the fingerprint as the compatibility
tx_hash, while the new partial unique indexes are the canonical race guards.

Blast radius: additive metadata columns and indexes only. Existing rows remain
NULL. Downgrade removes the new metadata, including account import identities;
ledger and staging business data remain intact.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0103_import_identity_provenance"
down_revision: Union[str, Sequence[str], None] = "0102_retire_adr090_transaction_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_STAGING_TABLES = ("import_staging_rows", "portfolio_import_staging_rows")
_CANONICAL_TABLES = ("transactions", "portfolio_transactions")


def _add_identity_columns(table: str, *, staging: bool) -> None:
    extras = (
        """
            ADD COLUMN IF NOT EXISTS source_transaction_id TEXT,
            ADD COLUMN IF NOT EXISTS source_account_identity TEXT,
            ADD COLUMN IF NOT EXISTS dedup_occurrence INTEGER,
    """
        if staging
        else ""
    )
    op.execute(f"""
        ALTER TABLE {table}
            {extras}
            ADD COLUMN IF NOT EXISTS source_record_hash CHAR(64),
            ADD COLUMN IF NOT EXISTS dedup_fingerprint CHAR(64),
            ADD COLUMN IF NOT EXISTS dedup_fingerprint_version SMALLINT;
    """)
    op.execute(f"""
        ALTER TABLE {table}
          ADD CONSTRAINT chk_{table}_source_record_hash
            CHECK (source_record_hash IS NULL OR source_record_hash ~ '^[0-9a-f]{{64}}$'),
          ADD CONSTRAINT chk_{table}_dedup_fingerprint
            CHECK (dedup_fingerprint IS NULL OR dedup_fingerprint ~ '^[0-9a-f]{{64}}$'),
          ADD CONSTRAINT chk_{table}_dedup_pair
            CHECK ((dedup_fingerprint IS NULL) = (dedup_fingerprint_version IS NULL)),
          ADD CONSTRAINT chk_{table}_dedup_version
            CHECK (dedup_fingerprint_version IS NULL OR dedup_fingerprint_version > 0)
          {", ADD CONSTRAINT chk_" + table + "_dedup_occurrence CHECK (dedup_occurrence IS NULL OR dedup_occurrence > 0)" if staging else ""};
    """)


def upgrade() -> None:
    op.execute("""
        ALTER TABLE accounts
          ADD COLUMN IF NOT EXISTS import_identity UUID NOT NULL DEFAULT gen_random_uuid();
        CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_import_identity
          ON accounts (import_identity);
    """)

    for table in _STAGING_TABLES:
        _add_identity_columns(table, staging=True)
        op.execute(f"""
            CREATE INDEX IF NOT EXISTS idx_{table}_dedup_fingerprint
              ON {table} (batch_id, dedup_fingerprint_version, dedup_fingerprint)
              WHERE dedup_fingerprint IS NOT NULL;
        """)

    for table in _CANONICAL_TABLES:
        _add_identity_columns(table, staging=False)
        op.execute(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_{table}_dedup_fingerprint
              ON {table} (dedup_fingerprint_version, dedup_fingerprint)
              WHERE dedup_fingerprint IS NOT NULL;
        """)


def downgrade() -> None:
    for table in _CANONICAL_TABLES:
        op.execute(f"DROP INDEX IF EXISTS uq_{table}_dedup_fingerprint;")
    for table in _STAGING_TABLES:
        op.execute(f"DROP INDEX IF EXISTS idx_{table}_dedup_fingerprint;")

    for table in (*_STAGING_TABLES, *_CANONICAL_TABLES):
        op.execute(f"""
            ALTER TABLE {table}
              DROP CONSTRAINT IF EXISTS chk_{table}_dedup_occurrence,
              DROP CONSTRAINT IF EXISTS chk_{table}_dedup_version,
              DROP CONSTRAINT IF EXISTS chk_{table}_dedup_pair,
              DROP CONSTRAINT IF EXISTS chk_{table}_dedup_fingerprint,
              DROP CONSTRAINT IF EXISTS chk_{table}_source_record_hash,
              DROP COLUMN IF EXISTS dedup_occurrence,
              DROP COLUMN IF EXISTS source_account_identity,
              DROP COLUMN IF EXISTS source_transaction_id,
              DROP COLUMN IF EXISTS dedup_fingerprint_version,
              DROP COLUMN IF EXISTS dedup_fingerprint,
              DROP COLUMN IF EXISTS source_record_hash;
        """)

    op.execute("DROP INDEX IF EXISTS uq_accounts_import_identity;")
    op.execute("ALTER TABLE accounts DROP COLUMN IF EXISTS import_identity;")
