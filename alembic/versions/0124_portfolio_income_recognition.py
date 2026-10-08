"""Retain proved in-kind income separately from gains and its paired unit proof.

Revision ID: 0124_portfolio_income_recognition
Revises: 0123_portfolio_asset_adjustments

Blast radius: default-standard accounting column and an initially empty immutable
pair journal. No financial inference, backfill or existing receipt rewrite.
Only acquisitions/income referenced by an active pair are guarded against image
changes. Restore income first through application rollback to release that guard.
Downgrade refuses included income and active pairs; restored evidence is removed.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0124_portfolio_income_recognition"
down_revision: Union[str, Sequence[str], None] = "0123_portfolio_asset_adjustments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE portfolio_transactions ADD COLUMN income_recognition_role TEXT NOT NULL DEFAULT 'standard';
      ALTER TABLE portfolio_transactions ADD CONSTRAINT ck_portfolio_income_recognition_role
        CHECK (income_recognition_role IN ('standard','included_in_units') AND
               (income_recognition_role = 'standard' OR type = 'dividend'));
      CREATE FUNCTION normalize_portfolio_income_snapshot(data JSONB) RETURNS JSONB
        LANGUAGE SQL IMMUTABLE AS $$ SELECT CASE WHEN COALESCE(data->>'income_recognition_role','standard')='standard'
          THEN data-'income_recognition_role' ELSE data END $$;
      CREATE FUNCTION portfolio_income_transaction_snapshot(t portfolio_transactions) RETURNS JSONB
        LANGUAGE SQL STABLE AS $$ SELECT normalize_portfolio_income_snapshot(jsonb_build_object(
          'id',t.id,'investment_id',t.investment_id,'type',t.type,'date',to_char(t.date,'YYYY-MM-DD'),
          'amount',t.amount::text,'units',t.units::text,'price_per_unit',t.price_per_unit::text,
          'fees',t.fees::text,'taxes',t.taxes::text,'currency',t.currency,'fx_rate_to_eur',t.fx_rate_to_eur::text,
          'account_id',t.account_id,'note',t.note,'dividend_amount_convention',t.dividend_amount_convention,
          'is_recurring',t.is_recurring,'recurrence_interval',t.recurrence_interval,
          'recurrence_end_date',to_char(t.recurrence_end_date,'YYYY-MM-DD'),'import_batch_id',t.import_batch_id::text,
          'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,
          'dedup_fingerprint_version',t.dedup_fingerprint_version,'income_recognition_role',t.income_recognition_role)) $$;
      CREATE TABLE portfolio_import_income_recognition_journal (
        id BIGSERIAL PRIMARY KEY,
        batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
        staging_row_id BIGINT NOT NULL REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
        unit_staging_row_id BIGINT NOT NULL REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
        income_transaction_id INTEGER NOT NULL CHECK(income_transaction_id>0),
        unit_transaction_id INTEGER NOT NULL CHECK(unit_transaction_id>0),
        action TEXT NOT NULL CHECK(action IN ('record','restore')),
        previous_entry_id BIGINT UNIQUE REFERENCES portfolio_import_income_recognition_journal(id) ON DELETE RESTRICT,
        income_data JSONB NOT NULL CHECK(jsonb_typeof(income_data)='object'),
        unit_data JSONB NOT NULL CHECK(jsonb_typeof(unit_data)='object'),
        proof_data JSONB NOT NULL CHECK(jsonb_typeof(proof_data)='object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK((action='restore')=(previous_entry_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX uq_portfolio_income_source ON portfolio_import_income_recognition_journal(staging_row_id) WHERE action='record';
      CREATE UNIQUE INDEX uq_portfolio_income_transaction ON portfolio_import_income_recognition_journal(income_transaction_id) WHERE action='record';
      CREATE INDEX idx_portfolio_income_batch ON portfolio_import_income_recognition_journal(batch_id,action);
      CREATE INDEX idx_portfolio_income_unit ON portfolio_import_income_recognition_journal(unit_transaction_id,action);
      CREATE TRIGGER portfolio_income_journal_immutable BEFORE UPDATE OR DELETE ON portfolio_import_income_recognition_journal
        FOR EACH ROW EXECUTE FUNCTION forbid_portfolio_import_receipt_mutation();
      CREATE FUNCTION validate_portfolio_income_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE income_image JSONB; unit_image JSONB;
      BEGIN
        SELECT portfolio_income_transaction_snapshot(t) INTO income_image FROM portfolio_transactions t WHERE t.id=NEW.income_transaction_id FOR UPDATE;
        SELECT portfolio_income_transaction_snapshot(t) INTO unit_image FROM portfolio_transactions t WHERE t.id=NEW.unit_transaction_id FOR UPDATE;
        IF income_image IS DISTINCT FROM NEW.income_data OR unit_image IS DISTINCT FROM NEW.unit_data THEN
          RAISE EXCEPTION 'Paired income current after-images changed';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM portfolio_import_staging_rows s JOIN portfolio_import_batches b ON b.id=s.batch_id
          WHERE s.id=NEW.staging_row_id AND b.id=NEW.batch_id AND s.type='dividend' AND s.route='portfolio'
            AND b.custom_config->>'format'='kinesis_transaction_history' AND b.custom_config->>'yield_basis_policy'='zero'
            AND b.custom_config->'kinesis_source_context'->>'source_file_hash'=NEW.proof_data->>'sourceFileHash') THEN
          RAISE EXCEPTION 'Paired income receipt requires its complete primary source';
        END IF;
        IF NEW.action='record' THEN
          IF income_image->>'income_recognition_role'<>'included_in_units' OR income_image->>'type'<>'dividend'
            OR income_image->>'units' IS NOT NULL OR income_image->>'price_per_unit' IS NOT NULL
            OR (income_image->>'amount')::numeric<0 OR (income_image->>'fees')::numeric<>0 OR (income_image->>'taxes')::numeric<>0
            OR income_image->>'fx_rate_to_eur' IS NOT NULL
            OR unit_image->>'type'<>'gift' OR (unit_image->>'amount')::numeric<>0
            OR (unit_image->>'price_per_unit')::numeric<>0 OR (unit_image->>'units')::numeric<=0
            OR (unit_image->>'fees')::numeric<>0 OR (unit_image->>'taxes')::numeric<>0
            OR income_image->>'investment_id' IS DISTINCT FROM unit_image->>'investment_id'
            OR income_image->>'account_id' IS DISTINCT FROM unit_image->>'account_id'
            OR income_image->>'date' IS DISTINCT FROM unit_image->>'date'
            OR income_image->>'source_record_hash' IS DISTINCT FROM unit_image->>'source_record_hash'
            OR EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.action='record' AND r.unit_transaction_id=NEW.unit_transaction_id
              AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id)) THEN
            RAISE EXCEPTION 'Paired income acquisition is invalid or already recognized';
          END IF;
        ELSIF NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.id=NEW.previous_entry_id AND r.action='record'
          AND r.batch_id=NEW.batch_id AND r.staging_row_id=NEW.staging_row_id AND r.unit_staging_row_id=NEW.unit_staging_row_id
          AND r.income_transaction_id=NEW.income_transaction_id AND r.unit_transaction_id=NEW.unit_transaction_id
          AND r.income_data=NEW.income_data AND r.unit_data=NEW.unit_data AND r.proof_data=NEW.proof_data) THEN
          RAISE EXCEPTION 'Invalid paired income restoration receipt';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER portfolio_income_valid_receipt BEFORE INSERT ON portfolio_import_income_recognition_journal
        FOR EACH ROW EXECUTE FUNCTION validate_portfolio_income_receipt();
      CREATE FUNCTION guard_active_portfolio_income_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.action='record'
          AND (r.unit_transaction_id=OLD.id OR r.income_transaction_id=OLD.id)
          AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id))
          AND (TG_OP='DELETE' OR portfolio_income_transaction_snapshot(NEW) IS DISTINCT FROM portfolio_income_transaction_snapshot(OLD)) THEN
          RAISE EXCEPTION 'Roll back active paired income before changing its income or acquisition';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER portfolio_income_active_pair_guard BEFORE UPDATE OR DELETE ON portfolio_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_active_portfolio_income_pair();
      CREATE FUNCTION require_portfolio_income_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM portfolio_transactions t WHERE t.id=NEW.id AND t.income_recognition_role='included_in_units')
          AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.income_transaction_id=NEW.id AND r.action='record'
            AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id)) THEN
          RAISE EXCEPTION 'In-kind income requires a proved active pair receipt';
        END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER portfolio_income_requires_pair AFTER INSERT OR UPDATE ON portfolio_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_portfolio_income_pair();
    """)


def downgrade() -> None:
    op.execute("""
      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM portfolio_transactions WHERE income_recognition_role<>'standard') OR
          EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal r WHERE r.action='record'
            AND NOT EXISTS(SELECT 1 FROM portfolio_import_income_recognition_journal undo WHERE undo.previous_entry_id=r.id)) THEN
          RAISE EXCEPTION 'Roll back included income and active pair receipts before downgrade';
        END IF;
      END $$;
      DROP TRIGGER portfolio_income_requires_pair ON portfolio_transactions;
      DROP TRIGGER portfolio_income_active_pair_guard ON portfolio_transactions;
      DROP TABLE portfolio_import_income_recognition_journal;
      DROP FUNCTION require_portfolio_income_pair();
      DROP FUNCTION guard_active_portfolio_income_pair();
      DROP FUNCTION validate_portfolio_income_receipt();
      DROP FUNCTION portfolio_income_transaction_snapshot(portfolio_transactions);
      DROP FUNCTION normalize_portfolio_income_snapshot(JSONB);
      ALTER TABLE portfolio_transactions DROP CONSTRAINT ck_portfolio_income_recognition_role;
      ALTER TABLE portfolio_transactions DROP COLUMN income_recognition_role;
    """)
