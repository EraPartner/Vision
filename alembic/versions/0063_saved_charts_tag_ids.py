"""saved_charts_tag_ids: add tag_ids for tag-grouped custom chart series

Revision ID: 0063_saved_charts_tag_ids
Revises: 0062_trigger_lookup_only_on_update
Create Date: 2026-06-26

Adds a single additive column so a saved custom chart can render per-tag
spending series alongside its existing category / recipient series (ADR-052
tags as an orthogonal dimension; mirrors the recipient_ids column from 0017).

NOT NULL with a '{}' default preserves every existing row (they get an empty
tag selection, identical to a chart that never picked any tags).
"""

from alembic import op

revision = "0063_saved_charts_tag_ids"
down_revision = "0062_trigger_lookup_only_on_update"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE saved_charts ADD COLUMN IF NOT EXISTS tag_ids INTEGER[] NOT NULL DEFAULT '{}'"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE saved_charts DROP COLUMN IF EXISTS tag_ids")
