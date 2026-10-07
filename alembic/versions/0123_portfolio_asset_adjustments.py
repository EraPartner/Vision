"""Retain dated asset fees and explicitly known zero-basis yield reversals.

Upgrade adds an empty immutable event ledger and nullable import metadata. It
does not rewrite holdings. Downgrade requires validated rollback of adjustment
imports and preserves staging provenance when removing the additive schema.
"""

from alembic import op
import sqlalchemy as sa

revision = "0123_portfolio_asset_adjustments"
down_revision = "0122_portfolio_import_duplicate_repair"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE portfolio_asset_adjustments (
        id BIGINT PRIMARY KEY DEFAULT nextval('portfolio_transactions_id_seq'::regclass),
        investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE RESTRICT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        date DATE NOT NULL,
        units NUMERIC(18,8) NOT NULL CHECK (units > 0),
        adjustment_kind TEXT NOT NULL CHECK (adjustment_kind IN ('yield_reversal','asset_fee')),
        basis_policy TEXT NOT NULL CHECK (basis_policy IN ('zero_yield_only','carried')),
        eligible_source_record_hashes TEXT[] NOT NULL DEFAULT '{}'::text[],
        basis_allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
        import_batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
        staging_row_id BIGINT NOT NULL UNIQUE REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
        source_record_hash CHAR(64) NOT NULL CHECK (source_record_hash ~ '^[0-9a-f]{64}$'),
        dedup_fingerprint CHAR(64) NOT NULL CHECK (dedup_fingerprint ~ '^[0-9a-f]{64}$'),
        dedup_fingerprint_version SMALLINT NOT NULL CHECK (dedup_fingerprint_version > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((adjustment_kind='yield_reversal' AND basis_policy='zero_yield_only') OR
               (adjustment_kind='asset_fee' AND basis_policy='carried')),
        UNIQUE (dedup_fingerprint_version,dedup_fingerprint)
      );
      CREATE INDEX idx_portfolio_asset_adjustments_replay ON portfolio_asset_adjustments(investment_id,date,id);
      CREATE INDEX idx_portfolio_asset_adjustments_batch ON portfolio_asset_adjustments(import_batch_id);
      CREATE TABLE portfolio_asset_adjustment_sources (
        adjustment_id BIGINT NOT NULL REFERENCES portfolio_asset_adjustments(id) ON DELETE CASCADE,
        staging_row_id BIGINT NOT NULL REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
        source_record_hash CHAR(64) NOT NULL CHECK (source_record_hash ~ '^[0-9a-f]{64}$'),
        PRIMARY KEY (adjustment_id,staging_row_id)
      );
      CREATE FUNCTION reject_portfolio_asset_adjustment_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Asset adjustments are immutable; roll back their import batch'; END $$;
      CREATE TRIGGER portfolio_asset_adjustments_immutable BEFORE UPDATE ON portfolio_asset_adjustments
      FOR EACH ROW EXECUTE FUNCTION reject_portfolio_asset_adjustment_update();
      CREATE FUNCTION guard_portfolio_asset_adjustment_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' OR EXISTS (
          SELECT 1 FROM portfolio_asset_adjustments WHERE id=OLD.adjustment_id
        ) THEN
          RAISE EXCEPTION 'Asset adjustment source receipts are immutable; roll back their import batch';
        END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER portfolio_asset_adjustment_sources_immutable BEFORE UPDATE OR DELETE ON portfolio_asset_adjustment_sources
      FOR EACH ROW EXECUTE FUNCTION guard_portfolio_asset_adjustment_source_change();
    """)
    op.add_column(
        "portfolio_import_staging_rows",
        sa.Column("asset_adjustment_details", sa.JSON(), nullable=True),
    )
    op.drop_constraint(
        "chk_portfolio_import_staging_rows_route",
        "portfolio_import_staging_rows",
        type_="check",
    )
    op.create_check_constraint(
        "chk_portfolio_import_staging_rows_route",
        "portfolio_import_staging_rows",
        "route IS NULL OR route IN ('cash','portfolio','asset_transfer','account_internal','asset_adjustment')",
    )


def downgrade() -> None:
    if (
        op.get_bind()
        .execute(sa.text("SELECT EXISTS(SELECT 1 FROM portfolio_asset_adjustments)"))
        .scalar()
    ):
        raise RuntimeError(
            "Asset adjustments exist. Roll back their imports before downgrade; no history was removed."
        )
    op.execute(
        "UPDATE portfolio_import_staging_rows SET route=NULL,status='error',error_message='Asset adjustment schema was downgraded' WHERE route='asset_adjustment'"
    )
    op.drop_constraint(
        "chk_portfolio_import_staging_rows_route",
        "portfolio_import_staging_rows",
        type_="check",
    )
    op.create_check_constraint(
        "chk_portfolio_import_staging_rows_route",
        "portfolio_import_staging_rows",
        "route IS NULL OR route IN ('cash','portfolio','asset_transfer','account_internal')",
    )
    op.drop_column("portfolio_import_staging_rows", "asset_adjustment_details")
    op.drop_table("portfolio_asset_adjustment_sources")
    op.drop_table("portfolio_asset_adjustments")
    op.execute("DROP FUNCTION reject_portfolio_asset_adjustment_update()")
    op.execute("DROP FUNCTION guard_portfolio_asset_adjustment_source_change()")
