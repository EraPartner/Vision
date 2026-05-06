"""Add user_settings table

Revision ID: 0030_add_user_settings_table
Revises: 0029_fix_raw_ref_unique
Create Date: 2026-05-06

Moves user_settings schema ownership to Alembic (ADR-027). Previously the
table was created at runtime by settingsRepository.js via CREATE TABLE IF NOT
EXISTS, violating the single-source-of-truth DDL policy.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0030_add_user_settings_table'
down_revision: Union[str, Sequence[str], None] = '0029_fix_raw_ref_unique'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS user_settings (
            key         VARCHAR(100) PRIMARY KEY,
            value       JSONB        NOT NULL,
            created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """))


def downgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS user_settings"))
