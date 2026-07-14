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
  2. VALIDATE the constraint — but tolerantly (see below).

If a long-lived DB still holds un-normalisable values (e.g. 'EURO', '€', ''),
a bare VALIDATE would fail and abort the whole migration chain. Because
migrations run fail-fast on app boot, that would strand an Electron end-user at
the error page with psql-only recovery. To avoid bricking boot, the VALIDATE is
wrapped in a savepoint that catches check_violation: on failure the constraint
simply stays NOT VALID (new/updated rows are still shape-enforced by the 0046
check) and a WARNING is logged with the cleanup recipe:

  SELECT id, currency FROM transactions WHERE currency !~ '^[A-Z]{3}$';
  SELECT id, currency FROM planned_transactions WHERE currency !~ '^[A-Z]{3}$';
  -- fix the offending rows, then:
  ALTER TABLE transactions VALIDATE CONSTRAINT chk_transactions_currency_iso;
  ALTER TABLE planned_transactions VALIDATE CONSTRAINT chk_planned_transactions_currency_iso;

On a clean DB VALIDATE succeeds and the constraint is validated exactly as before.

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
        constraint = f"chk_{table}_currency_iso"
        # 1. Normalise only rows that become valid after trim+upper; leave
        #    genuinely-malformed values untouched so the audit query surfaces them.
        op.execute(
            f"""
            UPDATE {table}
               SET currency = upper(trim(currency))
             WHERE currency IS DISTINCT FROM upper(trim(currency))
               AND upper(trim(currency)) ~ '^[A-Z]{{3}}$'
            """
        )
        # 2. Make the NOT VALID constraint retroactive — tolerantly. A bare
        #    VALIDATE aborts the whole migration chain if a long-lived DB still
        #    holds un-normalisable codes ('EURO', '€', ''); because migrations run
        #    fail-fast on boot, that strands an Electron end-user at the error page
        #    with psql-only recovery. Catch the check_violation instead: the
        #    constraint stays NOT VALID (new/updated rows remain shape-enforced by
        #    the 0046 check), boot proceeds, and the warning tells the operator how
        #    to clean up and validate manually. On a clean DB VALIDATE succeeds and
        #    the outcome is identical to before.
        op.execute(
            f"""
            DO $$
            BEGIN
                ALTER TABLE {table} VALIDATE CONSTRAINT {constraint};
            EXCEPTION WHEN check_violation THEN
                RAISE WARNING 'Vision migration 0049: could not VALIDATE {constraint} because {table} still holds currency codes outside ^[A-Z]{{3}}$. The constraint remains NOT VALID; new and updated rows are still enforced. Audit with: SELECT id, currency FROM {table} WHERE currency !~ ''^[A-Z]{{3}}$''; fix those rows, then run: ALTER TABLE {table} VALIDATE CONSTRAINT {constraint};';
            END;
            $$;
            """
        )


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
