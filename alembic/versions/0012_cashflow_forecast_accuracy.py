"""Add cashflow_forecast_accuracy table for per-method backtest persistence.

Revision ID: 0012_cashflow_forecast_accuracy
Revises: 0011_drop_feature_flags
Create Date: 2026-04-24

Each nightly backtest run upserts one row per (user_id, method_id, as_of_month).
The table is the substrate for the v2 ensemble method (inverse-MSE weights).
Partitioned logically by as_of_month; rows older than 24 months may be archived.
"""

from alembic import op
import sqlalchemy as sa

revision = '0012_cashflow_forecast_accuracy'
down_revision = '0011_drop_feature_flags'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS cashflow_forecast_accuracy (
            id          SERIAL PRIMARY KEY,
            user_id     TEXT NOT NULL DEFAULT 'anonymous',
            method_id   TEXT NOT NULL,
            as_of_month TEXT NOT NULL,
            mae         DOUBLE PRECISION,
            rmse        DOUBLE PRECISION,
            mape        DOUBLE PRECISION,
            sample_days INTEGER,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_cfa_user_method_month
                UNIQUE (user_id, method_id, as_of_month)
        )
    """))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_cfa_user_method "
        "ON cashflow_forecast_accuracy (user_id, method_id)"
    ))
    op.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_cfa_as_of_month "
        "ON cashflow_forecast_accuracy (as_of_month)"
    ))


def downgrade():
    op.execute(sa.text("DROP INDEX IF EXISTS idx_cfa_as_of_month"))
    op.execute(sa.text("DROP INDEX IF EXISTS idx_cfa_user_method"))
    op.execute(sa.text("DROP TABLE IF EXISTS cashflow_forecast_accuracy"))
