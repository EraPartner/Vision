"""regrain_mv_bank_balances: re-grain mv_bank_balances on (account_id, currency).

Revision ID: 0072_regrain_mv_bank_balances
Revises: 0071_planned_recurrence_bounds
Create Date: 2026-07-11

Accounts rewrite Phase B (ADR-088, D1/D2). mv_bank_balances was the last derived
object still grained on the `bank_account` string. It is now grained on
`(account_id, currency)` — the FK grain that also aligns with the D2 multi-currency
balance grain (ADR-089 addendum). The materialized view is created and refreshed by
services/materializedViewService.js, which uses CREATE MATERIALIZED VIEW IF NOT EXISTS
and so never re-grains an already-existing view. This migration drops the stale view
(and its unique index, dropped with it) so the next app boot recreates it with the
new (account_id, currency) definition — the same drop-so-code-recreates pattern used
by 0045 for the transfer-excluding MVs.

The runtime definition keeps `a.name AS bank_account` as an output label so read-side
consumers stay source-compatible while the string column is retired. This does NOT
drop the bank_account column (that irreversible contract step stays out-of-band in
alembic/manual/contract_drop_bank_account/up.sql).

Blast radius: drop/recreate of one derived MV (no data rewrite). Downgrade likewise
drops it so the older code recreates the prior (bank_account, currency) definition.

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0072_regrain_mv_bank_balances"
down_revision: Union[str, Sequence[str], None] = "0071_planned_recurrence_bounds"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop the stale (bank_account, currency)-grained MV so createMaterializedViews
    # recreates it grained on (account_id, currency) on the next boot. The unique
    # index is dropped together with the view.
    # destructive-ok: shipped 2026-07-11, annotated retroactively. Derived data only; the MV is
    # rebuilt from transactions by materializedViewService on the same boot that applies this
    # migration, on the new grain. A stale MV is the failure mode being fixed, not created.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_bank_balances CASCADE;")


def downgrade() -> None:
    # Symmetric: drop the (account_id, currency)-grained MV so the older code
    # recreates the prior (bank_account, currency) definition on boot.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_bank_balances CASCADE;")
