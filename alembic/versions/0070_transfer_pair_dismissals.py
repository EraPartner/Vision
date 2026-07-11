"""transfer_pair_dismissals: dismiss a transfer PAIRING, not the rows (ADR-083).

Revision ID: 0070_transfer_pair_dismissals
Revises: 0069_account_lifecycle_check
Create Date: 2026-07-10

0068 made an un-marked transfer stick by stamping BOTH rows
transfer_source='dismissed'. That models the wrong thing: the user rejected the
pairing A↔B, not the rows. A dismissed row was excluded from the candidate pool
entirely, so if A was wrongly paired with B but actually belongs with C,
auto-reconcile could never find A↔C — the user had to notice and pair manually.

This revision replaces the per-row value with a per-pair table:

- transfer_dismissals (txn_a_id < txn_b_id, PK on the pair) records each
  rejected pairing; ON DELETE CASCADE cleans up when a leg is deleted.
- unmarkTransfer records the pair and resets both rows to transfer_source=NULL
  (open), so each leg stays auto-matchable with every OTHER candidate.
- loadCandidatePairs excludes exactly the dismissed pairs.
- Any rows already stamped 'dismissed' (0068 model, never a shipped release)
  are reset to NULL; their pairing cannot be reconstructed (the peer link was
  already cleared), so they simply return to the open pool.
- The ck_transactions_transfer_source CHECK reverts to ('auto','manual','trade').

Blast radius: one new (empty) table, one UPDATE limited to 'dismissed' rows,
one CHECK swap. Downgrade restores the 0068 CHECK and drops the table (recorded
dismissals are lost — they re-accumulate as users unmark).

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0070_transfer_pair_dismissals"
down_revision: Union[str, Sequence[str], None] = "0069_account_lifecycle_check"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS transfer_dismissals (
            txn_a_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            txn_b_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (txn_a_id, txn_b_id),
            CONSTRAINT ck_transfer_dismissals_ordered CHECK (txn_a_id < txn_b_id)
        );
        CREATE INDEX IF NOT EXISTS ix_transfer_dismissals_b ON transfer_dismissals (txn_b_id);

        UPDATE transactions SET transfer_source = NULL WHERE transfer_source = 'dismissed';
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;
        ALTER TABLE transactions
            ADD CONSTRAINT ck_transactions_transfer_source
            CHECK (transfer_source IS NULL OR transfer_source IN ('auto', 'manual', 'trade', 'dismissed'));
        DROP TABLE IF EXISTS transfer_dismissals;
        """
    )
