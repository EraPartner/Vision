"""Add raw transaction tables for bank-specific CSV imports

Revision ID: c1d2e3f4b5a6
Revises: b3f9c9a9d6b2
Create Date: 2026-02-20 14:50:00.000000
"""
from typing import Union, Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'c1d2e3f4b5a6'
down_revision: Union[str, Sequence[str], None] = 'b3f9c9a9d6b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Create Revolut state enum type on Postgres
    if dialect == 'postgresql':
        revolut_enum = postgresql.ENUM('COMPLETED', 'PENDING', 'REVERTED', 'DECLINED', name='revolut_state')
        revolut_enum.create(bind, checkfirst=True)

    # Create Belfius raw table
    op.create_table(
        'belfius_raw_transactions',
        sa.Column('id', sa.Integer(), primary_key=True, nullable=False),
        sa.Column('deduplication_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('account_number', sa.String(length=34), nullable=False),
        sa.Column('transaction_date', sa.Date(), nullable=False),
        sa.Column('statement_number', sa.String(length=50), nullable=True),
        sa.Column('transaction_number', sa.String(length=50), nullable=True),
        sa.Column('recipient_account', sa.String(length=34), nullable=True),
        sa.Column('recipient_name', sa.Text(), nullable=True),
        sa.Column('recipient_street', sa.Text(), nullable=True),
        sa.Column('recipient_location', sa.Text(), nullable=True),
        sa.Column('recipient_bic', sa.String(length=11), nullable=True),
        sa.Column('recipient_country', sa.String(length=2), nullable=True),
        sa.Column('transaction_description', sa.Text(), nullable=True),
        sa.Column('value_date', sa.Date(), nullable=True),
        sa.Column('amount', sa.Numeric(15, 2), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('balance', sa.Numeric(15, 2), nullable=True),
        sa.Column('additional_message', sa.Text(), nullable=True),
        sa.Column('raw_csv_line', sa.Text(), nullable=False),
        sa.UniqueConstraint('deduplication_hash', name='uq_belfius_dedup_hash')
    )
    op.create_index('idx_belfius_account_date', 'belfius_raw_transactions', ['account_number', 'transaction_date'],
                    unique=False)
    op.create_index('ix_belfius_raw_transactions_id', 'belfius_raw_transactions', ['id'], unique=False)
    op.create_index('ix_belfius_raw_transactions_deduplication_hash', 'belfius_raw_transactions',
                    ['deduplication_hash'], unique=True)

    # Create Revolut raw table
    op.create_table(
        'revolut_raw_transactions',
        sa.Column('id', sa.Integer(), primary_key=True, nullable=False),
        sa.Column('deduplication_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('transaction_type', sa.String(length=50), nullable=False),
        sa.Column('product', sa.String(length=50), nullable=False),
        sa.Column('started_date', sa.DateTime(), nullable=True),
        sa.Column('completed_date', sa.DateTime(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('amount', sa.Numeric(15, 2), nullable=False),
        sa.Column('fee', sa.Numeric(15, 2), nullable=True),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('state', sa.Enum('COMPLETED', 'PENDING', 'REVERTED', 'DECLINED', name='revolut_state'),
                  nullable=False),
        sa.Column('balance', sa.Numeric(15, 2), nullable=True),
        sa.Column('raw_csv_line', sa.Text(), nullable=False),
        sa.UniqueConstraint('deduplication_hash', name='uq_revolut_dedup_hash')
    )
    op.create_index('ix_revolut_raw_transactions_id', 'revolut_raw_transactions', ['id'], unique=False)
    op.create_index('ix_revolut_raw_transactions_deduplication_hash', 'revolut_raw_transactions', ['deduplication_hash'], unique=True)
    op.create_index('ix_revolut_raw_transactions_completed_date', 'revolut_raw_transactions', ['completed_date'],
                    unique=False)
    op.create_index('idx_revolut_state', 'revolut_raw_transactions', ['state'], unique=False)
    op.create_index('idx_revolut_product_date', 'revolut_raw_transactions', ['product', 'completed_date'], unique=False)

