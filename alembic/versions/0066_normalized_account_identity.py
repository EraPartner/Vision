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

Pre-flight: accounts already differing only by case/whitespace are auto-merged
in-migration (deterministically: lowest-id row is canonical, all FKs referencing
accounts(id) are repointed via the catalog, the twins are deleted) so the unique
index can be created without a running app. Previously this RAISEd with a "merge
on the Accounts page" hint — but that UI can't load when the backend crash-loops
on the failed migration, so boot must not depend on it.

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
    # 1. One-time deterministic auto-merge of normalized-identity twins so the
    #    unique index below can be created without a running app. The old
    #    pre-flight RAISEd with a "merge on the Accounts page" hint — but that UI
    #    can't load, because runMigrations() throws on boot and the backend
    #    crash-loops. Instead we merge here: per normalized key (lower(btrim(name)))
    #    the lowest-id row is canonical, every FK that references accounts(id) is
    #    repointed off the colliding rows via the catalog (covers account_id,
    #    funding_account_id, import-batch account_id, and any future FK), then the
    #    now-orphaned twins are deleted. ON DELETE RESTRICT children are safe
    #    because they are repointed before the delete. The stored name keeps the
    #    canonical row's casing (the index normalizes for comparison only). The
    #    still-installed 0062 trigger does not clobber the repoint: on UPDATE with
    #    bank_account unchanged and account_id non-null it takes no branch.
    op.execute(
        """
        DO $$
        DECLARE
            fk record;
            merged bigint;
        BEGIN
            CREATE TEMP TABLE _acct_merge_map ON COMMIT DROP AS
            SELECT a.id AS old_id, c.canonical_id AS new_id
            FROM accounts a
            JOIN (
                SELECT lower(btrim(name)) AS norm, min(id) AS canonical_id
                FROM accounts
                GROUP BY lower(btrim(name))
                HAVING count(*) > 1
            ) c ON lower(btrim(a.name)) = c.norm
            WHERE a.id <> c.canonical_id;

            SELECT count(*) INTO merged FROM _acct_merge_map;
            IF merged = 0 THEN
                RETURN;
            END IF;

            -- Repoint every single-column FK that references accounts(id).
            FOR fk IN
                SELECT con.conrelid::regclass AS child_table,
                       att.attname          AS child_col
                FROM pg_constraint con
                JOIN pg_attribute att
                  ON att.attrelid = con.conrelid
                 AND att.attnum   = con.conkey[1]
                WHERE con.contype = 'f'
                  AND con.confrelid = 'accounts'::regclass
                  AND array_length(con.conkey, 1) = 1
            LOOP
                EXECUTE format(
                    'UPDATE %s c SET %I = m.new_id '
                    'FROM _acct_merge_map m WHERE c.%I = m.old_id',
                    fk.child_table, fk.child_col, fk.child_col
                );
            END LOOP;

            DELETE FROM accounts a
             USING _acct_merge_map m WHERE a.id = m.old_id;

            RAISE NOTICE
                'normalized_account_identity: auto-merged % case/whitespace-duplicate account row(s) into their canonical (lowest-id) twin (ADR-088 addendum)',
                merged;
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
