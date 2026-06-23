"""Normalise legacy currency codes and VALIDATE the 0046 ISO checks.

Revision ID: 0049_validate_currency_checks
Revises: 0048_category_fk_on_delete_set_null
Create Date: 2026-06-18

Migration 0046 added `chk_{transactions,planned_transactions}_currency_iso`
(`currency ~ '^[A-Z]{3}$'`) as NOT VALID, so the shape is enforced for every
new/updated row but pre-existing rows were never scanned. This migration makes
the constraint retroactive so the planner can fully trust it.

Why a migration rather than a one-off psql VALIDATE: the constraint must hold on
EVERY Vision database, including ones future users provision. A fresh user DB
starts empty and every row enters through the already-enforcing 0046 check, so
VALIDATE there is a trivial pass. Only a long-lived DB with legacy rows needs
cleanup — handled below.

Steps (each table):
  1. Normalise rows that BECOME valid after trim+upper (e.g. ' eur ' -> 'EUR').
     Idempotent: a no-op on already-clean data, so it is safe on fresh DBs.
  2. VALIDATE the constraint.

If a long-lived DB still holds un-normalisable values (e.g. 'EURO', '€', ''),
VALIDATE will fail and abort this migration in its transaction (no partial
state). Audit and fix those rows, then re-run:

  SELECT id, currency FROM transactions WHERE currency !~ '^[A-Z]{3}$';
  SELECT id, currency FROM planned_transactions WHERE currency !~ '^[A-Z]{3}$';

Blast radius: at most an UPDATE of malformed rows plus one validating scan per
table (SHARE UPDATE EXCLUSIVE lock — does not block reads or normal writes).
Downgrade cannot "un-validate" in place, so it drops and re-adds each constraint
as NOT VALID (the normalisation is intentionally kept).
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0049_validate_currency_checks"
down_revision: Union[str, Sequence[str], None] = "0048_category_fk_on_delete_set_null"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLES = ("transactions", "planned_transactions")


def upgrade() -> None:
    for table in _TABLES:
        # 1. Normalise only rows that become valid after trim+upper; leave
        #    genuinely-malformed values untouched so VALIDATE surfaces them.
        op.execute(
            f"""
            UPDATE {table}
               SET currency = upper(trim(currency))
             WHERE currency IS DISTINCT FROM upper(trim(currency))
               AND upper(trim(currency)) ~ '^[A-Z]{{3}}$'
            """
        )
        # 2. Make the NOT VALID constraint retroactive.
        op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT chk_{table}_currency_iso")


def downgrade() -> None:
    # There is no ALTER ... INVALIDATE; recreate each constraint as NOT VALID.
    for table in _TABLES:
        op.execute(
            f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS chk_{table}_currency_iso"
        )
        op.execute(
            f"""
            ALTER TABLE {table}
                ADD CONSTRAINT chk_{table}_currency_iso
                CHECK (currency ~ '^[A-Z]{{3}}$') NOT VALID
            """
        )
