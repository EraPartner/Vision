"""account_lifecycle_check: active accounts must not carry closed_at (ADR-088 addendum, D5).

Revision ID: 0069_account_lifecycle_check
Revises: 0068_transfer_source_dismissed
Create Date: 2026-07-10

The D5 lifecycle stores one state in two columns: is_active (the long-standing
archive flag) and closed_at (the 0067 close timestamp). Only service-layer
discipline kept them consistent — a direct write (admin DB editor, SQL) could
produce is_active=true + closed_at set, which the UI would render as an open
account with a close date. This CHECK makes the invariant self-enforcing:
an active account never carries closed_at. The reverse direction is left open
deliberately (an archived account without a timestamp is legal — pre-0067
archives were only backfilled best-effort from updated_at).

Pre-clean: any already-inconsistent rows (active + closed_at) are treated as
active — the timestamp is cleared, matching what the service does on reactivate.

Blast radius: one UPDATE limited to inconsistent rows + one table-level CHECK.
Downgrade drops the constraint.

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0069_account_lifecycle_check"
down_revision: Union[str, Sequence[str], None] = "0068_transfer_source_dismissed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE accounts SET closed_at = NULL
         WHERE is_active = true AND closed_at IS NOT NULL;
        ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ck_accounts_active_not_closed;
        ALTER TABLE accounts ADD CONSTRAINT ck_accounts_active_not_closed
            CHECK (is_active = false OR closed_at IS NULL);
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ck_accounts_active_not_closed")
