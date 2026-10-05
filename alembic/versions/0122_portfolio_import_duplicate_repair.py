"""Journal reviewed replacement of an imported copy with its original manual trade.

Blast radius: one additive empty append-only receipt table and its triggers.
Existing financial rows are not rewritten by this migration. Source batches
referenced by a repair cannot be pruned. Downgrade requires application rollback
of every active repair first; it never changes financial history itself.
"""

from typing import Sequence, Union
from alembic import op

revision: str = "0122_portfolio_import_duplicate_repair"
down_revision: Union[str, Sequence[str], None] = "0121_portfolio_asset_transfers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE portfolio_import_duplicate_repair_journal (
        id BIGSERIAL PRIMARY KEY,
        batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
        staging_row_id BIGINT NOT NULL REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
        original_import_batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
        legacy_transaction_id INTEGER NOT NULL,
        imported_transaction_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('repair','restore')),
        policy TEXT NOT NULL CHECK (policy IN ('preserve_existing','prefer_source')),
        before_data JSONB NOT NULL CHECK (jsonb_typeof(before_data) = 'object'),
        after_data JSONB NOT NULL CHECK (jsonb_typeof(after_data) = 'object'),
        previous_entry_id BIGINT UNIQUE REFERENCES portfolio_import_duplicate_repair_journal(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (legacy_transaction_id <> imported_transaction_id),
        CHECK (before_data ?& ARRAY['legacy','imported','originalBatch','originalStaging'] AND after_data ?& ARRAY['legacy','imported','originalBatch','originalStaging']),
        CHECK (jsonb_typeof(before_data->'legacy')='object' AND jsonb_typeof(after_data->'legacy')='object'),
        CHECK (jsonb_typeof(before_data->'originalBatch')='object' AND jsonb_typeof(after_data->'originalBatch')='object'),
        CHECK (jsonb_typeof(before_data->'originalStaging')='array' AND jsonb_typeof(after_data->'originalStaging')='array'),
        CHECK (jsonb_typeof(before_data->'imported') IN ('object','null') AND jsonb_typeof(after_data->'imported') IN ('object','null')),
        CHECK ((action='repair' AND jsonb_typeof(before_data->'imported')='object' AND jsonb_typeof(after_data->'imported')='null') OR (action='restore' AND jsonb_typeof(before_data->'imported')='null' AND jsonb_typeof(after_data->'imported')='object')),
        CHECK ((action = 'restore') = (previous_entry_id IS NOT NULL))
      );
      CREATE INDEX idx_portfolio_import_duplicate_repair_batch ON portfolio_import_duplicate_repair_journal(batch_id,action);
      CREATE UNIQUE INDEX uq_portfolio_import_duplicate_repair_source ON portfolio_import_duplicate_repair_journal(staging_row_id) WHERE action='repair';
      CREATE FUNCTION portfolio_duplicate_repair_state(data JSONB) RETURNS JSONB
        LANGUAGE SQL IMMUTABLE AS $$
        SELECT jsonb_set(jsonb_set(data,'{legacy}',(data->'legacy') - 'updated_at'),'{originalStaging}',
          COALESCE((SELECT jsonb_agg(item.value - 'updated_at' ORDER BY item.ordinality)
                    FROM jsonb_array_elements(data->'originalStaging') WITH ORDINALITY item),'[]'::jsonb))
      $$;
      CREATE FUNCTION enforce_portfolio_duplicate_repair_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION 'Portfolio duplicate repair receipts are immutable';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM portfolio_import_staging_rows source
          WHERE source.id=NEW.staging_row_id AND source.batch_id=NEW.batch_id) THEN
          RAISE EXCEPTION 'Duplicate repair receipt source does not belong to its batch';
        END IF;
        IF NEW.action='restore' AND NOT EXISTS (
          SELECT 1 FROM portfolio_import_duplicate_repair_journal repair
          WHERE repair.id=NEW.previous_entry_id AND repair.action='repair'
            AND repair.batch_id=NEW.batch_id AND repair.staging_row_id=NEW.staging_row_id
            AND repair.original_import_batch_id=NEW.original_import_batch_id
            AND repair.legacy_transaction_id=NEW.legacy_transaction_id
            AND repair.imported_transaction_id=NEW.imported_transaction_id AND repair.policy=NEW.policy
            AND portfolio_duplicate_repair_state(repair.after_data)=portfolio_duplicate_repair_state(NEW.before_data)
            AND portfolio_duplicate_repair_state(repair.before_data)=portfolio_duplicate_repair_state(NEW.after_data)
        ) THEN RAISE EXCEPTION 'Invalid portfolio duplicate repair restoration receipt'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER portfolio_duplicate_repair_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
        ON portfolio_import_duplicate_repair_journal FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_duplicate_repair_receipt();
    """)


def downgrade() -> None:
    op.execute("""
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM portfolio_import_duplicate_repair_journal repair
          WHERE repair.action='repair' AND NOT EXISTS (SELECT 1 FROM portfolio_import_duplicate_repair_journal restoration WHERE restoration.previous_entry_id=repair.id))
        THEN RAISE EXCEPTION 'Restore active portfolio duplicate repairs before downgrade'; END IF;
      END $$;
      DROP TABLE portfolio_import_duplicate_repair_journal;
      DROP FUNCTION enforce_portfolio_duplicate_repair_receipt();
      DROP FUNCTION portfolio_duplicate_repair_state(JSONB);
    """)
