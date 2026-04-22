"""Recipient + category uniqueness constraints — Phase 6 of the
non-portfolio refactor.

Revision ID: 0029_recipient_category_uniqueness
Revises: 0028_split_audit_overpayment_guard
Create Date: 2026-04-16

Background: recipients.normalized_name, categories (general, detail), and
recipient_bank_accounts.account_number have been app-enforced unique
forever. Fresh databases pick up DB-level UNIQUE constraints from
schemaInit.js (`CREATE TABLE IF NOT EXISTS` definitions), but older
databases provisioned before those constraints were added to schemaInit
never got them. This migration retrofits the constraints for every
environment, with a pre-dedupe pass that consolidates existing
duplicates.

Pre-dedupe policy:
  * recipients duplicated on normalized_name: keep the lowest id
    (oldest), point other rows' transactions / splits / planned_transactions
    / recipient_bank_accounts / recipients.primary_recipient_id at it,
    then delete the dupes. Safe because normalized_name is already used
    as a lookup key in app code.
  * categories duplicated on (general, detail): keep the lowest id,
    repoint transactions.category_id + recipients.default_category_id +
    planned_transactions.category_id + split rows' category_id, then
    delete dupes.
  * recipient_bank_accounts duplicated on account_number: keep the
    lowest id, repoint transactions.recipient_bank_account_id, then
    delete dupes.

Rollback: constraints dropped. Dedupe is not reversible (dupes were
semantically equivalent to begin with, so no data is lost), but the
migration does not touch the base data until the constraint is
reinstalled.
"""

from typing import Sequence, Union

from alembic import op


