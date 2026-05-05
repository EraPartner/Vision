"""Add split_audit table

Revision ID: 0021_split_audit
Revises: 0020_import_staging_override_category_id
Create Date: 2026-05-05

Adds the split_audit table referenced by splitRepository.writeAudit().
Without this migration the table is absent and any split payment operation
throws a "relation does not exist" error at runtime.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0021_split_audit'
down_revision: Union[str, Sequence[str], None] = '0020_import_staging_override_category_id'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS split_audit (
            id          BIGSERIAL PRIMARY KEY,
            split_id    INTEGER REFERENCES transaction_splits(id) ON DELETE SET NULL,
            action      VARCHAR(50) NOT NULL,
            actor       TEXT,
            payload     JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_split_audit_split_id
            ON split_audit (split_id);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS split_audit;")
