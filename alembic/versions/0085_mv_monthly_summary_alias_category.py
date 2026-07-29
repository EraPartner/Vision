"""Rebuild mv_monthly_summary with the 3-level effective-category resolution.

Revision ID: 0085_mv_monthly_summary_alias_category
Revises: 0084_mv_category_totals_alias_category
Create Date: 2026-07-28

`mv_monthly_summary` (the getMonthlyFinancialSummary fast path) resolved the
effective category over TWO levels only — `COALESCE(t.category_id,
r.default_category_id)` — while the transactions surfaces resolve THREE
(`…, pr.default_category_id`): a row recorded under an alias recipient whose
PRIMARY carries the default category was categorised in the transactions list
but grouped under the UNCATEGORISED (`category_id_key = -1`) row of the monthly
view. The monthly live path in `infoRepositoryMonthly.getMonthlyFinancialSummary`
is fixed to the 3-level pattern in the same release; this migration drops the MV
so the fast path is rebuilt from the corrected definition and the two paths
cannot disagree on the category grain.

The view's only current reader sums across categories, so the monthly totals
themselves are unchanged — this aligns the stored category grain (and the
`category_id_key` unique-index column) with every other money surface rather
than fixing a wrong total.

`CREATE MATERIALIZED VIEW IF NOT EXISTS` never redefines an existing view, so
without this drop already-migrated installs would keep the old 2-level SQL
forever (REFRESH re-runs the *stored* definition). Same drop-and-let-boot-
recreate precedent as migrations 0045 and 0084: materializedViewService.
createMaterializedViews runs right after migrations on the same boot
(main.js), recreates the view with the new definition, and the startup /
post-mutation refresh populates it. Until then `mvAvailable()` sees it
unpopulated and getMonthlyFinancialSummary serves the (corrected) live query —
no window of wrong answers.

Downgrade drops the view again so the older code recreates its prior 2-level
definition on next boot. Derived data only; nothing to preserve.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0085_mv_monthly_summary_alias_category"
down_revision: Union[str, Sequence[str], None] = "0084_mv_category_totals_alias_category"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # destructive-ok: derived data only, rebuilt from transactions by
    # materializedViewService.createMaterializedViews on the same boot that applies this
    # migration (precedent: 0045, 0084) — the recreation with the 3-level effective-category
    # definition is the point of the drop. Its unique index drops with it via CASCADE.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE;")


def downgrade() -> None:
    # destructive-ok: same rebuild-at-boot contract in reverse — older application code
    # recreates the previous 2-level definition via createMaterializedViews on next start.
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE;")
