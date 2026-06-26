"""saved_charts_all_source_flags: dynamic "All categories/recipients/tags" sources

Revision ID: 0064_saved_charts_all_source_flags
Revises: 0063_saved_charts_tag_ids
Create Date: 2026-06-26

Adds three additive boolean flags so a saved custom chart can select an entire
dimension ("all categories", "all recipients", "all tags") instead of an
explicit id list. An "all" source is dynamic: entities added later (e.g. a new
tag) are folded into the chart automatically, since the chart no longer pins a
fixed set of ids.

Each flag is orthogonal to its *_ids column: when the flag is true the id list
is ignored. NOT NULL with a false default preserves every existing row (they
keep their explicit selections, identical to today).
"""

from alembic import op

revision = "0064_saved_charts_all_source_flags"
down_revision = "0063_saved_charts_tag_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE saved_charts ADD COLUMN IF NOT EXISTS all_categories BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute(
        "ALTER TABLE saved_charts ADD COLUMN IF NOT EXISTS all_recipients BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute(
        "ALTER TABLE saved_charts ADD COLUMN IF NOT EXISTS all_tags BOOLEAN NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS all_tags")
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS all_recipients")
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS all_categories")
