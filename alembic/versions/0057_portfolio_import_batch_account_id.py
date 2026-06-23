"""Brokerage import: account_id on portfolio_import_batches (ADR-091 / ADR-095, batch-level).

Revision ID: 0057_portfolio_import_batch_account_id
Revises: 0056_restore_bank_account_after_premature_drop
Create Date: 2026-06-18

Portfolio/brokerage imports leave portfolio_transactions.account_id NULL — the commit pipeline
never set it and the review flow had no account picker. The smallest fix (ADR-095's batch-level
option) is to record ONE brokerage account on the import batch; the commit then stamps every
lot it creates with that account_id, giving imported holdings a real position
(investment_id, account_id) per ADR-091.

This migration adds a nullable account_id to portfolio_import_batches. ON DELETE SET NULL: an
import batch is a historical record of a load — if the account it targeted is later removed, the
batch should survive with the link cleared (it is not history that must block account removal the
way live transactions/lots do under the ADR-087 RESTRICT policy).

Blast radius: one nullable column + an index on a low-cardinality table. No data change.
Downgrade drops them.

NOTE: migrations are not auto-run by the agent — authored here; the user applies it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0057_portfolio_import_batch_account_id"
down_revision: Union[str, Sequence[str], None] = (
    "0056_restore_bank_account_after_premature_drop"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_import_batches
            ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_portfolio_import_batches_account_id
            ON portfolio_import_batches (account_id);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS idx_portfolio_import_batches_account_id;
        ALTER TABLE portfolio_import_batches DROP COLUMN IF EXISTS account_id;
        """
    )
