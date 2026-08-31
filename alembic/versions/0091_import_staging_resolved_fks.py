"""Constrain resolved import-staging references to their parent rows.

Revision ID: 0091_import_staging_resolved_fks
Revises: 0090_constraint_index_naming
Create Date: 2026-08-31

``import_staging_rows.resolved_recipient_id`` and
``resolved_bank_account_id`` were plain integers since 0001, unlike the later
``user_override_recipient_id`` sibling. A recipient or recipient bank account
deleted while a batch waited for review could therefore leave a dangling
stored id. The recipient id is consumed by commit; the bank-account id is a
reserved schema field that the current runtime does not yet populate or read.

Upgrade policy:
  * add partial covering indexes for the two nullable references;
  * add, repair, and validate each named foreign key in sequence so a row that
    is orphaned in both columns can still be normalized safely;
  * normalize pre-existing orphan ids to NULL, preserving the reviewable row.

Both foreign keys use ON DELETE SET NULL. Deleting a referenced parent clears
only that stored resolution instead of deleting the imported source row or
blocking the parent deletion. Clearing the recipient id returns the row to the
unresolved review path unless a user override still supplies a recipient.

Blast radius: two nullable columns on the transient import staging table. The
orphan cleanup is irreversible because a missing parent cannot be reconstructed.
Downgrade removes only the two constraints and two indexes; cleaned orphan ids
remain NULL. The migration is auto-applied on next backend startup and is not
applied to user data by this change session.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0091_import_staging_resolved_fks"
down_revision: Union[str, Sequence[str], None] = "0090_constraint_index_naming"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE INDEX idx_import_staging_rows_resolved_recipient_id
            ON import_staging_rows (resolved_recipient_id)
            WHERE resolved_recipient_id IS NOT NULL;

        CREATE INDEX idx_import_staging_rows_resolved_bank_account_id
            ON import_staging_rows (resolved_bank_account_id)
            WHERE resolved_bank_account_id IS NOT NULL;

        ALTER TABLE import_staging_rows
          ADD CONSTRAINT fk_import_staging_rows_resolved_recipient
          FOREIGN KEY (resolved_recipient_id)
          REFERENCES recipients(id)
          ON DELETE SET NULL
          NOT VALID;

        UPDATE import_staging_rows AS staging
           SET resolved_recipient_id = NULL
         WHERE resolved_recipient_id IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1
                   FROM recipients AS recipient
                  WHERE recipient.id = staging.resolved_recipient_id
               );

        ALTER TABLE import_staging_rows
          VALIDATE CONSTRAINT fk_import_staging_rows_resolved_recipient;

        ALTER TABLE import_staging_rows
          ADD CONSTRAINT fk_import_staging_rows_resolved_bank_account
          FOREIGN KEY (resolved_bank_account_id)
          REFERENCES recipient_bank_accounts(id)
          ON DELETE SET NULL
          NOT VALID;

        UPDATE import_staging_rows AS staging
           SET resolved_bank_account_id = NULL
         WHERE resolved_bank_account_id IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1
                   FROM recipient_bank_accounts AS bank_account
                  WHERE bank_account.id = staging.resolved_bank_account_id
               );

        ALTER TABLE import_staging_rows
          VALIDATE CONSTRAINT fk_import_staging_rows_resolved_bank_account;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE import_staging_rows
          DROP CONSTRAINT IF EXISTS fk_import_staging_rows_resolved_bank_account;
        ALTER TABLE import_staging_rows
          DROP CONSTRAINT IF EXISTS fk_import_staging_rows_resolved_recipient;
        DROP INDEX IF EXISTS idx_import_staging_rows_resolved_bank_account_id;
        DROP INDEX IF EXISTS idx_import_staging_rows_resolved_recipient_id;
        """
    )
