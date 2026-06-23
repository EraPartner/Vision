"""Brokerage import fan-out: route on staging rows + is_brokerage on batches (ADR-095).

Revision ID: 0060_brokerage_import_routing
Revises: 0059_db_editor_audit
Create Date: 2026-06-18

ADR-095's unified importer splits one brokerage statement into BOTH the cash ledger and the
portfolio. The portfolio-import staging pipeline (ADR-078) is portfolio-only today. This adds the
two columns that let it fan out:

  - portfolio_import_batches.is_brokerage — marks a batch whose rows must be routed (cash vs trade)
    and whose trades get an ADR-090 cash leg. A plain portfolio import (is_brokerage=false) keeps
    its exact current behaviour (no routing, no legs).
  - portfolio_import_staging_rows.route — the per-row classification ('cash' | 'portfolio'), set at
    validate time from the row kind (deposit/withdrawal → cash; buy/sell/dividend/… → portfolio).
    NULL on legacy / non-brokerage rows = portfolio (the historical default).

Blast radius: one nullable column + one boolean with a default. No data change; existing batches
read as non-brokerage. Downgrade drops both.

NOTE: migrations are not auto-run by the agent — authored here; the user applies it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0060_brokerage_import_routing"
down_revision: Union[str, Sequence[str], None] = "0059_db_editor_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_import_batches
            ADD COLUMN IF NOT EXISTS is_brokerage BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE portfolio_import_staging_rows
            ADD COLUMN IF NOT EXISTS route TEXT;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_import_staging_rows DROP COLUMN IF EXISTS route;
        ALTER TABLE portfolio_import_batches DROP COLUMN IF EXISTS is_brokerage;
        """
    )
