"""Add transaction splits and split payments tables

Revision ID: 0009_transaction_splits
Revises: 0008_drop_custom_raw_txns
Create Date: 2026-03-11

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0009_transaction_splits'
down_revision: Union[str, Sequence[str], None] = '0008_drop_custom_raw_txns'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create transaction_splits and split_payments tables."""
    op.execute("""
        CREATE TABLE IF NOT EXISTS transaction_splits (
            id SERIAL PRIMARY KEY,
            transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            recipient_id INTEGER NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
            amount NUMERIC(15,2) NOT NULL,
            note TEXT,
            is_settled BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX idx_splits_transaction ON transaction_splits(transaction_id);
        CREATE INDEX idx_splits_recipient ON transaction_splits(recipient_id);
        CREATE INDEX idx_splits_unsettled ON transaction_splits(is_settled) WHERE is_settled = false;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS split_payments (
            id SERIAL PRIMARY KEY,
            split_id INTEGER NOT NULL REFERENCES transaction_splits(id) ON DELETE CASCADE,
            amount NUMERIC(15,2) NOT NULL,
            paid_at DATE NOT NULL DEFAULT CURRENT_DATE,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX idx_split_payments_split ON split_payments(split_id);
    """)

    # Trigger to update updated_at on transaction_splits
    op.execute("""
        CREATE TRIGGER update_transaction_splits_updated_at
            BEFORE UPDATE ON transaction_splits
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
    """)


def downgrade() -> None:
    """Drop transaction splits tables."""
    op.execute("DROP TRIGGER IF EXISTS update_transaction_splits_updated_at ON transaction_splits;")
    op.execute("DROP TABLE IF EXISTS split_payments CASCADE;")
    op.execute("DROP TABLE IF EXISTS transaction_splits CASCADE;")
