"""Retain reversible portfolio history adoption receipts and source provenance.

Revision ID: 0120_portfolio_import_reconciliation
Revises: 0119_squashed_baseline

Blast radius: one additive, initially empty journal. No existing financial rows
are changed. Source batches and staging records referenced by receipts cannot
be deleted. Receipts are append-only; a restoration is a second receipt.

Rollback: restore active adoptions through the application before downgrading.
Downgrade refuses an active adoption, then drops the empty/restored journal and
its trigger. Financial rows remain unchanged. Never apply to user data without
the approved maintenance procedure.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0120_portfolio_import_reconciliation"
down_revision: Union[str, Sequence[str], None] = "0119_squashed_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE portfolio_import_reconciliation_journal (
          id BIGSERIAL PRIMARY KEY,
          batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
          staging_row_id BIGINT NOT NULL REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
          transaction_id INTEGER NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('adopt', 'restore')),
          policy TEXT NOT NULL CHECK (policy IN ('exact', 'preserve_existing', 'prefer_source')),
          previous_entry_id BIGINT UNIQUE REFERENCES portfolio_import_reconciliation_journal(id) ON DELETE RESTRICT,
          before_data JSONB NOT NULL CHECK (jsonb_typeof(before_data) = 'object'),
          after_data JSONB NOT NULL CHECK (jsonb_typeof(after_data) = 'object'),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK ((action = 'restore') = (previous_entry_id IS NOT NULL))
        );
        CREATE INDEX idx_portfolio_import_reconciliation_batch
          ON portfolio_import_reconciliation_journal (batch_id, action);
        CREATE UNIQUE INDEX uq_portfolio_import_adoption_source
          ON portfolio_import_reconciliation_journal (staging_row_id)
          WHERE action = 'adopt';
        CREATE FUNCTION forbid_portfolio_import_receipt_mutation() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'Portfolio import reconciliation receipts are immutable';
          END $$;
        CREATE TRIGGER portfolio_import_reconciliation_immutable
          BEFORE UPDATE OR DELETE ON portfolio_import_reconciliation_journal
          FOR EACH ROW EXECUTE FUNCTION forbid_portfolio_import_receipt_mutation();
        CREATE FUNCTION validate_portfolio_import_receipt() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM portfolio_import_staging_rows source
              WHERE source.id = NEW.staging_row_id AND source.batch_id = NEW.batch_id
            ) THEN
              RAISE EXCEPTION 'Reconciliation receipt source does not belong to its batch';
            END IF;
            IF NEW.action = 'restore' AND NOT EXISTS (
              SELECT 1 FROM portfolio_import_reconciliation_journal adoption
              WHERE adoption.id = NEW.previous_entry_id AND adoption.action = 'adopt'
                AND adoption.batch_id = NEW.batch_id
                AND adoption.staging_row_id = NEW.staging_row_id
                AND adoption.transaction_id = NEW.transaction_id
                AND adoption.policy = NEW.policy
                AND adoption.before_data = NEW.after_data
                AND adoption.after_data = NEW.before_data
            ) THEN
              RAISE EXCEPTION 'Invalid portfolio import restoration receipt';
            END IF;
            RETURN NEW;
          END $$;
        CREATE TRIGGER portfolio_import_reconciliation_valid_receipt
          BEFORE INSERT ON portfolio_import_reconciliation_journal
          FOR EACH ROW EXECUTE FUNCTION validate_portfolio_import_receipt();
    """)


def downgrade() -> None:
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM portfolio_import_reconciliation_journal adoption
            WHERE adoption.action = 'adopt'
              AND NOT EXISTS (
                SELECT 1 FROM portfolio_import_reconciliation_journal restoration
                WHERE restoration.previous_entry_id = adoption.id
              )
          ) THEN
            RAISE EXCEPTION 'Restore active portfolio import adoptions before downgrade';
          END IF;
        END $$;
        DROP TABLE portfolio_import_reconciliation_journal;
        DROP FUNCTION forbid_portfolio_import_receipt_mutation();
        DROP FUNCTION validate_portfolio_import_receipt();
    """)
