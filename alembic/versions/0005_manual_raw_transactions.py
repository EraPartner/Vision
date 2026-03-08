"""Add manual raw transactions table for deduplication

Revision ID: 0005_manual_raw_transactions
Revises: 0004_portfolio_tables
Create Date: 2026-03-08

Adds a raw transaction table for manually added transactions to enable
hash-based deduplication, consistent with how imported transactions work.
"""
from typing import Sequence, Union
import sqlalchemy as sa

revision: str = '0005_manual_raw_transactions'
down_revision: Union[str, Sequence[str], None] = '0004_portfolio_tables'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    from alembic import op

    op.execute("""
        CREATE TABLE IF NOT EXISTS manual_raw_transactions (
            id SERIAL PRIMARY KEY,
            deduplication_hash VARCHAR(64) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            transaction_id INTEGER,
            date DATE NOT NULL,
            bank_account VARCHAR(100),
            recipient_id INTEGER,
            amount NUMERIC(15, 2) NOT NULL,
            memo TEXT,
            currency VARCHAR(3),
            category_id INTEGER,
            comment TEXT,
            CONSTRAINT uq_manual_dedup_hash UNIQUE (deduplication_hash)
        );
    """)
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS ix_manual_raw_transactions_deduplication_hash
        ON manual_raw_transactions (deduplication_hash);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_manual_raw_transactions_date_amount
        ON manual_raw_transactions (date, amount);
    """)


def downgrade() -> None:
    from alembic import op
    op.drop_index('ix_manual_raw_transactions_date_amount')
    op.drop_index('ix_manual_raw_transactions_deduplication_hash')
    op.drop_table('manual_raw_transactions')
