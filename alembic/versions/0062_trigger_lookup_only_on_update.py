"""Account-sync trigger lookup-only on UPDATE + enforce split total <= ABS(amount).

Revision ID: 0062_trigger_lookup_only_on_update
Revises: 0061_investments_show_in_ticker
Create Date: 2026-06-25

The dual-write trigger `sync_account_id_from_bank_account()` (0051/0056, ADR-088)
ran a resolve-OR-CREATE on every INSERT *and* UPDATE: if `btrim(NEW.bank_account)`
matched no existing account it silently `INSERT`ed a new one. On UPDATE that is a
foot-gun — editing a row's `bank_account` to a stale/typo/renamed label (via the
DB editor, the info dialog's bank edit, or an account rename that never propagated
to the string) spawned a phantom account that polluted the accounts hub and net
worth. It is also how the historical 'KBC'/'BELFIUS' institution-name labels could
have resurrected as stray accounts on the next edit.

Fix: keep resolve-or-create on INSERT (new imports must still onboard a brand-new
account from its label), but make UPDATE **lookup-only** — resolve against an
existing account or leave `account_id` unchanged; never create. Reads already use
`account_id` (ADR-088), so create-on-update is obsolete.

Blast radius: replaces one trigger FUNCTION in place (CREATE OR REPLACE); the two
triggers (transactions, planned_transactions) stay attached and need no change.
INSERT behaviour is byte-for-byte identical. Pure behavioural narrowing of the
UPDATE path — no data is read or written by the migration itself.

It also adds a guard trigger so a transaction's `amount` can never be shrunk
below the sum of its splits (splits are validated against ABS(amount) only at
creation — splitRepository.createSplitAtomic; editing the parent down via PATCH
or the DB editor previously left the splits exceeding the parent, with nothing
to catch it). Enforced at the DB so it covers the DB editor too, which bypasses
all app-level validation.

Rollback: downgrade() restores the prior resolve-or-create-on-update function
verbatim from 0056 and drops the split-guard trigger + function. Tested by
re-running upgrade()→downgrade()→upgrade().

NOTE: migrations are not auto-run by the agent — authored here; the user applies it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0062_trigger_lookup_only_on_update"
down_revision: Union[str, Sequence[str], None] = "0061_investments_show_in_ticker"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION sync_account_id_from_bank_account()
        RETURNS trigger AS $$
        DECLARE acct_name text;
                resolved_id integer;
        BEGIN
            acct_name := btrim(NEW.bank_account);
            IF acct_name IS NOT NULL AND acct_name <> '' THEN
                IF TG_OP = 'INSERT' THEN
                    -- Onboarding: a brand-new label creates its account. The
                    -- import pipeline relies on this for first-seen accounts.
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (name) DO NOTHING;
                    SELECT id INTO NEW.account_id FROM accounts WHERE name = acct_name;
                ELSIF NEW.bank_account IS DISTINCT FROM OLD.bank_account
                      OR NEW.account_id IS NULL THEN
                    -- UPDATE: resolve ONLY against existing accounts. A stale or
                    -- mistyped bank_account must never spawn a phantom account;
                    -- if nothing matches, keep the existing account_id.
                    SELECT id INTO resolved_id FROM accounts WHERE name = acct_name;
                    IF resolved_id IS NOT NULL THEN
                        NEW.account_id := resolved_id;
                    END IF;
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    # Guard: a transaction's amount may never drop below the sum of its splits.
    # Only fires when amount actually changes, so normal edits pay nothing.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION enforce_split_within_amount()
        RETURNS trigger AS $$
        DECLARE split_sum numeric;
        BEGIN
            IF NEW.amount IS DISTINCT FROM OLD.amount THEN
                SELECT COALESCE(SUM(amount), 0) INTO split_sum
                  FROM transaction_splits WHERE transaction_id = NEW.id;
                IF split_sum > ABS(NEW.amount) + 0.005 THEN
                    RAISE EXCEPTION
                        'transaction % amount % is below its split total %',
                        NEW.id, NEW.amount, split_sum
                        USING ERRCODE = 'check_violation';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_enforce_split_within_amount ON transactions;
        CREATE TRIGGER trg_enforce_split_within_amount
            BEFORE UPDATE ON transactions
            FOR EACH ROW EXECUTE FUNCTION enforce_split_within_amount();
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_enforce_split_within_amount ON transactions;
        DROP FUNCTION IF EXISTS enforce_split_within_amount();
        """
    )
    # Restore the prior resolve-or-create-on-update function (0056 variant).
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
        """
    )
