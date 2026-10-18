"""Preserve bank-provided within-day chronology for balance anchors.

Blast radius: nullable metadata on staging and posted transactions. Existing
Belfius rows are backfilled only from retained raw source records bound by the
same batch and source hash. No amounts, balances or editable comments change.
Rollback drops chronology metadata, restoring the old insertion-order fallback;
amounts and source records survive. Never run against user data without approval.
"""

from alembic import op

revision = "0127_bank_chronology"
down_revision = "0126_income_recognition_check_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE transactions ADD COLUMN bank_sequence NUMERIC(18,0)
        CONSTRAINT chk_transactions_bank_sequence CHECK (bank_sequence >= 0);
      ALTER TABLE import_staging_rows ADD COLUMN bank_sequence NUMERIC(18,0)
        CONSTRAINT chk_import_staging_bank_sequence CHECK (bank_sequence >= 0);

      WITH source AS (
        SELECT s.id,
          regexp_match(s.raw_data, '^[^;\\r\\n]*;[^;\\r\\n]*;([0-9]{1,9});([0-9]{1,9});') AS sequence
        FROM import_staging_rows s
        JOIN import_batches b ON b.id = s.batch_id
        WHERE b.adapter_name = 'belfius' AND s.source_record_hash IS NOT NULL
      )
      UPDATE import_staging_rows s
      SET bank_sequence = source.sequence[1]::numeric * 1000000000 + source.sequence[2]::numeric
      FROM source WHERE s.id = source.id AND source.sequence IS NOT NULL;

      WITH verified AS (
        SELECT s.batch_id, s.source_record_hash, s.tx_date, s.amount, s.currency,
          min(s.bank_sequence) AS bank_sequence
        FROM import_staging_rows s
        JOIN import_batches b ON b.id = s.batch_id AND b.adapter_name = 'belfius'
        WHERE s.source_record_hash IS NOT NULL
        GROUP BY s.batch_id, s.source_record_hash, s.tx_date, s.amount, s.currency
        HAVING count(s.bank_sequence) = count(*)
          AND min(s.bank_sequence) = max(s.bank_sequence)
      )
      UPDATE transactions t SET bank_sequence = s.bank_sequence
      FROM verified s
      WHERE t.import_batch_id = s.batch_id
        AND t.source_record_hash = s.source_record_hash
        AND t.date = s.tx_date AND t.amount = s.amount AND t.currency = s.currency
        AND s.bank_sequence IS NOT NULL;

      CREATE INDEX idx_transactions_bank_chronology
        ON transactions (account_id, currency, date DESC,
          (COALESCE(bank_sequence, 1000000000000000000000000000000::numeric + id)) DESC, id DESC)
        WHERE is_active = true;
    """)


def downgrade() -> None:
    op.execute("""
      DROP INDEX idx_transactions_bank_chronology;
      ALTER TABLE import_staging_rows DROP COLUMN bank_sequence;
      ALTER TABLE transactions DROP COLUMN bank_sequence;
    """)
