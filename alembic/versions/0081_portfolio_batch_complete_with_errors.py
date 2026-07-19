"""Add 'complete_with_errors' to the portfolio_import_batches status CHECK.

Revision ID: 0081_portfolio_batch_complete_with_errors
Revises: 0080_drop_agg_recipient_totals
Create Date: 2026-07-19

A portfolio import that finishes with per-row commit failures (e.g. a brokerage
batch committed with the account unset → every cash row errors, or a row whose
instrument never resolved) previously landed in `status = 'complete'` with no
signal and no repair path: `overrideInvestment` only touched `matched` rows and
the commit route rejected anything not `awaiting_review`, so the errored rows
were stranded permanently while the batch read as done.

This adds a `complete_with_errors` terminal-ish status so the pipeline can leave
a batch flagged for repair (the commit route re-accepts it, and fixing an
errored row resets it to `matched` for a re-commit). Mirrors the transaction
import side's existing `completed_with_errors` concept.

Only the CHECK constraint changes — no data migration. The status-lookup partial
index (`idx_portfolio_import_batches_status`, `WHERE status NOT IN
('complete','failed','aborted')`) is intentionally left as-is: a
`complete_with_errors` batch is one still needing attention, so keeping it in the
"active" partial index is correct.

Downgrade first collapses any `complete_with_errors` rows back to `complete`
(otherwise the stricter old CHECK would reject them) before restoring the
original constraint.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0081_portfolio_batch_complete_with_errors"
down_revision: Union[str, Sequence[str], None] = "0080_drop_agg_recipient_totals"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_OLD_STATUSES = (
    "'pending','staging','validating','matching','awaiting_review',"
    "'committing','complete','failed','aborted'"
)
_NEW_STATUSES = _OLD_STATUSES + ",'complete_with_errors'"


def upgrade() -> None:
    op.execute(
        "ALTER TABLE portfolio_import_batches "
        "DROP CONSTRAINT IF EXISTS portfolio_import_batches_status_check;"
    )
    op.execute(
        "ALTER TABLE portfolio_import_batches "
        "ADD CONSTRAINT portfolio_import_batches_status_check "
        f"CHECK (status IN ({_NEW_STATUSES}));"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE portfolio_import_batches "
        "SET status = 'complete' WHERE status = 'complete_with_errors';"
    )
    op.execute(
        "ALTER TABLE portfolio_import_batches "
        "DROP CONSTRAINT IF EXISTS portfolio_import_batches_status_check;"
    )
    op.execute(
        "ALTER TABLE portfolio_import_batches "
        "ADD CONSTRAINT portfolio_import_batches_status_check "
        f"CHECK (status IN ({_OLD_STATUSES}));"
    )
