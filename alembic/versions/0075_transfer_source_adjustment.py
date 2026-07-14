"""transfer_source 'adjustment': reconcile-to-statement adjustment row (ADR-094, Phase C).

Revision ID: 0075_transfer_source_adjustment
Revises: 0074_snapshot_account_split
Create Date: 2026-07-11

The drift badge (statement_balance − computed_balance) was a dead-end tooltip: the
only way to clear a drift was Edit → Advanced. The Phase C reconcile flow adds a
second, opt-in resolution — "add adjustment transaction" — alongside "accept"
(rewrite the stored statement figures to the computed balance).

The adjustment is a server-created ledger row that moves the *computed* balance to
match the statement: amount = drift, balance left NULL (it is NOT a new anchor, so
the ADR-094 anchor+delta computed-balance stays honest — the descriptive-only
default is preserved), is_transfer=true and transfer_source='adjustment'. Marking
it is_transfer keeps it out of income/spending aggregations, and the dedicated
transfer_source keeps the ADR-083 reconciler (which only touches NULL/'auto') from
pairing it — following the 'opening' (0073) and 'trade' (0053) precedents.

Extends the ck_transactions_transfer_source CHECK to allow 'adjustment'. Downgrade
first clears any 'adjustment' rows back to NULL (else the narrower CHECK can't be
re-added) and restores the prior constraint.

Blast radius: one CHECK swap. Not auto-run (applied on the next app boot).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0075_transfer_source_adjustment"
down_revision: Union[str, Sequence[str], None] = "0074_snapshot_account_split"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade', 'opening', 'adjustment'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE transactions SET transfer_source = NULL WHERE transfer_source = 'adjustment';
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade', 'opening'));
        """
    )