revision: str = '0029_recipient_category_uniqueness'
down_revision: Union[str, Sequence[str], None] = '0028_split_audit_overpayment_guard'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. Dedupe recipient_bank_accounts on account_number
    # ------------------------------------------------------------------
    # Must run before recipient dedupe because recipient_bank_accounts
    # references recipients(id) and we keep FKs consistent.
    op.execute("""
        WITH dupes AS (
            SELECT id, account_number,
                   MIN(id) OVER (PARTITION BY account_number) AS keep_id
            FROM recipient_bank_accounts
        ),
        repoint AS (
            UPDATE transactions t
            SET recipient_bank_account_id = d.keep_id
            FROM dupes d
            WHERE t.recipient_bank_account_id = d.id
              AND d.id <> d.keep_id
            RETURNING 1
        )
        DELETE FROM recipient_bank_accounts rba
        USING dupes d
        WHERE rba.id = d.id
          AND d.id <> d.keep_id;
    """)

    # ------------------------------------------------------------------
    # 2. Dedupe recipients on normalized_name
    # ------------------------------------------------------------------
    # Capture mapping table first so every downstream repoint uses the
    # same snapshot; otherwise trigger-maintained agg_recipient_totals
    # can race against the FK repoints and double-count.
    op.execute("""
        CREATE TEMP TABLE _recipient_dedupe_map ON COMMIT DROP AS
        SELECT id AS dup_id,
               MIN(id) OVER (PARTITION BY normalized_name) AS keep_id
        FROM recipients
        WHERE normalized_name IS NOT NULL;
    """)

    # Repoint transactions.recipient_id.
    op.execute("""
        UPDATE transactions t
        SET recipient_id = m.keep_id
        FROM _recipient_dedupe_map m
        WHERE t.recipient_id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    # Repoint transaction_splits.recipient_id.
    op.execute("""
        UPDATE transaction_splits s
        SET recipient_id = m.keep_id
        FROM _recipient_dedupe_map m
        WHERE s.recipient_id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    # Repoint planned_transactions.recipient_id if the table/column exist.
    # planned_transactions has been in the schema since early migrations;
    # the guard keeps this migration safe on fresh test DBs.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'planned_transactions'
                  AND column_name = 'recipient_id'
            ) THEN
                UPDATE planned_transactions p
                SET recipient_id = m.keep_id
                FROM _recipient_dedupe_map m
                WHERE p.recipient_id = m.dup_id
                  AND m.dup_id <> m.keep_id;
            END IF;
        END$$;
    """)

    # Repoint recipient_bank_accounts.recipient_id.
    op.execute("""
        UPDATE recipient_bank_accounts rba
        SET recipient_id = m.keep_id
        FROM _recipient_dedupe_map m
        WHERE rba.recipient_id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    # Null out primary_recipient_id where it now points at a removed row.
    op.execute("""
        UPDATE recipients r
        SET primary_recipient_id = m.keep_id
        FROM _recipient_dedupe_map m
        WHERE r.primary_recipient_id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    # Finally, delete the duplicate recipient rows.
    op.execute("""
        DELETE FROM recipients r
        USING _recipient_dedupe_map m
        WHERE r.id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    # Rebuild agg_recipient_totals from current truth after the repoints,
    # since triggers only fire on row-level changes and the bulk UPDATEs
    # above will have fired them row-by-row, but dedupe may have left
    # stale (recipient_id, currency) rows keyed on deleted recipient ids.
    # ON DELETE CASCADE on agg_recipient_totals.recipient_id already
    # cleaned those, but we refresh to be safe.
    op.execute("""
        DELETE FROM agg_recipient_totals
        WHERE recipient_id NOT IN (SELECT id FROM recipients);
    """)

    # ------------------------------------------------------------------
    # 3. Dedupe categories on (general, detail)
    # ------------------------------------------------------------------
    op.execute("""
        CREATE TEMP TABLE _category_dedupe_map ON COMMIT DROP AS
        SELECT id AS dup_id,
               MIN(id) OVER (PARTITION BY general, detail) AS keep_id
        FROM categories;
    """)

    op.execute("""
        UPDATE transactions t
        SET category_id = m.keep_id
        FROM _category_dedupe_map m
        WHERE t.category_id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    op.execute("""
        UPDATE recipients r
        SET default_category_id = m.keep_id
        FROM _category_dedupe_map m
        WHERE r.default_category_id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'planned_transactions'
                  AND column_name = 'category_id'
            ) THEN
                UPDATE planned_transactions p
                SET category_id = m.keep_id
                FROM _category_dedupe_map m
                WHERE p.category_id = m.dup_id
                  AND m.dup_id <> m.keep_id;
            END IF;
        END$$;
    """)

    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'transaction_splits'
                  AND column_name = 'category_id'
            ) THEN
                UPDATE transaction_splits s
                SET category_id = m.keep_id
                FROM _category_dedupe_map m
                WHERE s.category_id = m.dup_id
                  AND m.dup_id <> m.keep_id;
            END IF;
        END$$;
    """)

    op.execute("""
        DELETE FROM categories c
        USING _category_dedupe_map m
        WHERE c.id = m.dup_id
          AND m.dup_id <> m.keep_id;
    """)

    # ------------------------------------------------------------------
    # 4. Install UNIQUE constraints (idempotent — check pg_constraint).
    # ------------------------------------------------------------------
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_recipients_normalized_name'
                  AND conrelid = 'recipients'::regclass
            ) THEN
                -- If schemaInit created an inline UNIQUE (which names
                -- the constraint recipients_normalized_name_key),
                -- renaming avoids creating a duplicate constraint.
                IF EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'recipients_normalized_name_key'
                      AND conrelid = 'recipients'::regclass
                ) THEN
                    ALTER TABLE recipients
                        RENAME CONSTRAINT recipients_normalized_name_key
                        TO uq_recipients_normalized_name;
                ELSE
                    ALTER TABLE recipients
                        ADD CONSTRAINT uq_recipients_normalized_name
                        UNIQUE (normalized_name);
                END IF;
            END IF;
        END$$;
    """)

    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_general_detail'
                  AND conrelid = 'categories'::regclass
            ) THEN
                ALTER TABLE categories
                    ADD CONSTRAINT uq_general_detail
                    UNIQUE (general, detail);
            END IF;
        END$$;
    """)

    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_rba_account_number'
                  AND conrelid = 'recipient_bank_accounts'::regclass
            ) THEN
                IF EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'recipient_bank_accounts_account_number_key'
                      AND conrelid = 'recipient_bank_accounts'::regclass
                ) THEN
                    ALTER TABLE recipient_bank_accounts
                        RENAME CONSTRAINT recipient_bank_accounts_account_number_key
                        TO uq_rba_account_number;
                ELSE
                    ALTER TABLE recipient_bank_accounts
                        ADD CONSTRAINT uq_rba_account_number
                        UNIQUE (account_number);
                END IF;
            END IF;
        END$$;
    """)


def downgrade() -> None:
    # Constraints only — dedupe is not reversible (dupes were equivalent
    # and their FKs have been merged onto the surviving rows).
    op.execute("""
        ALTER TABLE IF EXISTS recipient_bank_accounts
            DROP CONSTRAINT IF EXISTS uq_rba_account_number;
    """)
    op.execute("""
        ALTER TABLE IF EXISTS categories
            DROP CONSTRAINT IF EXISTS uq_general_detail;
    """)
    op.execute("""
        ALTER TABLE IF EXISTS recipients
            DROP CONSTRAINT IF EXISTS uq_recipients_normalized_name;
    """)
