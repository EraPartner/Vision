\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after a restore-tested logical backup.'
  \quit 3
\endif

BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);
LOCK TABLE accounts, account_statement_balances IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE
  balance_exists boolean;
  date_exists boolean;
  mismatch_count bigint;
BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'accounts'
       AND column_name = 'statement_balance'
  ) INTO balance_exists;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'accounts'
       AND column_name = 'statement_balance_date'
  ) INTO date_exists;
  IF balance_exists <> date_exists THEN
    RAISE EXCEPTION 'Refusing: only one account statement scalar column exists';
  END IF;
  IF NOT balance_exists THEN
    RAISE NOTICE 'Statement scalar contract already applied; no columns to drop';
    RETURN;
  END IF;
  EXECUTE $parity$
    SELECT count(*)
      FROM accounts AS a
      LEFT JOIN account_statement_balances AS sb
        ON sb.account_id = a.id AND sb.currency = a.currency
     WHERE (a.statement_balance IS NULL) <> (a.statement_balance_date IS NULL)
        OR (a.statement_balance IS NOT NULL AND (
             sb.account_id IS NULL
          OR sb.balance IS DISTINCT FROM a.statement_balance
          OR sb.balance_date IS DISTINCT FROM a.statement_balance_date
        ))
  $parity$ INTO mismatch_count;
  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Refusing: % declared-currency scalar projections do not match the collection', mismatch_count;
  END IF;
END $$;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS chk_accounts_statement_balance_has_date;
ALTER TABLE accounts
  DROP COLUMN IF EXISTS statement_balance,
  DROP COLUMN IF EXISTS statement_balance_date;
COMMIT;
