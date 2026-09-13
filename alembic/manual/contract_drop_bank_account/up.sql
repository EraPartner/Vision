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
--   3. mv_bank_balances is gone (dropped as a dead view — migration 0082).
--
-- Wrapped in a single transaction: if the soak guard raises, nothing is dropped.

\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after a restore-tested logical backup.'
  \quit 3
\endif

BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);

-- Block every concurrent writer before checking parity. Keep these locks until
-- COMMIT so no row can diverge between the guard and the column drop.
LOCK TABLE transactions, planned_transactions IN ACCESS EXCLUSIVE MODE;

-- 1. Soak gate — refuse to proceed unless every row has a valid canonical
-- identity. A NULL compatibility label is expected from canonical-only writers;
-- when an older writer supplied a label, it must still agree with the account.
DO $$
DECLARE unbacked bigint;
BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  SELECT count(*) INTO unbacked
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id IS NULL
       OR a.id IS NULL
       OR (t.bank_account IS NOT NULL
           AND lower(btrim(t.bank_account)) <> lower(btrim(a.name)));
  IF unbacked <> 0 THEN
    RAISE EXCEPTION 'Soak not met: % transactions have divergent bank_account/account_id identity', unbacked;
  END IF;

  SELECT count(*) INTO unbacked
    FROM planned_transactions p
    LEFT JOIN accounts a ON a.id = p.account_id
    WHERE p.account_id IS NULL
       OR a.id IS NULL
       OR (p.bank_account IS NOT NULL
           AND lower(btrim(p.bank_account)) <> lower(btrim(a.name)));
  IF unbacked <> 0 THEN
    RAISE EXCEPTION 'Soak not met: % planned_transactions have divergent bank_account/account_id identity', unbacked;
  END IF;
END $$;

-- 2. Drop mv_bank_balances if it still exists. It was a dead view (zero readers;
--    ADR-094-wrong Σ(amount) semantics) removed from the managed set and dropped
--    by migration 0082, so on a HEAD-migrated DB this is already a no-op — kept
--    here only to cover a DB that predates 0082 and to keep the string retirement
--    self-contained. (Nothing to recreate; the account-balance reads run live SQL.)
DROP MATERIALIZED VIEW IF EXISTS mv_bank_balances;

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
