"""transfer_source 'opening': guarded opening-balance anchor (ADR-094 second addendum, D4).

Revision ID: 0073_transfer_source_opening
Revises: 0072_regrain_mv_bank_balances
Create Date: 2026-07-11

The 2026-06-25 addendum made `transactions.balance` import-pipeline-only, which
left manual/cash-only accounts with no way to seed an opening balance — their
computed balance was Σ(amounts) from an implicit zero forever. Decision D4
(2026-07-10) adds a guarded, server-side anchor: `POST /api/accounts/:id/opening-balance`
creates ONE system row per (account, currency) with amount=0, a server-stamped
`balance`, `is_transfer=true` and `transfer_source='opening'` — a new CHECK value
following ADR-090's 'trade' precedent, so the anchor is excluded from spending
aggregations and from transfer reconciliation. (The planned zero-amount-transaction
rejection must likewise exempt transfer_source='opening' rows — they are
legitimately zero-amount.)

Extends the ck_transactions_transfer_source CHECK to allow 'opening'. Downgrade
first clears any 'opening' rows back to NULL (else the narrower CHECK can't be
re-added) and restores the prior constraint.

Blast radius: one CHECK swap. Not auto-run (applied on the next app boot).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0073_transfer_source_opening"
down_revision: Union[str, Sequence[str], None] = "0072_regrain_mv_bank_balances"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade', 'dismissed', 'opening'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE transactions SET transfer_source = NULL WHERE transfer_source = 'opening';
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade', 'dismissed'));
        """
    )
