"""Drop custom_raw_transactions table

Revision ID: 0008_drop_custom_raw_txns
Revises: 0007_recipient_merge
Create Date: 2026-03-08

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0008_drop_custom_raw_txns'
down_revision: Union[str, Sequence[str], None] = '0007_recipient_merge'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop deprecated custom raw transactions table."""
    op.execute("""
        DROP TABLE IF EXISTS custom_raw_transactions CASCADE;
    """)


def downgrade() -> None:
    """Recreate custom_raw_transactions table."""
    op.execute("""
        CREATE TABLE IF NOT EXISTS custom_raw_transactions (
            id SERIAL PRIMARY KEY,
            deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            date TIMESTAMPTZ NOT NULL,
            description TEXT NOT NULL,
            amount NUMERIC(15,2) NOT NULL,
            currency VARCHAR(3) NOT NULL,
            counterparty_name TEXT NOT NULL,
            counterparty_account VARCHAR(34) NOT NULL,
            balance NUMERIC(15,2),
            category_name TEXT,
            comments TEXT,
            raw_csv_line TEXT,
            raw_metadata JSONB
        );
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_custom_hash
        ON custom_raw_transactions (deduplication_hash);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_custom_date
        ON custom_raw_transactions (date);
    """)
