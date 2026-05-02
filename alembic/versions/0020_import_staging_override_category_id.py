"""Import staging override category id

Revision ID: 0020_import_staging_override_category_id
Revises: 0019_transaction_splits_and_agg
Create Date: 2026-05-02

Adds `import_staging_rows.override_category_id` so the import review step can
assign a per-row category before commit. The commit phase resolves
``effective_category_id = COALESCE(staging.override_category_id,
recipient.default_category_id, NULL)`` and writes it directly into
``transactions.category_id``. See ADR-046.
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0020_import_staging_override_category_id'
down_revision: Union[str, Sequence[str], None] = '0019_transaction_splits_and_agg'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE import_staging_rows
            ADD COLUMN IF NOT EXISTS override_category_id INTEGER
                REFERENCES categories(id) ON DELETE SET NULL
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_staging_override_category
            ON import_staging_rows (override_category_id)
            WHERE override_category_id IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_staging_override_category")
    op.execute("ALTER TABLE import_staging_rows DROP COLUMN IF EXISTS override_category_id")
