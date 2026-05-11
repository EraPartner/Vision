"""Drop unused idx_transactions_date

Revision ID: 0033_drop_unused_transactions_date_index
Revises: 0032_user_settings_timestamptz
Create Date: 2026-05-11

Confirmed unused against the production-like DB via pg_stat_user_indexes:
0 scans on idx_transactions_date while ix_transactions_date (legacy
SQLAlchemy-named duplicate on the same column) absorbs 529 scans, and
idx_transactions_active partial covers the predominant active-row date
range path with 525 scans. Dropping reclaims 88 kB and removes redundant
write overhead on every INSERT/UPDATE.

Note: ix_transactions_date kept as the actually-used duplicate. A broader
ix_* vs idx_* dedup pass is tracked separately — outside the scope of this
migration since it touches multiple FK-relevant indexes that warrant their
own review.
"""
from typing import Sequence, Union

from alembic import op

revision: str = '0033_drop_unused_transactions_date_index'
down_revision: Union[str, Sequence[str], None] = '0032_user_settings_timestamptz'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_transactions_date;")


def downgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);")
