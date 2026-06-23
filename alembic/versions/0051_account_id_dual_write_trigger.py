"""Dual-write trigger: keep transactions/planned_transactions.account_id in sync with
bank_account (ADR-088, dual-write phase).

Revision ID: 0051_account_id_dual_write_trigger
Revises: 0050_add_accounts_entity
Create Date: 2026-06-18

ADR-088 migrates `bank_account` (string) → `account_id` (FK) via expand → dual-write →
flip-reads → contract. 0050 did the expand + a one-time backfill. This migration is the
DUAL-WRITE mechanism: a BEFORE INSERT/UPDATE trigger on both `transactions` and
`planned_transactions` that resolves-or-creates the account from `bank_account` and writes
`account_id`. Doing it in the database (rather than editing every write path:
create / update / updateWithLoanSchedule / executeAndAdvance / import commit / bulk ops) means
no write path can forget to populate the FK — the same reason the repo already maintains
`updated_at` and `agg_recipient_totals` with triggers.

Resolution matches the 0050 backfill exactly: the account name is `btrim(bank_account)` (the
backfill created one account per distinct trimmed string), so existing rows and new writes land
on the same account. The trigger only (re)resolves on INSERT, when the string changed, or when
account_id is still NULL — a memo-only UPDATE does no extra work.

Pairs with the read-flip code change (running-balance partition + transfer matching now key on
account_id). The app runs `alembic upgrade head` on boot, so this trigger is live before the
new code serves traffic — no window where a new row lacks account_id.

(Forward note for ADR-089/M0e: once the UI sets account_id directly via an account picker, this
trigger's "derive account_id from bank_account" direction will be revisited; for the dual-write
phase bank_account remains the written source.)

Blast radius: one trigger function + two triggers; no table/row rewrite. Downgrade drops both
triggers and the function (account_id values already written stay; they are also re-derivable).

NOTE: migrations are not auto-run by the agent — authored here; applied on the next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0051_account_id_dual_write_trigger"
down_revision: Union[str, Sequence[str], None] = "0050_add_accounts_entity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION sync_account_id_from_bank_account()
        RETURNS trigger AS $$
        DECLARE acct_name text;
        BEGIN
            acct_name := btrim(NEW.bank_account);
            IF acct_name IS NOT NULL AND acct_name <> '' THEN
                -- Only resolve on insert, when the string changed, or when the FK is
                -- still empty — a memo-only update skips the accounts lookup entirely.
                IF TG_OP = 'INSERT'
                   OR NEW.bank_account IS DISTINCT FROM OLD.bank_account
                   OR NEW.account_id IS NULL THEN
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (name) DO NOTHING;
                    SELECT id INTO NEW.account_id FROM accounts WHERE name = acct_name;
                END IF;
            END IF;
            -- No bank_account: leave NEW.account_id as provided. Rows written with an
            -- explicit account_id and no bank_account string (e.g. the trade cash legs
            -- of ADR-090) keep their account link — the trigger never nulls it.
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
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_planned_transactions_account_sync ON planned_transactions;
        DROP TRIGGER IF EXISTS trg_transactions_account_sync ON transactions;
        DROP FUNCTION IF EXISTS sync_account_id_from_bank_account();
        """
    )
