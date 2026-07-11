"""planned_recurrence_bounds: recurrence_end_date + max_occurrences on planned_transactions.

Revision ID: 0071_planned_recurrence_bounds
Revises: 0070_transfer_pair_dismissals
Create Date: 2026-07-10

The planned-payment form has always offered "End date" and "Max occurrences"
for recurring payments, but the values were dropped at every layer: the
frontend mappers never sent them, the backend had no columns, and
plannedExecutionService advanced unconditionally — "monthly, ends Dec 2026,
max 12" generated due bills forever.

Adds the two nullable bound columns. The execution service now completes the
series (is_executed = true) when advancing would cross recurrence_end_date or
when the execution count reaches max_occurrences.

Blast radius: two nullable columns, no backfill (existing rows are unbounded,
which matches their previous behavior). Downgrade drops both columns.

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0071_planned_recurrence_bounds"
down_revision: Union[str, Sequence[str], None] = "0070_transfer_pair_dismissals"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE planned_transactions
            ADD COLUMN IF NOT EXISTS recurrence_end_date DATE,
            ADD COLUMN IF NOT EXISTS max_occurrences INTEGER;
        ALTER TABLE planned_transactions
            DROP CONSTRAINT IF EXISTS ck_planned_max_occurrences_positive;
        ALTER TABLE planned_transactions
            ADD CONSTRAINT ck_planned_max_occurrences_positive
            CHECK (max_occurrences IS NULL OR max_occurrences > 0);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE planned_transactions
            DROP CONSTRAINT IF EXISTS ck_planned_max_occurrences_positive;
        ALTER TABLE planned_transactions
            DROP COLUMN IF EXISTS recurrence_end_date,
            DROP COLUMN IF EXISTS max_occurrences;
        """
    )
