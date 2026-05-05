"""Add NOT NULL DEFAULT NOW() to updated_at columns across core tables

Revision ID: 0022_updated_at_not_null_defaults
Revises: 0021_split_audit
Create Date: 2026-05-05

Corrective migration: 9 tables were created with `updated_at TIMESTAMPTZ` but
without a DEFAULT or NOT NULL constraint, leaving the column nullable and
unguarded against missing application-layer writes.

For each table:
  1. Backfill any NULL rows — use created_at where it exists, fetched_at for
     rate/price tables that track fetch time instead of creation time.
  2. Set DEFAULT NOW() so future inserts without an explicit value are safe.
  3. Set NOT NULL to enforce the invariant at the DB level.

Excluded tables:
  - bank_statements, reconciliation_entries: dropped in 0014.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0022_updated_at_not_null_defaults'
down_revision: Union[str, Sequence[str], None] = '0021_split_audit'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (table, backfill_source) — source column used to seed updated_at where NULL.
# Tables without created_at use fetched_at (rate/price tables track fetch time).
# bank_statements and reconciliation_entries excluded: dropped in migration 0014.
_TABLES: list[tuple[str, str]] = [
    ('categories',                      'created_at'),
    ('recipients',                      'created_at'),
    ('recipient_bank_accounts',         'created_at'),
    ('transactions',                    'created_at'),
    ('planned_transactions',            'created_at'),
    ('planned_transaction_loan_schedule', 'created_at'),
    ('exchange_rates',                  'fetched_at'),
    ('belgian_inflation_rates',         'fetched_at'),
    ('asset_price_history',             'fetched_at'),
]


def upgrade() -> None:
    for table, backfill_col in _TABLES:
        op.execute(f"""
            UPDATE {table}
               SET updated_at = COALESCE({backfill_col}, NOW())
             WHERE updated_at IS NULL;
        """)
        op.execute(f"""
            ALTER TABLE {table}
              ALTER COLUMN updated_at SET DEFAULT NOW(),
              ALTER COLUMN updated_at SET NOT NULL;
        """)


def downgrade() -> None:
    for table, _ in reversed(_TABLES):
        op.execute(f"""
            ALTER TABLE {table}
              ALTER COLUMN updated_at DROP DEFAULT,
              ALTER COLUMN updated_at DROP NOT NULL;
        """)
