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
    op.create_index('ix_revolut_raw_transactions_deduplication_hash', 'revolut_raw_transactions',
                    ['deduplication_hash'], unique=True)
    op.create_index('ix_revolut_raw_transactions_completed_date', 'revolut_raw_transactions', ['completed_date'],
                    unique=False)
    op.create_index('idx_revolut_state', 'revolut_raw_transactions', ['state'], unique=False)
    op.create_index('idx_revolut_product_date', 'revolut_raw_transactions', ['product', 'completed_date'], unique=False)

    # Create KBC raw table
    op.create_table(
        'kbc_raw_transactions',
        sa.Column('id', sa.Integer(), primary_key=True, nullable=False),
        sa.Column('deduplication_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('account_number', sa.String(length=34), nullable=False),
        sa.Column('category_name', sa.Text(), nullable=True),
        sa.Column('account_holder_name', sa.Text(), nullable=True),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('statement_number', sa.String(length=50), nullable=True),
        sa.Column('transaction_date', sa.Date(), nullable=False),
        sa.Column('value_date', sa.Date(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('amount', sa.Numeric(15, 2), nullable=False),
        sa.Column('balance', sa.Numeric(15, 2), nullable=True),
        sa.Column('credit_amount', sa.Numeric(15, 2), nullable=True),
        sa.Column('debit_amount', sa.Numeric(15, 2), nullable=True),
        sa.Column('counterparty_account', sa.String(length=34), nullable=True),
        sa.Column('counterparty_bic', sa.String(length=11), nullable=True),
        sa.Column('counterparty_name', sa.Text(), nullable=True),
        sa.Column('counterparty_address', sa.Text(), nullable=True),
        sa.Column('structured_communication', sa.Text(), nullable=True),
        sa.Column('free_communication', sa.Text(), nullable=True),
        sa.Column('raw_csv_line', sa.Text(), nullable=False),
        sa.UniqueConstraint('deduplication_hash', name='uq_kbc_dedup_hash'),
        sa.CheckConstraint('length(account_number) <= 34', name='ck_kbc_account_len')
    )
    op.create_index('ix_kbc_raw_transactions_id', 'kbc_raw_transactions', ['id'], unique=False)
    op.create_index('ix_kbc_raw_transactions_deduplication_hash', 'kbc_raw_transactions', ['deduplication_hash'],
                    unique=True)
    op.create_index('ix_kbc_raw_transactions_transaction_date', 'kbc_raw_transactions', ['transaction_date'],
                    unique=False)
    op.create_index('ix_kbc_raw_transactions_account_number', 'kbc_raw_transactions', ['account_number'], unique=False)
    op.create_index('idx_kbc_statement', 'kbc_raw_transactions', ['statement_number'], unique=False)
    op.create_index('idx_kbc_account_date', 'kbc_raw_transactions', ['account_number', 'transaction_date'],
                    unique=False)

    # Create Custom raw table
    op.create_table(
        'custom_raw_transactions',
        sa.Column('id', sa.Integer(), primary_key=True, nullable=False),
        sa.Column('deduplication_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('date', sa.DateTime(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('amount', sa.Numeric(15, 2), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('counterparty_name', sa.Text(), nullable=False),
        sa.Column('counterparty_account', sa.String(length=34), nullable=False),
        sa.Column('balance', sa.Numeric(15, 2), nullable=True),
        sa.Column('category_name', sa.Text(), nullable=True),
        sa.Column('comments', sa.Text(), nullable=True),
        sa.Column('raw_csv_line', sa.Text(), nullable=True),
        sa.Column('raw_metadata', sa.JSON(), nullable=True),
        sa.UniqueConstraint('deduplication_hash', name='uq_custom_dedup_hash'),
        sa.CheckConstraint('length(counterparty_account) <= 34', name='ck_custom_counterparty_account_len')
    )
    op.create_index('ix_custom_transactions_id', 'custom_raw_transactions', ['id'], unique=False)
    op.create_index('ix_custom_transactions_deduplication_hash', 'custom_raw_transactions', ['deduplication_hash'],
                    unique=True)
    op.create_index('idx_custom_date', 'custom_raw_transactions', ['date'], unique=False)
    op.create_index('ix_custom_transactions_counterparty_account', 'custom_raw_transactions', ['counterparty_account'],
                    unique=False)

    # Create transaction_raw_references table
    op.create_table(
        'transaction_raw_references',
        sa.Column('id', sa.Integer(), primary_key=True, nullable=False),
        sa.Column('transaction_id', sa.Integer(), sa.ForeignKey('transactions.id', ondelete='CASCADE'), nullable=False),
        sa.Column('raw_source_type', sa.String(length=20), nullable=False),
        sa.Column('raw_source_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('raw_source_type', 'raw_source_id', name='uq_raw_source')
    )
    op.create_index('ix_transaction_raw_references_id', 'transaction_raw_references', ['id'], unique=False)
    op.create_index('ix_transaction_raw_references_transaction_id', 'transaction_raw_references', ['transaction_id'],
                    unique=True)
    op.create_index('ix_transaction_raw_references_raw_source_type', 'transaction_raw_references', ['raw_source_type'],
                    unique=False)
    op.create_index('ix_transaction_raw_references_raw_source_id', 'transaction_raw_references', ['raw_source_id'],
                    unique=False)
    op.create_index('idx_raw_ref_source', 'transaction_raw_references', ['raw_source_type', 'raw_source_id'],
                    unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Drop tables and indexes in reverse order
    op.drop_index('idx_raw_ref_source', table_name='transaction_raw_references')
    op.drop_index('ix_transaction_raw_references_raw_source_id', table_name='transaction_raw_references')
    op.drop_index('ix_transaction_raw_references_raw_source_type', table_name='transaction_raw_references')
    op.drop_index('ix_transaction_raw_references_transaction_id', table_name='transaction_raw_references')
    op.drop_index('ix_transaction_raw_references_id', table_name='transaction_raw_references')
    op.drop_table('transaction_raw_references')

    op.drop_index('ix_custom_transactions_counterparty_account', table_name='custom_raw_transactions')
    op.drop_index('idx_custom_date', table_name='custom_raw_transactions')
    op.drop_index('ix_custom_transactions_deduplication_hash', table_name='custom_raw_transactions')
    op.drop_index('ix_custom_transactions_id', table_name='custom_raw_transactions')
    op.drop_table('custom_raw_transactions')

    op.drop_index('idx_kbc_account_date', table_name='kbc_raw_transactions')
    op.drop_index('idx_kbc_statement', table_name='kbc_raw_transactions')
    op.drop_index('ix_kbc_raw_transactions_account_number', table_name='kbc_raw_transactions')
    op.drop_index('ix_kbc_raw_transactions_transaction_date', table_name='kbc_raw_transactions')
    op.drop_index('ix_kbc_raw_transactions_deduplication_hash', table_name='kbc_raw_transactions')
    op.drop_index('ix_kbc_raw_transactions_id', table_name='kbc_raw_transactions')
    op.drop_table('kbc_raw_transactions')

    op.drop_index('idx_revolut_product_date', table_name='revolut_raw_transactions')
    op.drop_index('idx_revolut_state', table_name='revolut_raw_transactions')
    op.drop_index('ix_revolut_raw_transactions_completed_date', table_name='revolut_raw_transactions')
    op.drop_index('ix_revolut_raw_transactions_deduplication_hash', table_name='revolut_raw_transactions')
    op.drop_index('ix_revolut_raw_transactions_id', table_name='revolut_raw_transactions')
    op.drop_table('revolut_raw_transactions')

    op.drop_index('ix_belfius_raw_transactions_deduplication_hash', table_name='belfius_raw_transactions')
    op.drop_index('ix_belfius_raw_transactions_id', table_name='belfius_raw_transactions')
    op.drop_index('idx_belfius_account_date', table_name='belfius_raw_transactions')
    op.drop_table('belfius_raw_transactions')

    # Drop Revolut enum on Postgres
    if dialect == 'postgresql':
        revolut_enum = postgresql.ENUM('COMPLETED', 'PENDING', 'REVERTED', 'DECLINED', name='revolut_state')
        revolut_enum.drop(bind, checkfirst=True)
