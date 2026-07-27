"""Phase 9: drop agg_shadow_divergences table

Revision ID: 0009_drop_agg_shadow_divergences
Revises: 0008_agg_shadow_divergences
Create Date: 2026-04-24

Shadow parity proven (zero divergences at full traffic). Table and indexes
no longer needed — shadow middleware removed in the same release.
"""

from alembic import op
import sqlalchemy as sa

revision = '0009_drop_agg_shadow_divergences'
down_revision = '0008_agg_shadow_divergences'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("DROP INDEX IF EXISTS idx_asd_created_at"))
    op.execute(sa.text("DROP INDEX IF EXISTS idx_asd_endpoint"))
    # destructive-ok: shipped 2026-04-24, annotated retroactively. Diagnostic-only table; the
    # shadow middleware that was its sole writer/reader was removed in the same release after
    # parity was proven at full traffic (see this migration's docstring). No user data.
    op.execute(sa.text("DROP TABLE IF EXISTS agg_shadow_divergences"))


def downgrade():
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS agg_shadow_divergences (
            id               SERIAL PRIMARY KEY,
            endpoint         TEXT NOT NULL,
            request_params   JSONB NOT NULL DEFAULT '{}',
            divergences      JSONB NOT NULL DEFAULT '[]',
            divergence_count INTEGER NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_asd_endpoint "
        "ON agg_shadow_divergences (endpoint)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_asd_created_at "
        "ON agg_shadow_divergences (created_at DESC)"
    ))
