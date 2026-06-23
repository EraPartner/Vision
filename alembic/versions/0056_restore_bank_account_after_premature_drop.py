"""Recovery: restore bank_account + the dual-write trigger after the premature 0055 drop (ADR-088).

Revision ID: 0056_restore_bank_account_after_premature_drop
Revises: 0055_drop_bank_account_string
Create Date: 2026-06-18

The original 0055 dropped `bank_account` (+ the dual-write trigger + mv_bank_balances) as part of
the auto-applied chain, which crashed the app (the coupled code wasn't deployed). 0055 is now a
no-op; this migration restores the pre-drop state so the app boots again, and is fully idempotent
so it's a harmless no-op on databases that never hit the bad 0055.

Restores:
  1. `transactions.bank_account` / `planned_transactions.bank_account` (re-derived from
     accounts.name via account_id where missing) + their indexes.
  2. The ADR-088 dual-write trigger + function (the fixed version: preserves an explicitly-set
     account_id; only resolves from bank_account when present).

mv_bank_balances is not touched here — the materialized-view service recreates it on the next boot
now that bank_account exists again.

Blast radius: re-adds nullable columns + indexes + a trigger. Data is re-derived from accounts
(lossless: accounts.name was backfilled from these same strings). Downgrade intentionally does
nothing (we never want to re-drop automatically).

NOTE: migrations are not auto-run by the agent — authored here; applied on the next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0056_restore_bank_account_after_premature_drop"
down_revision: Union[str, Sequence[str], None] = "0055_drop_bank_account_string"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Re-add the columns (no-op if they still exist) and re-derive values from accounts.name
    #    for any row missing the string (i.e. the rows the drop wiped).
    op.execute(
        """
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bank_account TEXT;
        ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS bank_account TEXT;

        UPDATE transactions t SET bank_account = a.name
          FROM accounts a WHERE t.account_id = a.id AND t.bank_account IS NULL;
        UPDATE planned_transactions p SET bank_account = a.name
          FROM accounts a WHERE p.account_id = a.id AND p.bank_account IS NULL;

        CREATE INDEX IF NOT EXISTS idx_transactions_bank_account ON transactions (bank_account);
        CREATE INDEX IF NOT EXISTS idx_transactions_bank_date ON transactions (bank_account, date DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_bank_date_active
            ON transactions (bank_account, date DESC) WHERE is_active = true;
        """
    )

    # 2. Recreate the dual-write trigger + function (ADR-088 / 0051, fixed variant that never nulls
    #    an explicitly-set account_id). CREATE OR REPLACE + DROP/CREATE IF EXISTS = idempotent.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION sync_account_id_from_bank_account()
        RETURNS trigger AS $$
        DECLARE acct_name text;
        BEGIN
            acct_name := btrim(NEW.bank_account);
            IF acct_name IS NOT NULL AND acct_name <> '' THEN
                IF TG_OP = 'INSERT'
                   OR NEW.bank_account IS DISTINCT FROM OLD.bank_account
                   OR NEW.account_id IS NULL THEN
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (name) DO NOTHING;
                    SELECT id INTO NEW.account_id FROM accounts WHERE name = acct_name;
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_transactions_account_sync ON transactions;
        CREATE TRIGGER trg_transactions_account_sync
            BEFORE INSERT OR UPDATE ON transactions
            FOR EACH ROW EXECUTE FUNCTION sync_account_id_from_bank_account();

        DROP TRIGGER IF EXISTS trg_planned_transactions_account_sync ON planned_transactions;
        CREATE TRIGGER trg_planned_transactions_account_sync
            BEFORE INSERT OR UPDATE ON planned_transactions
            FOR EACH ROW EXECUTE FUNCTION sync_account_id_from_bank_account();
        """
    )


def downgrade() -> None:
    # Intentionally a no-op — we never want to automatically re-drop bank_account.
    pass
