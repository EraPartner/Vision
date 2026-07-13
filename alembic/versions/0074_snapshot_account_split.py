"""Persist the per-account holdings split alongside snapshots (ADR-100, Phase C).

Revision ID: 0074_snapshot_account_split
Revises: 0073_transfer_source_opening
Create Date: 2026-07-11

The snapshot builder already computes a per-account holdings split
(`value_by_account`, Σ accounts == the aggregate value by construction — the
ADR-100 parity guarantee), but it was in-memory only. `getNetWorthByAccount`
therefore replayed the full multi-year day-walk (`computeDailySnapshots`) on
every cache miss purely to recover that split — the filed replay perf item and
prerequisite 8 of the ADR-103 addendum gate.

This table persists the split next to `portfolio_performance_snapshots` so the
by-account read becomes a cheap indexed SELECT instead of a full recompute. It
is rebuilt atomically alongside the aggregate snapshots (DELETE + INSERT in one
transaction) by `computeAndStoreSnapshots`, so the two never diverge.

`account_key` is the owning account id as text, or the literal 'unassigned' for
legacy lots with no `account_id` (ADR-091). Rows are sparse by construction —
only accounts holding units on a given day appear.

Nullable/tolerant by design:
  - The snapshot writer detects the table and only persists the split when it
    exists, so an un-migrated database keeps working (the by-account read falls
    back to the live replay until the migration is applied).
  - Historical rows are backfilled automatically by the next snapshot recompute
    (startup warmup rewrites the full series), so no data migration is needed.

Blast radius: one additive table + one index. No existing table is touched.

Rollback: `bun run db:downgrade` drops the table; the writer's table-detection
and the reader's fallback make the application tolerate either state.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0074_snapshot_account_split"
down_revision: Union[str, Sequence[str], None] = "0073_transfer_source_opening"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS portfolio_snapshot_accounts (
            snapshot_date DATE NOT NULL,
            currency VARCHAR(3) NOT NULL,
            account_key TEXT NOT NULL,
            value NUMERIC(18, 2) NOT NULL,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (snapshot_date, currency, account_key)
        );
        CREATE INDEX IF NOT EXISTS ix_snapshot_accounts_currency_date
            ON portfolio_snapshot_accounts (currency, snapshot_date);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS ix_snapshot_accounts_currency_date;
        DROP TABLE IF EXISTS portfolio_snapshot_accounts;
        """
    )
