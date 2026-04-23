"""Add feature_flags table for runtime-toggleable feature flags.

Revision ID: 0002_feature_flags
Revises: 0001_initial
Create Date: 2026-04-23 00:00:00.000000

Adds a ``feature_flags`` table that allows features to be enabled or disabled
at runtime via the admin API without requiring a deployment or restart.

This replaces the hard-coded environment-variable checks for ``AI_CHAT_ENABLED``
and ``AGGREGATIONS_V2_ENABLED`` with a DB-persisted source of truth.  Env vars
continue to function as the initial default values during seed — the DB value
overrides them once written.

Schema:
  * feature_flags(id, key, enabled, description, created_at, updated_at)
  * Unique index on ``key`` for fast keyed lookups.
  * Reuses the existing ``update_updated_at_column()`` trigger function.

Seed rows:
  * ai_chat         — enabled=false  (override via PATCH /admin/feature-flags)
  * aggregations_v2 — enabled=false
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op


revision: str = '0002_feature_flags'
down_revision: Union[str, None] = '0001_initial'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'feature_flags',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('key', sa.String(length=100), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key', name='uq_feature_flags_key'),
    )

    op.create_index('idx_feature_flags_key', 'feature_flags', ['key'], unique=True)

    op.execute("""
        CREATE TRIGGER set_feature_flags_updated_at
            BEFORE UPDATE ON feature_flags
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    """)

    # Seed default flags
    op.execute("""
        INSERT INTO feature_flags (key, enabled, description) VALUES
            ('ai_chat',         false, 'Enable AI chat / Ollama integration'),
            ('aggregations_v2', false, 'Enable aggregations V2 data processing pipeline')
        ON CONFLICT (key) DO NOTHING;
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS set_feature_flags_updated_at ON feature_flags;")
    op.drop_index('idx_feature_flags_key', table_name='feature_flags')
    op.drop_table('feature_flags')
