"""Source-owned brokerage cash classification and immutable staged after-images.

Blast radius: extend the existing origin CHECK; protect only typed recorded
cash envelopes. No financial rewrite or backfill. Downgrade refuses remaining
brokerage rows, retains raw receipt data, and removes its protective trigger.
"""
from alembic import op

revision = "0125_brokerage_cash_origin"
down_revision = "0124_portfolio_income_recognition"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE transactions DROP CONSTRAINT chk_transactions_transfer_source;
      ALTER TABLE transactions ADD CONSTRAINT chk_transactions_transfer_source
        CHECK(transfer_source IS NULL OR transfer_source IN ('auto','manual','opening','adjustment','brokerage'));
      CREATE FUNCTION portfolio_cash_receipt(data TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE envelope JSONB;
      BEGIN
        BEGIN envelope := data::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
        IF envelope->'portfolioCashReceipt'->>'version'='1'
          AND envelope->'portfolioCashReceipt'->'proof'->>'kind'='closed_kinesis_cash'
          AND jsonb_typeof(envelope->'portfolioCashReceipt'->'after')='object'
        THEN RETURN envelope->'portfolioCashReceipt'; END IF;
        RETURN NULL;
      END $$;
      CREATE FUNCTION guard_portfolio_cash_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF portfolio_cash_receipt(OLD.raw_data) IS NOT NULL
          AND (TG_OP='DELETE' OR NEW.raw_data IS DISTINCT FROM OLD.raw_data) THEN
          RAISE EXCEPTION 'Recorded brokerage cash source evidence is immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_portfolio_cash_receipt_immutable BEFORE UPDATE OR DELETE
        ON portfolio_import_staging_rows FOR EACH ROW EXECUTE FUNCTION guard_portfolio_cash_receipt();
    """)


def downgrade() -> None:
    op.execute("""
      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM transactions WHERE transfer_source='brokerage') THEN
          RAISE EXCEPTION 'Remove brokerage cash through guarded import rollback before downgrade';
        END IF;
      END $$;
      DROP TRIGGER trg_portfolio_cash_receipt_immutable ON portfolio_import_staging_rows;
      DROP FUNCTION guard_portfolio_cash_receipt();
      DROP FUNCTION portfolio_cash_receipt(TEXT);
      ALTER TABLE transactions DROP CONSTRAINT chk_transactions_transfer_source;
      ALTER TABLE transactions ADD CONSTRAINT chk_transactions_transfer_source
        CHECK(transfer_source IS NULL OR transfer_source IN ('auto','manual','opening','adjustment'));
    """)
