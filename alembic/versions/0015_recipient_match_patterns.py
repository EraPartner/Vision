"""Recipient match patterns — generalized description normalization

Revision ID: 0015_recipient_match_patterns
Revises: 0014_drop_bank_reconciliation
Create Date: 2026-04-26

Introduces per-recipient match patterns so the import pipeline can normalize
variable bank descriptions (embedded dates, reference numbers, batch IDs) to
a canonical recipient without per-bank hardcoding.

Changes:
  * recipient_match_patterns — stores user-editable literal_prefix / glob /
    regex patterns bound to a recipient. The pattern phase runs before fuzzy
    matching in the import pipeline.

  * import_staging_rows — adds match_source, matched_pattern_id,
    match_similarity, user_override_recipient_id so the preview UI can
    surface exactly how each row was resolved.

  * transactions — adds matched_pattern_id so the transaction detail view
    can show which rule linked the transaction.

  * import_batches status constraint — extended with 'awaiting_review' for
    batches that contain fuzzy / pattern / new rows and need user review
    before commit.
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0015_recipient_match_patterns'
down_revision: Union[str, Sequence[str], None] = '0014_drop_bank_reconciliation'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # recipient_match_patterns
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TABLE IF NOT EXISTS recipient_match_patterns (
            id              SERIAL PRIMARY KEY,
            recipient_id    INTEGER NOT NULL
                                REFERENCES recipients(id) ON DELETE CASCADE,
            pattern         TEXT    NOT NULL,
            pattern_kind    TEXT    NOT NULL DEFAULT 'literal_prefix'
                                CHECK (pattern_kind IN ('regex', 'glob', 'literal_prefix')),
            case_sensitive  BOOLEAN NOT NULL DEFAULT false,
            priority        INTEGER NOT NULL DEFAULT 100,
            is_active       BOOLEAN NOT NULL DEFAULT true,
            source          TEXT    NOT NULL DEFAULT 'user'
                                CHECK (source IN ('user', 'suggested', 'system')),
            notes           TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_rmp_active_priority
            ON recipient_match_patterns (priority)
            WHERE is_active = true
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_rmp_recipient
            ON recipient_match_patterns (recipient_id)
    """)

    op.execute("""
        CREATE TRIGGER update_recipient_match_patterns_updated_at
            BEFORE UPDATE ON recipient_match_patterns
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    """)

    # ------------------------------------------------------------------
    # import_staging_rows — add resolution metadata columns
    # ------------------------------------------------------------------
    op.execute("""
        ALTER TABLE import_staging_rows
            ADD COLUMN IF NOT EXISTS match_source TEXT
                CHECK (match_source IN ('exact', 'fuzzy', 'pattern', 'new')),
            ADD COLUMN IF NOT EXISTS matched_pattern_id INTEGER
                REFERENCES recipient_match_patterns(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS match_similarity REAL,
            ADD COLUMN IF NOT EXISTS user_override_recipient_id INTEGER
                REFERENCES recipients(id) ON DELETE SET NULL
    """)

    # ------------------------------------------------------------------
    # transactions — carry forward which pattern resolved the link
    # ------------------------------------------------------------------
    op.execute("""
        ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS matched_pattern_id INTEGER
                REFERENCES recipient_match_patterns(id) ON DELETE SET NULL
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_transactions_matched_pattern
            ON transactions (matched_pattern_id)
            WHERE matched_pattern_id IS NOT NULL
    """)

    # ------------------------------------------------------------------
    # import_batches — extend status constraint to include awaiting_review
    #
    # The inline CHECK has an auto-generated name; discover and drop it
    # safely before adding the replacement.
    # ------------------------------------------------------------------
    op.execute("""
        DO $$
        DECLARE
            cname TEXT;
        BEGIN
            SELECT conname INTO cname
              FROM pg_constraint
             WHERE conrelid = 'import_batches'::regclass
               AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%status%';
            IF cname IS NOT NULL THEN
                EXECUTE 'ALTER TABLE import_batches DROP CONSTRAINT ' || quote_ident(cname);
            END IF;
        END $$
    """)

    op.execute("""
        ALTER TABLE import_batches
            ADD CONSTRAINT import_batches_status_check
            CHECK (status IN (
                'pending', 'staging', 'validating', 'matching',
                'committing', 'complete', 'failed', 'aborted',
                'awaiting_review'
            ))
    """)


def downgrade() -> None:
    # Restore original status constraint
    op.execute("""
        DO $$
        DECLARE
            cname TEXT;
        BEGIN
            SELECT conname INTO cname
              FROM pg_constraint
             WHERE conrelid = 'import_batches'::regclass
               AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%status%';
            IF cname IS NOT NULL THEN
                EXECUTE 'ALTER TABLE import_batches DROP CONSTRAINT ' || quote_ident(cname);
            END IF;
        END $$
    """)

    op.execute("""
        ALTER TABLE import_batches
            ADD CONSTRAINT import_batches_status_check
            CHECK (status IN (
                'pending', 'staging', 'validating', 'matching',
                'committing', 'complete', 'failed', 'aborted'
            ))
    """)

    op.execute("DROP INDEX IF EXISTS idx_transactions_matched_pattern")
    op.execute("ALTER TABLE transactions DROP COLUMN IF EXISTS matched_pattern_id")

    op.execute("ALTER TABLE import_staging_rows DROP COLUMN IF EXISTS user_override_recipient_id")
    op.execute("ALTER TABLE import_staging_rows DROP COLUMN IF EXISTS match_similarity")
    op.execute("ALTER TABLE import_staging_rows DROP COLUMN IF EXISTS matched_pattern_id")
    op.execute("ALTER TABLE import_staging_rows DROP COLUMN IF EXISTS match_source")

    op.execute("DROP TRIGGER IF EXISTS update_recipient_match_patterns_updated_at ON recipient_match_patterns")
    op.execute("DROP INDEX IF EXISTS idx_rmp_recipient")
    op.execute("DROP INDEX IF EXISTS idx_rmp_active_priority")
    op.execute("DROP TABLE IF EXISTS recipient_match_patterns")
