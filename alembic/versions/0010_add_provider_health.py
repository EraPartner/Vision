"""Phase 10: add provider_health table

Revision ID: 0010_add_provider_health
Revises: 0009_drop_agg_shadow_divergences
Create Date: 2026-04-24

Tracks per-provider health state (last success, last error, consecutive failures)
for the admin observability hub.
"""

from alembic import op
import sqlalchemy as sa

revision = '0010_add_provider_health'
down_revision = '0009_drop_agg_shadow_divergences'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS provider_health (
            provider              TEXT PRIMARY KEY,
            kind                  TEXT NOT NULL,
            last_success_at       TIMESTAMPTZ,
            last_error_at         TIMESTAMPTZ,
            last_error            TEXT,
            consecutive_failures  INTEGER NOT NULL DEFAULT 0,
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_ph_kind ON provider_health (kind)"
    ))


def downgrade():
    op.execute(sa.text("DROP INDEX IF EXISTS idx_ph_kind"))
    op.execute(sa.text("DROP TABLE IF EXISTS provider_health"))
