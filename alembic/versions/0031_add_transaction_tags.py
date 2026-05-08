"""Add tags, transaction_tags, and planned_transaction_tags tables

Revision ID: 0031_add_transaction_tags
Revises: 0030_add_user_settings_table
Create Date: 2026-05-08

Implements ADR-052: freeform tags as an orthogonal dimension to categories.
Tags are globally unique by slug to allow soft-delete reactivation while
preserving junction row history.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0031_add_transaction_tags'
down_revision: Union[str, Sequence[str], None] = '0030_add_user_settings_table'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS tags (
            id          SERIAL PRIMARY KEY,
            slug        TEXT NOT NULL,
            color       TEXT,
            is_active   BOOLEAN NOT NULL DEFAULT true,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_slug ON tags (slug);
        CREATE INDEX IF NOT EXISTS idx_tags_active ON tags (is_active) WHERE is_active = true;
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS update_tags_updated_at ON tags;
        CREATE TRIGGER update_tags_updated_at
            BEFORE UPDATE ON tags FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS transaction_tags (
            transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            tag_id          INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (transaction_id, tag_id)
        );

        CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags (tag_id);
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS planned_transaction_tags (
            planned_transaction_id INTEGER NOT NULL REFERENCES planned_transactions(id) ON DELETE CASCADE,
            tag_id                 INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (planned_transaction_id, tag_id)
        );

        CREATE INDEX IF NOT EXISTS idx_planned_transaction_tags_tag ON planned_transaction_tags (tag_id);
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS update_tags_updated_at ON tags;")
    op.execute("DROP TABLE IF EXISTS planned_transaction_tags CASCADE;")
    op.execute("DROP TABLE IF EXISTS transaction_tags CASCADE;")
    op.execute("DROP TABLE IF EXISTS tags CASCADE;")
