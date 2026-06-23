"""Enforce one primary bank account per recipient (partial unique index).

Revision ID: 0047_one_primary_bank_account_per_recipient
Revises: 0046_currency_integrity
Create Date: 2026-06-18

`recipient_bank_accounts.is_primary` was documented as "enforced at application
level" — nothing in the schema stopped a recipient from having two primary
accounts, which makes "the primary account" ambiguous for any read that picks
one. A partial unique index on (recipient_id) WHERE is_primary moves that
invariant into the database.

Pre-existing duplicates would make the index build fail, so the migration first
demotes all but the lowest-id primary per recipient. No application change is
needed: the app already tries to keep a single primary; this only guarantees it.

Blast radius: one UPDATE that touches only recipients that currently have >1
primary, plus a partial-index build over a small table. Downgrade drops the
index (the demotion is intentionally not reverted — the prior state was invalid).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0047_one_primary_bank_account_per_recipient"
down_revision: Union[str, Sequence[str], None] = "0046_currency_integrity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Demote extra primaries, keeping the lowest id per recipient as the primary.
    op.execute(
        """
        UPDATE recipient_bank_accounts
           SET is_primary = false
         WHERE is_primary = true
           AND id NOT IN (
               SELECT MIN(id)
                 FROM recipient_bank_accounts
                WHERE is_primary = true
                GROUP BY recipient_id
           )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_recipient_primary_account
            ON recipient_bank_accounts (recipient_id)
         WHERE is_primary
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_recipient_primary_account")
