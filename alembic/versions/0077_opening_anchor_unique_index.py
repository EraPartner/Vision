"""Partial unique index enforcing one opening-balance anchor per (account, currency).

Revision ID: 0077_opening_anchor_unique_index
Revises: 0076_account_trigger_blank_and_case
Create Date: 2026-07-14

The opening-balance service (ADR-094 D4) stamps a single system anchor row per
(account_id, currency) with transfer_source='opening'. Until now that
one-anchor invariant was backed only by application logic (the CTE-upsert's
"UPDATE existing else INSERT") plus a table CHECK — nothing at the database
level stopped two concurrent setOpeningBalance calls from both seeing no
existing anchor and both INSERTing, minting a duplicate anchor. The service now
also takes a FOR UPDATE lock on the account row; this index is the
defense-in-depth backstop that makes a duplicate anchor structurally
impossible regardless of interleaving.

Partial (WHERE transfer_source='opening') so it only constrains anchor rows and
leaves every ordinary transaction untouched. Created IF NOT EXISTS so the
migration is idempotent.

Before creating the index we defensively collapse any pre-existing duplicate
anchors — there should be none, but CREATE UNIQUE INDEX fails outright if dupes
exist. We keep the earliest anchor per (account_id, currency) (ordered by date
then id) and delete the rest.

Blast radius: one partial unique index. Not auto-run (applied on next app boot).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0077_opening_anchor_unique_index"
down_revision: Union[str, Sequence[str], None] = "0076_account_trigger_blank_and_case"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        -- Defensive: keep the earliest anchor per (account_id, currency),
        -- delete any extras so the UNIQUE INDEX below can be built.
        DELETE FROM transactions t
         USING (
           SELECT id,
                  row_number() OVER (
                    PARTITION BY account_id, currency
                    ORDER BY date ASC, id ASC
                  ) AS rn
             FROM transactions
            WHERE transfer_source = 'opening'
         ) d
         WHERE t.id = d.id AND d.rn > 1;

        CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_opening_anchor
            ON transactions (account_id, currency)
         WHERE transfer_source = 'opening';
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS ux_transactions_opening_anchor;
        """
    )
