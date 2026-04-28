"""cashflow_forecast_mc_rolling: MC cache for rolling-window forecast

Revision ID: 0016_cashflow_forecast_mc_rolling
Revises: 0015_recipient_match_patterns
Create Date: 2026-04-28

Caches rolling-window MC forecast payloads keyed by
(user_id, today_iso, days_back, days_forward, filter_hash).
Row expires after ~6 hours (application-layer TTL).
"""

from alembic import op

revision = '0016_cashflow_forecast_mc_rolling'
down_revision = '0015_recipient_match_patterns'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE cashflow_forecast_mc_rolling (
            id           SERIAL PRIMARY KEY,
            user_id      TEXT NOT NULL DEFAULT 'anonymous',
            today_iso    TEXT NOT NULL,
            days_back    INTEGER NOT NULL,
            days_forward INTEGER NOT NULL,
            filter_hash  TEXT NOT NULL,
            mc_paths     INTEGER NOT NULL DEFAULT 1000,
            payload      JSONB NOT NULL,
            computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, today_iso, days_back, days_forward, filter_hash)
        )
    """)
    op.execute(
        "CREATE INDEX idx_cfmcr_user_today ON cashflow_forecast_mc_rolling (user_id, today_iso)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_cfmcr_user_today")
    op.execute("DROP TABLE IF EXISTS cashflow_forecast_mc_rolling")
