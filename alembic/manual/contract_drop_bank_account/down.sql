-- ROLLBACK for up.sql — restore transactions/planned_transactions.bank_account
-- and the dual-write trigger. mv_bank_balances is intentionally NOT restored: it
-- was a dead view (zero readers) dropped for good by migration 0082, independent
-- of the string column, so bringing it back would only re-create an orphan.
--
-- Lossless: accounts.name was backfilled from these same strings, so the values
-- re-derive exactly. Column/index shape mirrors alembic/versions/0056; the
-- trigger function body mirrors the HEAD variant (migration 0083). Run this
-- only to undo a premature up.sql. Reverting the coupled code first is not
-- required (it is safe to run with either code version: it restores the string).

BEGIN;

-- 1. Re-add the columns and re-derive values from accounts.name.
ALTER TABLE transactions        ADD COLUMN IF NOT EXISTS bank_account TEXT;
ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS bank_account TEXT;

UPDATE transactions t SET bank_account = a.name
  FROM accounts a WHERE t.account_id = a.id AND t.bank_account IS NULL;
UPDATE planned_transactions p SET bank_account = a.name
  FROM accounts a WHERE p.account_id = a.id AND p.bank_account IS NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_bank_account ON transactions (bank_account);
CREATE INDEX IF NOT EXISTS idx_transactions_bank_date ON transactions (bank_account, date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_bank_date_active
    ON transactions (bank_account, date DESC) WHERE is_active = true;

-- 2. Recreate the ADR-088 dual-write trigger + function — the HEAD variant
--    (migration 0083: 0076's blank-on-UPDATE detach + case-insensitive
--    resolve, with the ON CONFLICT arbiter on the 0066 unique expression
--    index lower(btrim(name))). An earlier revision of this file restored the
--    0056 body instead, whose `ON CONFLICT (name)` arbiter matches NO unique
--    index at head since 0066 dropped uq_accounts_name → 42P10 on every
--    first-seen label (the exact regression 0083 exists to fix). Keep this
--    body in lockstep with the latest sync-trigger migration.
CREATE OR REPLACE FUNCTION sync_account_id_from_bank_account()
RETURNS trigger AS $$
DECLARE acct_name text;
        resolved_id integer;
BEGIN
    acct_name := btrim(NEW.bank_account);
    IF acct_name IS NULL OR acct_name = '' THEN
        -- Blanking the label on UPDATE detaches the account: keeping the
        -- stale account_id made the row keep counting toward an account
        -- whose label was removed. Leave INSERTs and already-blank UPDATEs
        -- alone (account-first writers set account_id directly with no
        -- bank_account string).
        IF TG_OP = 'UPDATE' AND NEW.bank_account IS DISTINCT FROM OLD.bank_account THEN
            NEW.account_id := NULL;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Case-insensitive resolve first: "Kbc" must reuse "KBC", not create
        -- a duplicate account. Only a label with no casing variant onboards
        -- a brand-new account.
        SELECT id INTO resolved_id FROM accounts
         WHERE lower(btrim(name)) = lower(acct_name)
         ORDER BY id LIMIT 1;
        IF resolved_id IS NULL THEN
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
        -- UPDATE: resolve ONLY against existing accounts (0062 semantics —
        -- never create); case-insensitively.
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

DROP TRIGGER IF EXISTS trg_transactions_account_sync ON transactions;
CREATE TRIGGER trg_transactions_account_sync
    BEFORE INSERT OR UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION sync_account_id_from_bank_account();

DROP TRIGGER IF EXISTS trg_planned_transactions_account_sync ON planned_transactions;
CREATE TRIGGER trg_planned_transactions_account_sync
    BEFORE INSERT OR UPDATE ON planned_transactions
    FOR EACH ROW EXECUTE FUNCTION sync_account_id_from_bank_account();

COMMIT;
