"""Remove feature_flags table — all features always enabled.

Revision ID: 0011_drop_feature_flags
Revises: 0010_add_provider_health
Create Date: 2026-04-24

Feature flags replaced with always-on behaviour. Runtime toggles removed.
See ADR-034.
"""

from alembic import op
import sqlalchemy as sa

revision = '0011_drop_feature_flags'
down_revision = '0010_add_provider_health'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("DROP TRIGGER IF EXISTS set_feature_flags_updated_at ON feature_flags"))
    op.execute(sa.text("DROP INDEX IF EXISTS idx_feature_flags_key"))
    op.execute(sa.text("DROP TABLE IF EXISTS feature_flags"))


def downgrade():
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS feature_flags (
            id          SERIAL PRIMARY KEY,
            key         VARCHAR(100) NOT NULL,
            enabled     BOOLEAN NOT NULL DEFAULT false,
            description TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_feature_flags_key UNIQUE (key)
        )
    """))
    op.execute(sa.text(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_key ON feature_flags (key)"
    ))
    op.execute(sa.text("""
        CREATE TRIGGER set_feature_flags_updated_at
            BEFORE UPDATE ON feature_flags
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    """))
