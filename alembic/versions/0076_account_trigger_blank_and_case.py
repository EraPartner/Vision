"""Account-sync trigger: detach account_id when bank_account is blanked; case-insensitive lookup.

Revision ID: 0076_account_trigger_blank_and_case
Revises: 0075_transfer_source_adjustment
Create Date: 2026-07-13

Two fixes to `sync_account_id_from_bank_account()` (0051/0056/0062, ADR-088):

1. **Blank-on-UPDATE detaches.** The 0062 body was gated on
   `acct_name IS NOT NULL AND <> ''`, so an UPDATE that *cleared*
   `bank_account` silently kept the old `account_id` — the row kept counting
   toward an account whose label was explicitly removed. Now an UPDATE that
   changes `bank_account` to blank/NULL also NULLs `account_id`. INSERTs with
   no label are untouched (account-first writers may supply `account_id`
   directly), as are UPDATEs where `bank_account` was already blank.

2. **Case-insensitive resolve.** Lookups matched `name = acct_name` exactly
   (and INSERT relied on the case-sensitive `ON CONFLICT (name)`), so a
   casing-only difference ("Kbc" vs "KBC") spawned a duplicate account on
   INSERT and was silently ignored on UPDATE. Both paths now resolve via
   `lower(btrim(name))` first; INSERT only creates a new account when no
   casing variant exists. Deliberate semantics change: a new label that
   differs from an existing account only by case now REUSES that account
   instead of creating a sibling. No case-insensitive unique index is added —
   existing databases may legitimately contain case-duplicate names, and the
   deterministic `ORDER BY id LIMIT 1` picks the oldest.

Blast radius: replaces one trigger FUNCTION in place (CREATE OR REPLACE); the
triggers on transactions / planned_transactions stay attached. No data is read
or written by the migration itself.

Rollback: downgrade() restores the 0062 function verbatim.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0076_account_trigger_blank_and_case"
down_revision: Union[str, Sequence[str], None] = "0075_transfer_source_adjustment"
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
            IF acct_name IS NULL OR acct_name = '' THEN
                -- Blanking the label on UPDATE detaches the account: keeping
                -- the stale account_id made the row keep counting toward an
                -- account whose label was removed. Leave INSERTs and
                -- already-blank UPDATEs alone (account-first writers set
                -- account_id directly with no bank_account string).
                IF TG_OP = 'UPDATE' AND NEW.bank_account IS DISTINCT FROM OLD.bank_account THEN
                    NEW.account_id := NULL;
                END IF;
                RETURN NEW;
            END IF;

            IF TG_OP = 'INSERT' THEN
                -- Case-insensitive resolve first: "Kbc" must reuse "KBC",
                -- not create a duplicate account. Only a label with no
                -- casing variant onboards a brand-new account.
                SELECT id INTO resolved_id FROM accounts
                 WHERE lower(btrim(name)) = lower(acct_name)
                 ORDER BY id LIMIT 1;
                IF resolved_id IS NULL THEN
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (name) DO NOTHING;
                    SELECT id INTO resolved_id FROM accounts
                     WHERE lower(btrim(name)) = lower(acct_name)
                     ORDER BY id LIMIT 1;
                END IF;
                NEW.account_id := resolved_id;
            ELSIF NEW.bank_account IS DISTINCT FROM OLD.bank_account
                  OR NEW.account_id IS NULL THEN
                -- UPDATE: resolve ONLY against existing accounts (0062
                -- semantics — never create); now case-insensitively.
                SELECT id INTO resolved_id FROM accounts
                 WHERE lower(btrim(name)) = lower(acct_name)
                 ORDER BY id LIMIT 1;
                IF resolved_id IS NOT NULL THEN
                    NEW.account_id := resolved_id;
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )


def downgrade() -> None:
    # Restore the 0062 function verbatim (lookup-only-on-update, exact-case).
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
