"""saved_charts_recipients_variants: add recipient_ids, chart_variant, time_bucket, date range

Revision ID: 0017_saved_charts_recipients_variants
Revises: 0016_cashflow_forecast_mc_rolling
Create Date: 2026-04-28

Extends saved_charts with five new columns:
- recipient_ids: mix recipient series alongside categories
- chart_variant: stacked/grouped/default rendering hint
- time_bucket: monthly or yearly aggregation
- date_range_start/end: optional date filter (NULL = all-time)

All columns are additive with safe defaults, preserving existing rows.
"""

from alembic import op

revision = '0017_saved_charts_recipients_variants'
down_revision = '0016_cashflow_forecast_mc_rolling'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE saved_charts ADD COLUMN recipient_ids INTEGER[] NOT NULL DEFAULT '{}'")
    op.execute("ALTER TABLE saved_charts ADD COLUMN chart_variant TEXT NOT NULL DEFAULT 'default'")
    op.execute("ALTER TABLE saved_charts ADD COLUMN time_bucket TEXT NOT NULL DEFAULT 'monthly'")
    op.execute("ALTER TABLE saved_charts ADD COLUMN date_range_start DATE NULL")
    op.execute("ALTER TABLE saved_charts ADD COLUMN date_range_end DATE NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS date_range_end")
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS date_range_start")
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS time_bucket")
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS chart_variant")
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS recipient_ids")
