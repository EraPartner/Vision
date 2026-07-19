-- ROLLBACK for up.sql — restore transactions/planned_transactions.bank_account
-- and the dual-write trigger. mv_bank_balances is intentionally NOT restored: it
-- was a dead view (zero readers) dropped for good by migration 0082, independent
-- of the string column, so bringing it back would only re-create an orphan.
--
-- Lossless: accounts.name was backfilled from these same strings, so the values
-- re-derive exactly. Mirrors alembic/versions/0056 + the pre-contract MV. Run
-- this only to undo a premature up.sql, BEFORE reverting the coupled code is not
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

-- 2. Recreate the ADR-088 dual-write trigger + function (the 0056 fixed variant
--    that never nulls an explicitly-set account_id).
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

COMMIT;
