"""Drop dormant import-staging bank-account resolution state.

Revision ID: 0104_drop_dormant_import_bank_resolution
Revises: 0103_import_identity_provenance
Create Date: 2026-09-09

The field has no runtime reader or writer. The upgrade locks staging state,
then refuses to proceed if any stored resolution would be lost. Import batches
remain untouched regardless of status because the current pipeline does not use
this field to resume them. The downgrade restores the nullable foreign key and
its partial index, but no data needs reconstruction because the upgrade accepts
only an entirely null column.

Blast radius: import_staging_rows metadata only; no rows are rewritten.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0104_drop_dormant_import_bank_resolution"
down_revision: Union[str, Sequence[str], None] = "0103_import_identity_provenance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        LOCK TABLE import_staging_rows IN ACCESS EXCLUSIVE MODE;

        DO $$
        DECLARE
            resolved_rows bigint;
        BEGIN
            SELECT count(*) INTO resolved_rows
              FROM import_staging_rows
             WHERE resolved_bank_account_id IS NOT NULL;

            IF resolved_rows <> 0 THEN
                RAISE EXCEPTION
                    'dormant bank-account resolution retirement refused: % resolved rows remain',
                    resolved_rows;
            END IF;
        END $$;

        ALTER TABLE import_staging_rows
          DROP CONSTRAINT IF EXISTS fk_import_staging_rows_resolved_bank_account;
        DROP INDEX IF EXISTS idx_import_staging_rows_resolved_bank_account_id;
        -- destructive-ok: the locked preflight above requires the dormant
        -- column to be empty; import batch rows and statuses are untouched.
        ALTER TABLE import_staging_rows DROP COLUMN resolved_bank_account_id;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE import_staging_rows
          ADD COLUMN resolved_bank_account_id INTEGER;
        ALTER TABLE import_staging_rows
          ADD CONSTRAINT fk_import_staging_rows_resolved_bank_account
          FOREIGN KEY (resolved_bank_account_id)
          REFERENCES recipient_bank_accounts(id)
          ON DELETE SET NULL;
        CREATE INDEX idx_import_staging_rows_resolved_bank_account_id
          ON import_staging_rows (resolved_bank_account_id)
          WHERE resolved_bank_account_id IS NOT NULL;
        """
    )
