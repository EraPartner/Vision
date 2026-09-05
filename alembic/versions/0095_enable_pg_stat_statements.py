"""Enable PostgreSQL query-level performance statistics.

Revision ID: 0095_enable_pg_stat_statements
Revises: 0094_drop_mv_cashflow_daily
Create Date: 2026-09-04

Both managed runtime providers preload the pg_stat_statements library before
Alembic runs. This migration creates its SQL extension for new and existing
Vision databases so operators can inspect normalized query timing evidence.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0095_enable_pg_stat_statements"
down_revision: Union[str, Sequence[str], None] = "0094_drop_mv_cashflow_daily"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements;")


def downgrade() -> None:
    # destructive-ok: query statistics are disposable observability data, not
    # application state. Re-upgrading starts a new statistics history.
    op.execute("DROP EXTENSION IF EXISTS pg_stat_statements;")
