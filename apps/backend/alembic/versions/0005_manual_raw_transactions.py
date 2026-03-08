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
    op = sa.ops  # noqa - handled by alembic context
    from alembic import op

    op.create_table(
        'manual_raw_transactions',
        sa.Column('id', sa.Integer(), primary_key=True, nullable=False),
        sa.Column('deduplication_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('transaction_id', sa.Integer(), nullable=True),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('bank_account', sa.String(100), nullable=True),
        sa.Column('recipient_id', sa.Integer(), nullable=True),
        sa.Column('amount', sa.Numeric(15, 2), nullable=False),
        sa.Column('memo', sa.Text(), nullable=True),
        sa.Column('currency', sa.String(3), nullable=True),
        sa.Column('category_id', sa.Integer(), nullable=True),
        sa.Column('comment', sa.Text(), nullable=True),
        sa.UniqueConstraint('deduplication_hash', name='uq_manual_dedup_hash'),
    )
    op.create_index('ix_manual_raw_transactions_deduplication_hash',
                    'manual_raw_transactions', ['deduplication_hash'], unique=True)
    op.create_index('ix_manual_raw_transactions_date_amount',
                    'manual_raw_transactions', ['date', 'amount'])


def downgrade() -> None:
    from alembic import op
    op.drop_index('ix_manual_raw_transactions_date_amount')
    op.drop_index('ix_manual_raw_transactions_deduplication_hash')
    op.drop_table('manual_raw_transactions')
