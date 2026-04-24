"""cashflow_forecast_mc: materialized MC + point-estimate cache

Revision ID: 0013_cashflow_forecast_mc
Revises: 0012_cashflow_forecast_accuracy
Create Date: 2026-04-24

Stores nightly-precomputed (and lazy-cached) forecast payloads keyed by
(user_id, month, filter_hash) so daytime requests can skip the expensive
MC simulation. Rows are upserted on every fresh compute and expire after
~6 hours (enforced by the application layer, not the DB).
"""

from alembic import op

revision = '0013_cashflow_forecast_mc'
down_revision = '0012_cashflow_forecast_accuracy'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE cashflow_forecast_mc (
            id           SERIAL PRIMARY KEY,
            user_id      TEXT NOT NULL DEFAULT 'anonymous',
            month        TEXT NOT NULL,
            filter_hash  TEXT NOT NULL,
            mc_paths     INTEGER NOT NULL DEFAULT 1000,
            payload      JSONB NOT NULL,
            computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, month, filter_hash)
        )
    """)
    op.execute(
        "CREATE INDEX idx_cfmc_user_month ON cashflow_forecast_mc (user_id, month)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_cfmc_user_month")
    op.execute("DROP TABLE IF EXISTS cashflow_forecast_mc")
