"""account_closed_at: lifecycle timestamp for closed accounts (ADR-088 addendum, D5).

Revision ID: 0067_account_closed_at
Revises: 0066_normalized_account_identity
Create Date: 2026-07-10

Decision D5 (2026-07-10, ADR-088 addendum) models the account lifecycle as
active → closed → (only-if-empty) deleted. "Close" = archive (is_active=false)
plus a closed_at timestamp stamped by the server at close time; reactivating
clears it. Hard DELETE stays FK-guarded (409 while referenced) and the API/UI
now route that 409 to the close flow.

Backfill: accounts already archived get closed_at = updated_at (the last touch
is the best available proxy for when they were archived).

Blast radius: one nullable column + a backfill UPDATE limited to archived rows.
Downgrade drops the column.

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0067_account_closed_at"
down_revision: Union[str, Sequence[str], None] = "0066_normalized_account_identity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
        UPDATE accounts SET closed_at = updated_at
         WHERE is_active = false AND closed_at IS NULL;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE accounts DROP COLUMN IF EXISTS closed_at")
