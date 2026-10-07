"""Add canonical dated internal asset custody events.

Revision ID: 0121_portfolio_asset_transfers
Revises: 0120_portfolio_import_reconciliation

Upgrade creates an empty ledger and nullable staging metadata, without changing
existing holdings. Downgrade refuses populated custody history: remove transfers
through the validated import rollback before downgrading.
"""

from alembic import op
import sqlalchemy as sa

revision = "0121_portfolio_asset_transfers"
down_revision = "0120_portfolio_import_reconciliation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE portfolio_asset_transfers (
        id BIGINT PRIMARY KEY DEFAULT nextval('portfolio_transactions_id_seq'::regclass),
        investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE RESTRICT,
        source_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        destination_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        date DATE NOT NULL,
        units NUMERIC(18,8) NOT NULL CHECK (units > 0),
        fee_units NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (fee_units >= 0 AND fee_units < units),
        fee_basis_allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
        import_batch_id BIGINT NOT NULL REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
        staging_row_id BIGINT NOT NULL UNIQUE REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
        source_record_hash CHAR(64) NOT NULL CHECK (source_record_hash ~ '^[0-9a-f]{64}$'),
        dedup_fingerprint CHAR(64) NOT NULL CHECK (dedup_fingerprint ~ '^[0-9a-f]{64}$'),
        dedup_fingerprint_version SMALLINT NOT NULL CHECK (dedup_fingerprint_version > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (source_account_id <> destination_account_id),
        UNIQUE (dedup_fingerprint_version, dedup_fingerprint)
      )
    """)
    op.execute(
        "CREATE INDEX idx_portfolio_asset_transfers_replay ON portfolio_asset_transfers(investment_id,date,id)"
    )
    op.execute(
        "CREATE INDEX idx_portfolio_asset_transfers_batch ON portfolio_asset_transfers(import_batch_id)"
    )
    op.add_column(
        "portfolio_import_staging_rows",
        sa.Column("asset_transfer_details", sa.JSON(), nullable=True),
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
    op.execute("""
      CREATE FUNCTION reject_portfolio_asset_transfer_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Asset transfers are immutable; roll back their import batch'; END $$;
      CREATE TRIGGER portfolio_asset_transfers_immutable BEFORE UPDATE ON portfolio_asset_transfers
      FOR EACH ROW EXECUTE FUNCTION reject_portfolio_asset_transfer_update();
    """)


def downgrade() -> None:
    if (
        op.get_bind()
        .execute(sa.text("SELECT EXISTS(SELECT 1 FROM portfolio_asset_transfers)"))
        .scalar()
    ):
        raise RuntimeError(
            "Dated asset transfers exist. Roll back their imports before downgrade; no history was removed."
        )
    op.execute(
        "UPDATE portfolio_import_staging_rows SET route=NULL,status='error',error_message='Asset transfer schema was downgraded' WHERE route IN ('asset_transfer','account_internal')"
    )
    op.drop_constraint(
        "chk_portfolio_import_staging_rows_route",
        "portfolio_import_staging_rows",
        type_="check",
    )
    op.create_check_constraint(
        "chk_portfolio_import_staging_rows_route",
        "portfolio_import_staging_rows",
        "route IS NULL OR route IN ('cash','portfolio')",
    )
    op.drop_column("portfolio_import_staging_rows", "asset_transfer_details")
    op.drop_table("portfolio_asset_transfers")
    op.execute("DROP FUNCTION reject_portfolio_asset_transfer_update()")
