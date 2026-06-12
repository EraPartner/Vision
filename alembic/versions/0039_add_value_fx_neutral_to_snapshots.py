"""Add value_fx_neutral to portfolio_performance_snapshots (FX attribution).

Revision ID: 0039_add_value_fx_neutral_to_snapshots
Revises: 0038_drop_mv_recipient_monthly
Create Date: 2026-06-11

Multi-currency portfolios need an FX-neutral value series so the performance
chart can show growth with currency moves stripped out (FX-attribution
feature; see the companion ADR). `value_fx_neutral` is the portfolio value
with each unit-based holding converted at its cost-weighted average
purchase-date rate instead of the day's market rate — the difference
`value - value_fx_neutral` is the cumulative currency effect on current
holdings.

Nullable on purpose:
  - The snapshot writer detects the column and only includes it when present,
    so an un-migrated database keeps working (the chart simply lacks the
    FX-neutral series until the migration is applied).
  - Historical rows are backfilled automatically by the next snapshot
    recompute (startup warmup rewrites the full series), so no data migration
    is needed here.

Blast radius: portfolio_performance_snapshots only (additive, nullable, no
index changes). Readers COALESCE/ignore the column when NULL.

Rollback: `bun run db:downgrade` drops the column; the snapshot writer's
column-detection makes the application tolerate either state.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0039_add_value_fx_neutral_to_snapshots'
down_revision: Union[str, Sequence[str], None] = '0038_drop_mv_recipient_monthly'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            ADD COLUMN IF NOT EXISTS value_fx_neutral NUMERIC(18, 2);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE portfolio_performance_snapshots
            DROP COLUMN IF EXISTS value_fx_neutral;
    """)
