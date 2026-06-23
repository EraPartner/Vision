-- ADR-088 CONTRACT PHASE — drop transactions/planned_transactions.bank_account.
--
-- OUT-OF-BAND. Apply MANUALLY, in lockstep with the decoupled application code
-- (see README.md). This is deliberately NOT a file in alembic/versions/: the app
-- runs `alembic upgrade head` on boot, so a chain migration would auto-apply this
-- irreversible drop WITHOUT the coupled code and crash startup — that already
-- happened once (see alembic/versions/0055 [neutralized] + 0056 [recovery]).
--
-- Run only AFTER:
--   1. the dual-write soak holds (the guard below also enforces it), AND
--   2. all read/write code is off the string (see README "Decouple checklist"), AND
--   3. mv_bank_balances + its consumers are switched to account_id.
--
-- Wrapped in a single transaction: if the soak guard raises, nothing is dropped.

BEGIN;

-- 1. Soak gate — refuse to proceed unless every active row is backfilled.
DO $$
DECLARE unbacked bigint;
BEGIN
  SELECT count(*) INTO unbacked
    FROM transactions WHERE bank_account IS NOT NULL AND account_id IS NULL;
  IF unbacked <> 0 THEN
    RAISE EXCEPTION 'Soak not met: % transactions have bank_account but no account_id', unbacked;
  END IF;

  SELECT count(*) INTO unbacked
    FROM planned_transactions WHERE bank_account IS NOT NULL AND account_id IS NULL;
  IF unbacked <> 0 THEN
    RAISE EXCEPTION 'Soak not met: % planned_transactions have bank_account but no account_id', unbacked;
  END IF;
END $$;

-- 2. Redefine mv_bank_balances on account_id; keep a `bank_account` output column
--    (derived from accounts.name) so read-side consumers stay source-compatible.
--    NOTE: services/materializedViewService.js must be updated to this same
--    definition so the next boot recreates it correctly (it CREATEs IF NOT EXISTS).
DROP MATERIALIZED VIEW IF EXISTS mv_bank_balances;
CREATE MATERIALIZED VIEW mv_bank_balances AS
  SELECT t.account_id,
         a.name AS bank_account,
         t.currency,
         COUNT(*)       AS transaction_count,
         MIN(t.date)    AS first_transaction,
         MAX(t.date)    AS last_transaction,
         SUM(t.amount)  AS balance
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
   WHERE t.is_active = true AND t.account_id IS NOT NULL
   GROUP BY t.account_id, a.name, t.currency
   ORDER BY a.name;
CREATE UNIQUE INDEX mv_bank_balances_idx ON mv_bank_balances (account_id, currency);

-- 3. Drop the ADR-088 dual-write trigger + function (migration 0051) — the string
--    is gone, so there is nothing left to sync from.
DROP TRIGGER IF EXISTS trg_transactions_account_sync ON transactions;
DROP TRIGGER IF EXISTS trg_planned_transactions_account_sync ON planned_transactions;
DROP FUNCTION IF EXISTS sync_account_id_from_bank_account();

-- 4. Drop the string column + its indexes (irreversible — recover via down.sql).
DROP INDEX IF EXISTS idx_transactions_bank_account;
DROP INDEX IF EXISTS idx_transactions_bank_date;
DROP INDEX IF EXISTS idx_transactions_bank_date_active;
ALTER TABLE transactions        DROP COLUMN IF EXISTS bank_account;
ALTER TABLE planned_transactions DROP COLUMN IF EXISTS bank_account;

COMMIT;
