"""transfer_source 'dismissed': make an un-marked transfer stick (ADR-083).

Revision ID: 0068_transfer_source_dismissed
Revises: 0067_account_closed_at
Create Date: 2026-07-10

Un-marking a false-positive transfer reset both legs to transfer_source=NULL, so
the very reconcile the unmark triggered (scheduleReconcile) re-paired them ~1s
later — DELETE /api/transactions/transfers/:id could never do its documented job.
The fix persists the dismissal as a new transfer_source value 'dismissed'
(is_transfer=false); loadCandidatePairs already excludes any row whose
transfer_source IS NOT NULL, so a dismissed row is not re-paired, while a later
manual mark (transfer_source='manual') still overrides it.

Extends the ck_transactions_transfer_source CHECK to allow 'dismissed'. Downgrade
first clears any 'dismissed' rows back to NULL (else the narrower CHECK can't be
re-added) and restores the prior constraint.

Blast radius: one CHECK swap. Not auto-run.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0068_transfer_source_dismissed"
down_revision: Union[str, Sequence[str], None] = "0067_account_closed_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade', 'dismissed'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE transactions SET transfer_source = NULL WHERE transfer_source = 'dismissed';
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade'));
        """
    )
