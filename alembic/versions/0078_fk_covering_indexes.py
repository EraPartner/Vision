"""Covering indexes for six unindexed foreign-key columns.

Revision ID: 0078_fk_covering_indexes
Revises: 0077_opening_anchor_unique_index
Create Date: 2026-07-14

Six FK columns have no supporting index. Postgres does not auto-index the
referencing side of a foreign key, so deleting (or updating the key of) a parent
row triggers a sequential scan of the whole child table to check for dependent
rows. On the staging/import tables this is a full seq-scan per parent delete.

Each index is partial (WHERE <col> IS NOT NULL): these columns are overwhelmingly
NULL (unmatched staging rows, un-overridden imports), so a partial index is far
smaller and still covers every referential-integrity probe (the parent-delete
check only ever looks for rows where the FK equals a real parent id, i.e. NOT
NULL). Created IF NOT EXISTS so the migration is idempotent.

  - import_staging_rows.matched_pattern_id            → recipient_match_patterns (ADR-015)
  - import_staging_rows.user_override_recipient_id    → recipients            (ADR-015)
  - manual_raw_transactions.recipient_id              → recipients            (ADR: 0024)
  - manual_raw_transactions.category_id               → categories            (ADR: 0024)
  - portfolio_import_staging_rows.resolved_investment_id      → investments   (ADR: 0040)
  - portfolio_import_staging_rows.user_override_investment_id → investments   (ADR: 0040)

Blast radius: six partial btree indexes, no data change. Downgrade drops all six.
Not auto-run (applied on next app boot).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0078_fk_covering_indexes"
down_revision: Union[str, Sequence[str], None] = "0077_opening_anchor_unique_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_import_staging_rows_matched_pattern_id
            ON import_staging_rows (matched_pattern_id)
            WHERE matched_pattern_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS ix_import_staging_rows_user_override_recipient_id
            ON import_staging_rows (user_override_recipient_id)
            WHERE user_override_recipient_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS ix_manual_raw_transactions_recipient_id
            ON manual_raw_transactions (recipient_id)
            WHERE recipient_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS ix_manual_raw_transactions_category_id
            ON manual_raw_transactions (category_id)
            WHERE category_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS ix_portfolio_import_staging_rows_resolved_investment_id
            ON portfolio_import_staging_rows (resolved_investment_id)
            WHERE resolved_investment_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS ix_portfolio_import_staging_rows_user_override_investment_id
            ON portfolio_import_staging_rows (user_override_investment_id)
            WHERE user_override_investment_id IS NOT NULL;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS ix_import_staging_rows_matched_pattern_id;
        DROP INDEX IF EXISTS ix_import_staging_rows_user_override_recipient_id;
        DROP INDEX IF EXISTS ix_manual_raw_transactions_recipient_id;
        DROP INDEX IF EXISTS ix_manual_raw_transactions_category_id;
        DROP INDEX IF EXISTS ix_portfolio_import_staging_rows_resolved_investment_id;
        DROP INDEX IF EXISTS ix_portfolio_import_staging_rows_user_override_investment_id;
        """
    )
