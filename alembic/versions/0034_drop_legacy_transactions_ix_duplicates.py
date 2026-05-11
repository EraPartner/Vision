"""Drop legacy ix_transactions_* duplicates of canonical idx_transactions_*

Revision ID: 0034_drop_legacy_transactions_ix_duplicates
Revises: 0033_drop_unused_transactions_date_index
Create Date: 2026-05-11

Five legacy SQLAlchemy-named indexes (`ix_transactions_*`) exist only in DBs
that predate the Alembic baseline (0001). Each one has an identical-definition
canonical counterpart (`idx_transactions_*`) that already exists on every
install. The legacy duplicates cost write amplification on INSERT/UPDATE and
~360 kB of disk per row of value — i.e. none.

Confirmed identical via pg_indexes.indexdef on the prod-like volume:

  ix_transactions_id                         <-> transactions_pkey (UNIQUE)
  ix_transactions_recipient_id               <-> idx_transactions_recipient_id
  ix_transactions_bank_account               <-> idx_transactions_bank_account
  ix_transactions_category_id                <-> idx_transactions_category_id
  ix_transactions_recipient_bank_account_id  <-> idx_transactions_recipient_bank_account_id

When the planner currently prefers an `ix_*` index (e.g. ix_transactions_recipient_id
sees 56 scans because it was created first and has a lower oid), dropping it
re-plans to the identical `idx_*` with no change in plan shape or cost.

Not dropped here:
  - ix_transactions_date — no idx_* counterpart remains after 0033; sole single-
    column date index, gets real traffic (529 scans). Addressed separately if
    a converged story is needed.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0034_drop_legacy_transactions_ix_duplicates'
down_revision: Union[str, Sequence[str], None] = '0033_drop_unused_transactions_date_index'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


LEGACY_INDEXES = (
    'ix_transactions_id',
    'ix_transactions_recipient_id',
    'ix_transactions_bank_account',
    'ix_transactions_category_id',
    'ix_transactions_recipient_bank_account_id',
)

LEGACY_DEFINITIONS = {
    'ix_transactions_id': 'CREATE INDEX IF NOT EXISTS ix_transactions_id ON transactions (id);',
    'ix_transactions_recipient_id': 'CREATE INDEX IF NOT EXISTS ix_transactions_recipient_id ON transactions (recipient_id);',
    'ix_transactions_bank_account': 'CREATE INDEX IF NOT EXISTS ix_transactions_bank_account ON transactions (bank_account);',
    'ix_transactions_category_id': 'CREATE INDEX IF NOT EXISTS ix_transactions_category_id ON transactions (category_id);',
    'ix_transactions_recipient_bank_account_id': 'CREATE INDEX IF NOT EXISTS ix_transactions_recipient_bank_account_id ON transactions (recipient_bank_account_id);',
}


def upgrade() -> None:
    for name in LEGACY_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name};")


def downgrade() -> None:
    for name in LEGACY_INDEXES:
        op.execute(LEGACY_DEFINITIONS[name])
