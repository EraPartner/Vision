"""Add NOT NULL DEFAULT NOW() to updated_at columns across core tables

Revision ID: 0022_updated_at_not_null_defaults
Revises: 0021_split_audit
Create Date: 2026-05-05

Corrective migration: 11 tables were created with `updated_at TIMESTAMPTZ` but
without a DEFAULT or NOT NULL constraint, leaving the column nullable and
unguarded against missing application-layer writes.

For each table:
  1. Backfill any NULL rows using created_at (always set, also TIMESTAMPTZ).
  2. Set DEFAULT NOW() so future inserts without an explicit value are safe.
  3. Set NOT NULL to enforce the invariant at the DB level.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0022_updated_at_not_null_defaults'
down_revision: Union[str, Sequence[str], None] = '0021_split_audit'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = [
    'categories',
    'recipients',
    'recipient_bank_accounts',
    'transactions',
    'planned_transactions',
    'planned_transaction_loan_schedule',
    'exchange_rates',
    'belgian_inflation_rates',
    'asset_price_history',
    'bank_statements',
    'reconciliation_entries',
]


def upgrade() -> None:
    for table in _TABLES:
        op.execute(f"""
            UPDATE {table}
               SET updated_at = COALESCE(created_at, NOW())
             WHERE updated_at IS NULL;
        """)
        op.execute(f"""
            ALTER TABLE {table}
              ALTER COLUMN updated_at SET DEFAULT NOW(),
              ALTER COLUMN updated_at SET NOT NULL;
        """)


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.execute(f"""
            ALTER TABLE {table}
              ALTER COLUMN updated_at DROP DEFAULT,
              ALTER COLUMN updated_at DROP NOT NULL;
        """)
