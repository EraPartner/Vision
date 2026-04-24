"""Create attachments table for receipt and document uploads.

Revision ID: 0004_attachments
Revises: 0003_import_batch_id_on_transactions
Create Date: 2026-04-23

Stores metadata for files uploaded against a transaction.
Actual file bytes live on disk at {ATTACHMENTS_DIR}/{transaction_id}/{uuid}.{ext}.

ON DELETE CASCADE: deleting a transaction removes its attachment rows.
The route layer is responsible for removing files from disk.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0004_attachments'
down_revision: Union[str, Sequence[str], None] = '0003_import_batch_id_on_transactions'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS attachments (
            id          BIGSERIAL PRIMARY KEY,
            transaction_id BIGINT NOT NULL
                REFERENCES transactions(id) ON DELETE CASCADE,
            filename    TEXT    NOT NULL,
            stored_path TEXT    NOT NULL,
            mime_type   TEXT    NOT NULL,
            size_bytes  BIGINT  NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_attachments_transaction_id
        ON attachments (transaction_id);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_attachments_transaction_id;")
    op.execute("DROP TABLE IF EXISTS attachments;")
