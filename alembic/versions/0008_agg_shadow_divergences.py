"""Add agg_shadow_divergences table for Phase 8 cross-check logging

Revision ID: 0008_agg_shadow_divergences
Revises: 0007_bank_reconciliation
Create Date: 2026-04-24

Stores per-request divergences detected by the aggregation shadow middleware.
Rows are written by the backend when a numeric delta > 1 cent is found between
/api/aggregations/* and the paired /api/info/* legacy endpoint.

Scheduled for removal in Phase 9 once shadow parity is proven.
"""

from alembic import op
import sqlalchemy as sa

revision = '0008_agg_shadow_divergences'
down_revision = '0007_bank_reconciliation'
branch_labels = None
depends_on = None


def upgrade():
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


def downgrade():
    op.execute(sa.text("DROP TABLE IF EXISTS agg_shadow_divergences"))
