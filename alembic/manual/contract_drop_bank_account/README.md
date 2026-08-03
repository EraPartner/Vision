# Contract phase — drop `bank_account` (ADR-088), OUT-OF-BAND

Status: **authored, NOT applied** (2026-06-19; code decouple completed + scripts dry-run
verified on a throwaway DB 2026-08-02). This is the irreversible "contract phase"
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
3. **`mv_bank_balances` is dropped** — it was a dead view (zero readers) removed for good by
   migration 0082; nothing here needs it switched to `account_id` any more.

## Apply / roll back

```bash
# Apply (after the preconditions). Wrapped in a transaction; aborts if the soak guard fails.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f alembic/manual/contract_drop_bank_account/up.sql

# Roll back (re-adds the column, re-derives from accounts.name, restores the trigger).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f alembic/manual/contract_drop_bank_account/down.sql
```

Rollback is lossless because `accounts.name` was backfilled from these same strings.

## Decouple checklist (the prerequisite code work — a dedicated, verified pass)

Paths are under `apps/node-backend/src/`. **Method:** reads of the column → derive the label
from `account_id` (`JOIN accounts a ON a.id = t.account_id`, use `a.name`); writes that set the
string → set `account_id` directly (the trigger that resolved string→id is dropped in step 3 of
`up.sql`).

> [!done] 2026-08-02 — the READ decouple is COMPLETE; the import pipeline AND the API UPDATE
> path dual-write the FK.
> Every read below (list/count/filters, free-text search, sort-by-bank, uncategorised, splits
> owed views, CSV/NDJSON export, recurring detection, transfer suggestions, import dedup probe)
> now binds to `account_id`/`accounts.name` and was verified to run against the DROPPED schema
> (up.sql applied to a throwaway DB, smoke passed, down.sql restored). Label resolution is
> `accountRepository.resolveOrCreateByName` — the trigger's own identity, lower(btrim), with the
> JS pre-trim in SQL-btrim semantics (U+0020 only, NOT `String#trim()`) so JS-side and
> trigger-side resolution can never fork one label into two accounts:
> - **Import commit** resolves each chunk's labels INSIDE the chunk transaction (minted accounts
>   roll back with a failed chunk, like trigger minting always did) and writes `account_id`
>   explicitly next to the string.
> - **UPDATE path** (`transactionRepository.update`,
>   `plannedTransactionRepository.update`/`updateWithLoanSchedule`, via
>   `stampAccountIdForUpdate`): a `bank_account` edit resolves-or-creates and stamps
>   `account_id` in the same SET. This was pulled FORWARD from the lockstep list because the
>   0062 trigger is lookup-only on UPDATE — without it a first-seen label left a ghost row
>   (string set, FK stale/NULL) that both reverted the edit on every read and flipped the
>   FK-keyed import dedup in both directions. Raw-SQL/DB-editor updates intentionally keep the
>   0062 lookup-only guard (phantom-account protection for non-API writes).
>
> What still touches the string — BY DESIGN until the drop, because the sync trigger derives
> `account_id` FROM `bank_account`, so pre-drop writers must keep providing it — i.e. the small
> code half that must ship IN LOCKSTEP with `up.sql`:
> - `repositories/transactionRepository.js` `create()` / `insertImportedRow()` and
>   `services/importPipeline/commit.js` `bulkInsertPlanned()` — drop the `bank_account` column
>   from the INSERTs (each already resolves/writes `account_id`; `create()` will need to resolve
>   like commit.js does once the trigger is gone).
> - `repositories/plannedTransactionRepository.js` `create()` — same.
> - `repositories/{transaction,plannedTransaction}Repository.js` `repointAccount()` and
>   `repositories/accountRepository.js` rename propagation — drop the `bank_account = $` halves.
> - `repositories/{transaction,plannedTransaction}Repository.js` `update()` — drop only the
>   string half of the SET (the `account_id` stamping already exists and stays);
>   `middleware/validation.js` whitelists + the `bank_account` body fields in
>   `routes/transactions.js` / `routes/plannedTransactions.js` keep ACCEPTING the field (wire
>   compat) — post-drop it is resolution input only, never a stored column.
> - Raw-mirror tables keep their own label columns untouched by this contract:
>   `import_staging_rows.bank_account` (stage/validate/importRoutes review UI) and
>   `manual_raw_transactions.bank_account` (deduplication.js hash + mirror).

