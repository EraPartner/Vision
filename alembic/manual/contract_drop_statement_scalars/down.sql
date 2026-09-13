BEGIN;
ALTER TABLE accounts
  ADD COLUMN statement_balance NUMERIC(18,4),
  ADD COLUMN statement_balance_date DATE;
UPDATE accounts AS a
   SET statement_balance = sb.balance,
       statement_balance_date = sb.balance_date
  FROM account_statement_balances AS sb
 WHERE sb.account_id = a.id AND sb.currency = a.currency;
ALTER TABLE accounts ADD CONSTRAINT chk_accounts_statement_balance_has_date
  CHECK (statement_balance IS NULL OR statement_balance_date IS NOT NULL);
COMMIT;
