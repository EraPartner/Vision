"""Add internal-transfer pairing to transactions (ADR-083).

Revision ID: 0044_add_transfer_pairing
Revises: 0043_add_provider_api_keys
Create Date: 2026-06-18

Internal transfers between a user's own accounts are recorded as two
equal-and-opposite transactions that net to zero but inflate gross income AND
gross spending in every cash-flow aggregate. ADR-083 makes transfers a
first-class concept so they can be detected and excluded.

This migration is purely additive:
  - transfer_peer_id  -> self-FK to the matched leg (ON DELETE SET NULL), so the
                         pairing survives across import batches and re-evaluates
                         when a leg is edited/deleted.
  - is_transfer       -> excluded from cash-flow aggregates unless includeTransfers.
  - transfer_source   -> 'auto' (reconciler) | 'manual' (sticky user override).

Detection, exclusion wiring, and the one-time backfill live in application code;
this migration only adds the columns + supporting indexes. Downgrade drops them.

Blast radius: additive columns + two indexes on transactions. No data rewrite.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0044_add_transfer_pairing"
down_revision: Union[str, Sequence[str], None] = "0043_add_provider_api_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE transactions
          ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS transfer_peer_id INTEGER,
          ADD COLUMN IF NOT EXISTS transfer_source TEXT;
    """)
    # Self-referential pairing: ON DELETE SET NULL so deleting one leg orphans the
    # other (the reconciler then un-marks it) rather than cascading a deletion.
    op.execute(
        "ALTER TABLE transactions DROP CONSTRAINT IF EXISTS fk_transactions_transfer_peer;"
    )
    op.execute("""
        ALTER TABLE transactions
          ADD CONSTRAINT fk_transactions_transfer_peer
          FOREIGN KEY (transfer_peer_id) REFERENCES transactions (id) ON DELETE SET NULL;
    """)
    op.execute(
        "ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;"
    )
    op.execute("""
        ALTER TABLE transactions
          ADD CONSTRAINT ck_transactions_transfer_source
          CHECK (transfer_source IS NULL OR transfer_source IN ('auto','manual'));
    """)
    # Matching: locate an opposite-amount leg within a small date window.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_transactions_amount_date ON transactions (amount, date);"
    )
    # Peer lookups + orphan re-evaluation on edit/delete.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_transactions_transfer_peer
          ON transactions (transfer_peer_id) WHERE transfer_peer_id IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_transactions_transfer_peer;")
    op.execute("DROP INDEX IF EXISTS idx_transactions_amount_date;")
    op.execute(
        "ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_transfer_source;"
    )
    op.execute(
        "ALTER TABLE transactions DROP CONSTRAINT IF EXISTS fk_transactions_transfer_peer;"
    )
    op.execute("ALTER TABLE transactions DROP COLUMN IF EXISTS transfer_source;")
    op.execute("ALTER TABLE transactions DROP COLUMN IF EXISTS transfer_peer_id;")
    op.execute("ALTER TABLE transactions DROP COLUMN IF EXISTS is_transfer;")
