"""Account entity: accounts table + account_id FKs + backfill (ADR-088, expand phase).

Revision ID: 0050_add_accounts_entity
Revises: 0049_validate_currency_checks
Create Date: 2026-06-18

(Chains off 0049_validate_currency_checks — a sibling migration authored concurrently as the
ADR-086 follow-up — to keep a single linear head; this one is 0050, not a second 0049.)

An "account" is currently an implicit free-text string: `bank_account TEXT` on both
`transactions` and `planned_transactions`. That string is the partition key of the
running-balance ledger, the group key of bank balances + history, the distinctness
requirement for transfer detection (ADR-083), and the filter/group key in statistics and the
materialized views — yet there is nowhere to attach what an account *is* (type, balance to
reconcile against, holdings, owner, liability sign). ADR-088 replaces the string with a real
entity via expand → dual-write → flip-reads → contract.

THIS MIGRATION IS THE EXPAND PHASE (+ a one-time backfill):
  1. Create the `accounts` table with its identity columns plus the orthogonal flag columns up
     front (the flags' *semantics* are activated in ADR-089; shipping the columns now avoids a
     second table rewrite). `currency` follows the ADR-086 convention (NOT NULL + DEFAULT 'EUR'
     + ISO `^[A-Z]{3}$` CHECK).
  2. Add a nullable `account_id` to `transactions` and `planned_transactions`,
     `ON DELETE RESTRICT` — an account that still owns rows cannot be deleted (history-protecting
     FK policy, ADR-087). Account removal is the "close/archive" workflow (ADR-091), not a delete.
  3. Backfill one `accounts` row per distinct trimmed `bank_account` string (from both tables),
     copy a representative currency onto each account, and set `account_id` on existing rows.

Dual-write (writers populate both the string and the FK) and flip-reads happen in app code; the
`bank_account` string is dropped only in a LATER migration after a dual-write soak with parity
checks. Distinct from `recipient_bank_accounts` (counterparty IBANs, ADR-015/ADR-087).

Blast radius: one new table + two nullable columns + indexes (no rewrite of existing columns),
plus a bounded backfill (one INSERT over distinct strings, two UPDATEs keyed by the new index).
No existing data is destroyed. Downgrade drops the columns/indexes, the table, and the enum
types; the backfilled `account_id` values disappear with the columns (the `bank_account` string
is untouched, so re-applying re-derives them).

NOTE: migrations are not auto-run — this is AUTHORED NOT YET APPLIED; the user applies it.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "0050_add_accounts_entity"
down_revision: Union[str, Sequence[str], None] = "0049_validate_currency_checks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Enum types for the categorical flags (idempotent, matching the 0001 idiom) ──
    op.execute(
        """
        DO $$ BEGIN
          CREATE TYPE account_type AS ENUM (
            'checking', 'savings', 'brokerage', 'crypto_exchange', 'wallet', 'pension', 'liability'
          );
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE account_liquidity_class AS ENUM ('liquid', 'semi_liquid', 'illiquid');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE account_tax_wrapper AS ENUM ('none', 'pension', 'tax_advantaged');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE account_owner AS ENUM ('me', 'partner', 'joint');
        EXCEPTION WHEN duplicate_object THEN null; END $$;
        """
    )

    # ── accounts table ──
    # `name` is TEXT (not VARCHAR(200)) because it is backfilled verbatim from the TEXT
    # bank_account column — exact equality is required for the backfill link below, so no
    # truncation can be allowed.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS accounts (
          id                   SERIAL PRIMARY KEY,
          name                 TEXT NOT NULL,
          display_name         TEXT,
          institution          TEXT,
          currency             VARCHAR(3) NOT NULL DEFAULT 'EUR',
          type                 account_type NOT NULL DEFAULT 'checking',
          liquidity_class      account_liquidity_class NOT NULL DEFAULT 'liquid',
          spendable            BOOLEAN NOT NULL DEFAULT true,
          in_net_worth         BOOLEAN NOT NULL DEFAULT true,
          tax_wrapper          account_tax_wrapper NOT NULL DEFAULT 'none',
          owner                account_owner NOT NULL DEFAULT 'me',
          multi_currency_cash  BOOLEAN NOT NULL DEFAULT false,
          has_cash_sleeve      BOOLEAN NOT NULL DEFAULT true,
          funding_account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          is_active            BOOLEAN NOT NULL DEFAULT true,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_accounts_name UNIQUE (name),
          CONSTRAINT chk_accounts_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
        );

        DROP TRIGGER IF EXISTS update_accounts_updated_at ON accounts;
        CREATE TRIGGER update_accounts_updated_at
            BEFORE UPDATE ON accounts FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        """
    )

    # ── account_id FKs (ON DELETE RESTRICT) + indexes ──
    op.execute(
        """
        ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS account_id INTEGER
            REFERENCES accounts(id) ON DELETE RESTRICT;
        ALTER TABLE planned_transactions
            ADD COLUMN IF NOT EXISTS account_id INTEGER
            REFERENCES accounts(id) ON DELETE RESTRICT;

        CREATE INDEX IF NOT EXISTS idx_transactions_account_id
            ON transactions (account_id);
        -- Mirrors idx_transactions_bank_date_active for the running-balance window
        -- (PARTITION BY account_id ORDER BY date) and the balance-history LATERAL probe.
        CREATE INDEX IF NOT EXISTS idx_transactions_account_date_active
            ON transactions (account_id, date DESC) WHERE is_active = true;
        CREATE INDEX IF NOT EXISTS idx_planned_transactions_account_id
            ON planned_transactions (account_id);
        """
    )

    # ── Backfill: one account per distinct own-account string (both tables) ──
    op.execute(
        """
        INSERT INTO accounts (name, display_name)
        SELECT s.acct, s.acct FROM (
            SELECT DISTINCT btrim(bank_account) AS acct FROM transactions
             WHERE bank_account IS NOT NULL AND btrim(bank_account) <> ''
            UNION
            SELECT DISTINCT btrim(bank_account) AS acct FROM planned_transactions
             WHERE bank_account IS NOT NULL AND btrim(bank_account) <> ''
        ) s
        ON CONFLICT (name) DO NOTHING;
        """
    )

    # Set each account's currency from its most recent transaction (only when the source
    # value is a valid ISO code, so the CHECK can never be violated; otherwise the 'EUR'
    # default stands).
    op.execute(
        """
        UPDATE accounts a
           SET currency = sub.currency
          FROM (
            SELECT DISTINCT ON (btrim(bank_account)) btrim(bank_account) AS acct, currency
              FROM transactions
             WHERE bank_account IS NOT NULL AND btrim(bank_account) <> ''
             ORDER BY btrim(bank_account), date DESC, id DESC
          ) sub
         WHERE a.name = sub.acct
           AND sub.currency ~ '^[A-Z]{3}$';
        """
    )

    # Fallback: accounts that appear only in planned_transactions (no transaction ever
    # supplied a valid ISO currency) derive their currency from the most recent planned
    # row instead. The NOT EXISTS guard keeps a transaction-derived currency authoritative
    # and makes this idempotent — it only touches accounts the previous UPDATE left at the
    # 'EUR' default because they have no valid-currency transaction.
    op.execute(
        """
        UPDATE accounts a
           SET currency = sub.currency
          FROM (
            SELECT DISTINCT ON (btrim(bank_account)) btrim(bank_account) AS acct, currency
              FROM planned_transactions
             WHERE bank_account IS NOT NULL AND btrim(bank_account) <> ''
             ORDER BY btrim(bank_account), planned_date DESC, id DESC
          ) sub
         WHERE a.name = sub.acct
           AND sub.currency ~ '^[A-Z]{3}$'
           AND NOT EXISTS (
             SELECT 1 FROM transactions t
              WHERE t.bank_account IS NOT NULL
                AND btrim(t.bank_account) = a.name
                AND t.currency ~ '^[A-Z]{3}$'
           );
        """
    )

    # Link existing rows to their account by exact trimmed-name match.
    op.execute(
        """
        UPDATE transactions t
           SET account_id = a.id
          FROM accounts a
         WHERE t.account_id IS NULL
           AND t.bank_account IS NOT NULL
           AND a.name = btrim(t.bank_account);

        UPDATE planned_transactions p
           SET account_id = a.id
          FROM accounts a
         WHERE p.account_id IS NULL
           AND p.bank_account IS NOT NULL
           AND a.name = btrim(p.bank_account);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS idx_planned_transactions_account_id;
        DROP INDEX IF EXISTS idx_transactions_account_date_active;
        DROP INDEX IF EXISTS idx_transactions_account_id;

        ALTER TABLE planned_transactions DROP COLUMN IF EXISTS account_id;
        ALTER TABLE transactions DROP COLUMN IF EXISTS account_id;

        DROP TRIGGER IF EXISTS update_accounts_updated_at ON accounts;
        DROP TABLE IF EXISTS accounts;

        DROP TYPE IF EXISTS account_owner;
        DROP TYPE IF EXISTS account_tax_wrapper;
        DROP TYPE IF EXISTS account_liquidity_class;
        DROP TYPE IF EXISTS account_type;
        """
    )
