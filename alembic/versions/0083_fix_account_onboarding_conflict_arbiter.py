"""Repair the account-sync trigger's ON CONFLICT arbiter regressed by 0076.

Revision ID: 0083_fix_account_onboarding_conflict_arbiter
Revises: 0082_drop_mv_bank_balances
Create Date: 2026-07-28

Migration 0066 (ADR-088 addendum, D1) replaced `uq_accounts_name` with the
unique expression index `uq_accounts_name_norm` on `lower(btrim(name))` and
retargeted `sync_account_id_from_bank_account()`'s onboarding INSERT to
`ON CONFLICT (lower(btrim(name)))`. The trigger rewrite in 0076 (blank-label
detach + case-insensitive resolve) regressed that arbiter back to
`ON CONFLICT (name)` — which matches NO unique index at head, so the first
INSERT of a transaction whose `bank_account` label has no existing account
raised 42P10 ("there is no unique or exclusion constraint matching the
ON CONFLICT specification"). Existing labels (any casing) still resolved —
the resolve path short-circuits before the INSERT — but first-seen-label
onboarding (e.g. the first CSV import for a brand-new account) blew up.
Pinned (now flipped) by tests/transactionRepository.db.test.js.

This migration re-creates the function with 0076's exact body — both of its
fixes (blank-on-UPDATE detaches; case-insensitive resolve-before-create) are
preserved — changing ONLY the arbiter to `(lower(btrim(name)))`.

Why this duplicates an in-place edit of 0076: the function lives in the
database, so installs already at/past 0076 only get the fix via this
CREATE OR REPLACE — editing 0076 retroactively does nothing for them. 0076
is ALSO edited in place (same arbiter) so fresh installs and installs below
0076 never pass through the broken state; for those, this migration is an
idempotent re-create of the same function.

Blast radius: replaces one trigger FUNCTION in place (CREATE OR REPLACE); the
triggers on transactions / planned_transactions stay attached. No data is read
or written by the migration itself.

Rollback: downgrade() restores the 0076 function verbatim as it originally
shipped (i.e. with the broken `ON CONFLICT (name)` arbiter — that IS the 0076
state; downgrading past this revision reintroduces the onboarding failure).

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0083_fix_account_onboarding_conflict_arbiter"
down_revision: Union[str, Sequence[str], None] = "0082_drop_mv_bank_balances"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 0076's body verbatim, except the ON CONFLICT arbiter now targets the
    # unique expression index uq_accounts_name_norm (0066) instead of the
    # dropped uq_accounts_name constraint.
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
                    -- Arbiter = the 0066 unique expression index
                    -- uq_accounts_name_norm. 0076 shipped `ON CONFLICT (name)`
                    -- here, which matches no unique index since 0066 dropped
                    -- uq_accounts_name → 42P10 on every first-seen label.
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (lower(btrim(name))) DO NOTHING;
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
    # Restore the 0076 function verbatim as originally shipped — including its
    # broken `ON CONFLICT (name)` arbiter, because that IS the 0076 state.
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