### Leave alone — a DIFFERENT concept (recipient bank accounts, NOT the txn column)
`recipient_bank_accounts` table + `repositories/recipientBankAccountRepository.js`,
`services/recipientBankAccountService.js`, `routes/recipientBankAccounts.js`. These model a
recipient's IBANs and are unrelated to `transactions.bank_account`. Files that touch **both**
(treat per-line): `services/dataImportService.js`, `repositories/recipientRepository.js`,
`services/recipientMergeService.js`, `repositories/importBatchRepository.js`,
`repositories/accountRepository.js`, `backup/coverage.js`.

### 1. Materialized view — already done (migration 0082)
- `mv_bank_balances` was a dead view (zero readers) and has been dropped: removed from
  `services/materializedViewService.js`'s managed set and dropped by migration 0082. Nothing
  reads it, so there is no consumer to switch. The account-balance / bank-balances reads
  (`repositories/infoRepositoryBanks.js`, the `getBankBalances` aggregation) already run live SQL,
  not the MV. `up.sql` step 2 is now just a defensive `DROP … IF EXISTS`.

### 2. Reads — derive the label from `account_id` — DONE (2026-08-02)
`repositories/transactionRepository.js`, `repositories/plannedTransactionRepository.js`,
`repositories/infoRepositoryNetWorth.js`, `repositories/infoRepositoryStatistics.js`,
`repositories/splitRepository.js`,
`lib/filterBuilder.js` (moved from `services/`; the `bankAccount`/`bankAccounts` filters and the
free-text bank branch all resolve through `account_id` → `accounts.name`),
`services/transactionExport.js`, `services/bulkSelection.js`,
`services/calculations/transfers.js` (pure; consumes rows, no SQL),
`services/transferReconciliationService.js`, `services/recurringDetectionService.js`,
`services/aiChat/tools/insights.js`, `routes/transactions.js`, `routes/plannedTransactions.js`,
`routes/splits.js`. (`services/deduplication.js` reads/writes only the
`manual_raw_transactions` raw mirror, which keeps its column; `middleware/validation.js` is a
write-path whitelist — see the lockstep list above.)

### 3. Writes — set `account_id` instead of the string — import DONE (dual-write); rest ships with the drop
`services/importPipeline/stage.js`, `services/importPipeline/validate.js`,
`services/importPipeline/commit.js`, `services/importPipeline/adapters/generic.js`,
`services/accountMergeService.js`, `services/dataImportService.js` (txn-column half only).
The CSV adapters still *parse* a bank-account field from the file — keep the parse, but resolve it
to `account_id` at write time (the same name→account mapping the trigger does today) rather than
storing the string.

### 4. After code is decoupled
- Ship the lockstep write-side change (see the 2026-08-02 note above) with the drop.
- Run the full backend suite + a manual import/dedup/net-worth smoke.
- Confirm the soak query returns 0 in the target DB.
- Apply `up.sql`. Keep `down.sql` ready until you've confirmed a healthy boot.

## Dry-run record (2026-08-02, throwaway DB)
`up.sql` applied cleanly to a head-migrated (0086) scratch database seeded through the
dual-write path (soak gate passed with data present); all flipped readers ran green against the
dropped schema; `down.sql` re-derived every string from `accounts.name` byte-identically and the
restored trigger onboarded/resolved/detached exactly like head. `down.sql`'s trigger body was
updated in the same pass: it used to restore the 0056 variant, whose `ON CONFLICT (name)`
arbiter matches no unique index since 0066 → 42P10 on every first-seen label (the 0076→0083
regression); it now restores the HEAD (0083) function verbatim.

## Blast radius
Irreversible drop of two nullable columns + their indexes + the dual-write trigger
(`mv_bank_balances` is already gone since migration 0082 — step 2 is a defensive no-op).
Recovery = `down.sql` (re-derives losslessly from `accounts.name`). Not a chain migration — never
auto-applied.
