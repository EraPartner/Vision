"""Currency integrity on transactions + planned_transactions (NOT NULL + ISO CHECK).

Revision ID: 0046_currency_integrity
Revises: 0045_exclude_transfers_from_aggregations
Create Date: 2026-06-18

`transactions.currency` and `planned_transactions.currency` were nullable
VARCHAR(3) with no format constraint, even though every raw bank table stores
`currency ... NOT NULL` and read paths already coalesce a missing value to EUR
(e.g. infoRepositoryBanks `r.currency || 'EUR'`). A NULL currency forces those
implicit EUR assumptions downstream and lets malformed codes slip in.

This migration makes the money-bearing currency columns trustworthy:
  1. Backfill: rows with NULL currency become 'EUR' (the app's de-facto default
     and what the read layer already assumed).
  2. Format CHECK (`^[A-Z]{3}$`), added NOT VALID so the migration does not fail
     on any pre-existing malformed legacy codes — it is enforced for every new
     INSERT/UPDATE. After auditing legacy rows you may `VALIDATE CONSTRAINT` in a
     follow-up to make it retroactive.
  3. DEFAULT 'EUR' + NOT NULL so the column can never go back to an unknown state.

COUPLED APP CHANGE (ships in the same commit, required for apply-safety): the
three INSERT paths that previously wrote an explicit NULL currency now write
'EUR' — transactionRepository.create, plannedTransactionRepository.create, and
importPipeline/commit.js. Without it those inserts would violate NOT NULL.

Decision is recorded in docs/adr (currency integrity). Alternative considered:
format CHECK only, leaving the column nullable (zero app coupling) — rejected
because it leaves the "unknown currency" state that the read layer already has
to paper over.

Blast radius: two column rewrites of metadata only (SET NOT NULL scans each
table once to prove no NULLs remain — fast after the backfill). No data is
destroyed. Downgrade removes NOT NULL/DEFAULT/CHECK but cannot restore which
rows were originally NULL (the EUR backfill is intentionally kept).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0046_currency_integrity"
down_revision: Union[str, Sequence[str], None] = (
    "0045_exclude_transfers_from_aggregations"
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLES = ("transactions", "planned_transactions")


def upgrade() -> None:
    for table in _TABLES:
        # 1. Backfill NULLs to the de-facto default before tightening the column.
        op.execute(f"UPDATE {table} SET currency = 'EUR' WHERE currency IS NULL")

        # 2. ISO-4217 shape check, NOT VALID so legacy malformed codes (if any)
        #    do not block the migration; still enforced for new/updated rows.
        op.execute(
            f"""
            ALTER TABLE {table}
                ADD CONSTRAINT chk_{table}_currency_iso
                CHECK (currency ~ '^[A-Z]{{3}}$') NOT VALID
            """
        )

        # 3. Lock in a non-null default so the column can't regress.
        op.execute(f"ALTER TABLE {table} ALTER COLUMN currency SET DEFAULT 'EUR'")
        op.execute(f"ALTER TABLE {table} ALTER COLUMN currency SET NOT NULL")


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ALTER COLUMN currency DROP NOT NULL")
        op.execute(f"ALTER TABLE {table} ALTER COLUMN currency DROP DEFAULT")
        op.execute(
            f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS chk_{table}_currency_iso"
        )
