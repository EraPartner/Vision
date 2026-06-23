# Contract phase — drop `bank_account` (ADR-088), OUT-OF-BAND

Status: **authored, NOT applied** (2026-06-19). This is the irreversible "contract phase"
that removes `transactions.bank_account` / `planned_transactions.bank_account`, now that
`account_id` (migrations 0051 dual-write trigger + backfill) is the canonical link.

## Why this lives here and not in `alembic/versions/`

The app runs `alembic upgrade head` **on boot**. A chain migration that drops the column
would auto-apply on the next start — without the coupled code — and crash startup. That
already happened: `0055_drop_bank_account_string` was neutralized to a no-op and
`0056_restore_bank_account_after_premature_drop` is its recovery. So the drop is delivered
here as a **manually-run script**, applied in lockstep with the decoupled code.

## Do NOT run until all three hold

1. **Dual-write soak is clean** (the `up.sql` guard also enforces this, aborting if not):
   ```sql
   SELECT count(*) FROM transactions        WHERE bank_account IS NOT NULL AND account_id IS NULL;  -- must be 0
   SELECT count(*) FROM planned_transactions WHERE bank_account IS NOT NULL AND account_id IS NULL;  -- must be 0
   ```
2. **All read/write code is off the string** (see checklist below) and deployed.
3. **`mv_bank_balances` + its consumers are switched to `account_id`** (code, not just the MV).

## Apply / roll back

```bash
# Apply (after the preconditions). Wrapped in a transaction; aborts if the soak guard fails.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f alembic/manual/contract_drop_bank_account/up.sql

# Roll back (re-adds the column, re-derives from accounts.name, restores the trigger + MV).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f alembic/manual/contract_drop_bank_account/down.sql
```

Rollback is lossless because `accounts.name` was backfilled from these same strings.

## Decouple checklist (the prerequisite code work — a dedicated, verified pass)

Paths are under `apps/node-backend/src/`. **Method:** reads of the column → derive the label
from `account_id` (`JOIN accounts a ON a.id = t.account_id`, use `a.name`); writes that set the
string → set `account_id` directly (the trigger that resolved string→id is dropped in step 3 of
`up.sql`).

### Leave alone — a DIFFERENT concept (recipient bank accounts, NOT the txn column)
`recipient_bank_accounts` table + `repositories/recipientBankAccountRepository.js`,
`services/recipientBankAccountService.js`, `routes/recipientBankAccounts.js`. These model a
recipient's IBANs and are unrelated to `transactions.bank_account`. Files that touch **both**
(treat per-line): `services/dataImportService.js`, `repositories/recipientRepository.js`,
`services/recipientMergeService.js`, `repositories/importBatchRepository.js`,
`repositories/accountRepository.js`, `backup/coverage.js`.

### 1. Materialized view (do first — coupled to `up.sql` step 2)
- `services/materializedViewService.js` — change the `mv_bank_balances` definition to the
  `account_id`-grouped form in `up.sql` (label `a.name AS bank_account` kept for read compat).
- Consumers: `services/reports/sections/bankBalances.js`, `repositories/infoRepositoryBanks.js`
  (and the `getBankBalances` aggregation) — verify they read `bank_account`/`account_id` from the
  new MV shape.

### 2. Reads — derive the label from `account_id`
`repositories/transactionRepository.js`, `repositories/plannedTransactionRepository.js`,
`repositories/infoRepositoryNetWorth.js`, `repositories/infoRepositoryStatistics.js`,
`repositories/splitRepository.js`, `repositories/rawTransactionRepository.js`,
`services/filterBuilder.js` (the `bankAccount`/`bankAccounts` filter → filter by `account_id`,
or resolve names→ids), `services/transactionExport.js`, `services/bulkSelection.js`,
`services/calculations/transfers.js`, `services/transferReconciliationService.js`,
`services/deduplication.js`, `services/recurringDetectionService.js`,
`services/aiChat/tools/insights.js`, `routes/transactions.js`, `routes/plannedTransactions.js`,
`routes/splits.js`, `middleware/validation.js`.

### 3. Writes — set `account_id` instead of the string
`services/importPipeline/stage.js`, `services/importPipeline/validate.js`,
`services/importPipeline/commit.js`, `services/importPipeline/adapters/generic.js`,
`services/accountMergeService.js`, `services/dataImportService.js` (txn-column half only).
The CSV adapters still *parse* a bank-account field from the file — keep the parse, but resolve it
to `account_id` at write time (the same name→account mapping the trigger does today) rather than
storing the string.

### 4. After code is decoupled
- Run the full backend suite + a manual import/dedup/net-worth smoke.
- Confirm the soak query returns 0 in the target DB.
- Apply `up.sql`. Keep `down.sql` ready until you've confirmed a healthy boot + the MV refresh.

## Blast radius
Irreversible drop of two nullable columns + their indexes + the dual-write trigger; MV redefined.
Recovery = `down.sql` (re-derives losslessly from `accounts.name`). Not a chain migration — never
auto-applied.
