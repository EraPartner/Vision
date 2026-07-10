"""statement_balance_requires_date: a statement balance must carry its date (ADR-094).

Revision ID: 0065_statement_balance_requires_date
Revises: 0064_saved_charts_all_source_flags
Create Date: 2026-07-10

A statement balance without its as-of date is meaningless for drift: the diff
against the computed ledger balance can't be anchored in time. The service and
form now require the date whenever a balance is set; this CHECK backstops them.

Existing rows that carry a balance but no date are backfilled from updated_at
(the last time the row was touched — the closest known proxy for when the
balance was entered) so the constraint validates cleanly.

Blast radius: one CHECK on accounts plus a backfill UPDATE limited to rows with
a dateless balance. Downgrade drops the CHECK (backfilled dates are kept — they
are data, not schema).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0065_statement_balance_requires_date"
down_revision: Union[str, Sequence[str], None] = "0064_saved_charts_all_source_flags"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE accounts
        SET statement_balance_date = updated_at::date
        WHERE statement_balance IS NOT NULL
          AND statement_balance_date IS NULL;
        """
    )
    op.execute(
        """
        ALTER TABLE accounts
            DROP CONSTRAINT IF EXISTS ck_accounts_statement_balance_has_date;
        ALTER TABLE accounts
            ADD CONSTRAINT ck_accounts_statement_balance_has_date
            CHECK (statement_balance IS NULL OR statement_balance_date IS NOT NULL);
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ck_accounts_statement_balance_has_date"
    )
