"""normalized_account_identity: case/whitespace-insensitive account identity (ADR-088 addendum, D1).

Revision ID: 0066_normalized_account_identity
Revises: 0065_statement_balance_requires_date
Create Date: 2026-07-10

Account identity was enforced case-SENSITIVELY (uq_accounts_name on the raw
string) while writers disagree on casing: transaction paths UPPER the label,
`POST /api/accounts` only trims — so "Checking" + import "CHECKING" minted two
accounts. Decision D1 (2026-07-10, ADR-088 addendum) keeps implicit minting but
normalizes identity everywhere:

- uq_accounts_name is replaced by a unique expression index on
  `lower(btrim(name))`; the stored name keeps the user's casing for display.
- The sync trigger's INSERT ON CONFLICT retargets the expression index and both
  lookups compare normalized on both sides (closes the filed case-sensitive
  INSERT/UPDATE findings).
- Blanking `bank_account` on UPDATE now also NULLs `account_id` — the row stops
  counting toward an account whose label was removed (decides the filed 0062
  edge). Rows that never had a bank_account (e.g. ADR-090 trade cash legs) are
  untouched: the branch only fires when the string itself changed.

Pre-flight: accounts already differing only by case/whitespace must be merged
first — the migration fails loudly with the offending names rather than letting
CREATE UNIQUE INDEX throw an opaque duplicate-key error.

Blast radius: one index swap + one trigger function replace; no row rewrite.
Downgrade restores the 0062 function verbatim, drops the expression index and
re-adds uq_accounts_name (always satisfiable — exact uniqueness is weaker than
normalized uniqueness).

NOTE: migrations are not auto-run by the agent — authored here; applied on the
next app boot.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0066_normalized_account_identity"
down_revision: Union[str, Sequence[str], None] = "0065_statement_balance_requires_date"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. One-time duplicate check: normalized-identity twins must be merged
    #    (Accounts page → ⋮ → Merge) before the unique index can exist.
    op.execute(
        """
        DO $$
        DECLARE dup text;
        BEGIN
            SELECT string_agg(names, ' | ') INTO dup FROM (
                SELECT string_agg(name, ' / ' ORDER BY name) AS names
                FROM accounts
                GROUP BY lower(btrim(name))
                HAVING count(*) > 1
            ) d;
            IF dup IS NOT NULL THEN
                RAISE EXCEPTION
                    'accounts differing only by case/whitespace exist and must be merged before normalized identity (ADR-088 addendum) can be enforced: %',
                    dup
                    USING HINT = 'Merge each pair on the Accounts page (card menu -> Merge), then re-run migrations.';
            END IF;
        END $$;
        """
    )

    # 2. Swap uniqueness: expression index first (so no window without a
    #    uniqueness guarantee), then drop the raw-string constraint.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_name_norm
            ON accounts (lower(btrim(name)));
        ALTER TABLE accounts DROP CONSTRAINT IF EXISTS uq_accounts_name;
        """
    )

    # 3. Trigger: same 0062 semantics (resolve-or-create on INSERT, lookup-only
    #    on UPDATE), but identity is normalized, and clearing the label on
    #    UPDATE now clears the FK too.
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
                    -- Onboarding: a brand-new label creates its account. A
                    -- re-cased/re-spaced label resolves to the existing account
                    -- instead of minting a twin (ADR-088 addendum, D1).
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (lower(btrim(name))) DO NOTHING;
                    SELECT id INTO NEW.account_id FROM accounts
                     WHERE lower(btrim(name)) = lower(acct_name);
                ELSIF NEW.bank_account IS DISTINCT FROM OLD.bank_account
                      OR NEW.account_id IS NULL THEN
                    -- UPDATE: resolve ONLY against existing accounts (0062). A
                    -- stale or mistyped bank_account must never spawn a phantom
                    -- account; if nothing matches, keep the existing account_id.
                    SELECT id INTO resolved_id FROM accounts
                     WHERE lower(btrim(name)) = lower(acct_name);
                    IF resolved_id IS NOT NULL THEN
                        NEW.account_id := resolved_id;
                    END IF;
                END IF;
            ELSIF TG_OP = 'UPDATE'
                  AND NEW.bank_account IS DISTINCT FROM OLD.bank_account THEN
                -- The label was explicitly cleared: the row stops counting
                -- toward the account (D1 decides the filed 0062 edge). Rows
                -- that never had a bank_account (e.g. ADR-090 trade cash legs)
                -- keep their explicit account_id — this branch only fires when
                -- the string itself changed.
                NEW.account_id := NULL;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )


def downgrade() -> None:
    # Restore the 0062 function verbatim (case-sensitive, no blank-clears-FK).
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
                    INSERT INTO accounts (name, display_name)
                        VALUES (acct_name, acct_name)
                        ON CONFLICT (name) DO NOTHING;
                    SELECT id INTO NEW.account_id FROM accounts WHERE name = acct_name;
                ELSIF NEW.bank_account IS DISTINCT FROM OLD.bank_account
                      OR NEW.account_id IS NULL THEN
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
    op.execute(
        """
        ALTER TABLE accounts DROP CONSTRAINT IF EXISTS uq_accounts_name;
        ALTER TABLE accounts ADD CONSTRAINT uq_accounts_name UNIQUE (name);
        DROP INDEX IF EXISTS uq_accounts_name_norm;
        """
    )
