# Contract phase — drop `bank_account` (ADR-088), OUT-OF-BAND

Status: **applied to the maintained live `vision` database on 2026-09-08**. Fresh databases
migrated only through the automatic Alembic chain still retain the compatibility columns until
this approved out-of-band operation is run. This is the irreversible "contract phase" that
removes `transactions.bank_account` / `planned_transactions.bank_account`, now that `account_id`
(migrations 0051 dual-write trigger + backfill) is the canonical link.

## Why this lives here and not in `alembic/versions/`

Vision's guarded migration runner applies the Alembic chain to `head` **on boot**. A chain
migration that drops the column would auto-apply on the next start — without the coupled code —
and crash startup. That already happened: `0055_drop_bank_account_string` was neutralized to a no-op and
`0056_restore_bank_account_after_premature_drop` is its recovery. So the drop is delivered
here as a **manually-run script**, applied in lockstep with the decoupled code.

## Do NOT run until all three hold

1. **Dual-write soak is clean** (the `up.sql` guard also enforces this, aborting if not):
   ```sql
   -- Both queries must return 0.
   SELECT count(*) FROM transactions t
   LEFT JOIN accounts a ON a.id = t.account_id
    WHERE (t.bank_account IS NULL) <> (t.account_id IS NULL)
       OR (t.bank_account IS NOT NULL AND t.account_id IS NOT NULL
           AND (a.id IS NULL
                OR lower(btrim(t.bank_account)) <> lower(btrim(a.name))));
   SELECT count(*) FROM planned_transactions p
   LEFT JOIN accounts a ON a.id = p.account_id
    WHERE (p.bank_account IS NULL) <> (p.account_id IS NULL)
       OR (p.bank_account IS NOT NULL AND p.account_id IS NOT NULL
           AND (a.id IS NULL
                OR lower(btrim(p.bank_account)) <> lower(btrim(a.name))));
   ```
2. **The contract-phase application build is ready** (see checklist below). Do not activate that
   build separately; switch the code and schema while every writer remains stopped.
3. **`mv_bank_balances` is dropped** — it was a dead view (zero readers) removed for good by
   migration 0082; nothing here needs it switched to `account_id` any more.

## Apply / roll back

This out-of-band contract operation is unrelated to the native runtime migration. Do not combine
it with another cutover. Prepare the contract-phase application artifact first. In the approved
window, stop every application writer, create and verify a fresh encrypted backup, re-run parity,
apply `up.sql`, activate the coupled application build, then boot and run the smoke checks. The
`ACCESS EXCLUSIVE` locks in `up.sql` keep the parity guard race-free until the drop commits.

```bash
# Apply (after the preconditions). Wrapped in a transaction; aborts if the soak guard fails.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f alembic/manual/contract_drop_bank_account/up.sql

# Roll back (re-adds the column, re-derives from accounts.name, restores the trigger).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f alembic/manual/contract_drop_bank_account/down.sql
```

Rollback is lossless because `accounts.name` was backfilled from these same strings. If rollback
is needed, keep writers stopped, run `down.sql`, restore the legacy dual-write application build,
and only then restart Vision.

## Decouple checklist (the prerequisite code work — a dedicated, verified pass)

Paths are under `apps/node-backend/src/`. **Method:** reads of the column → derive the label
from `account_id` (`JOIN accounts a ON a.id = t.account_id`, use `a.name`); writes that set the
string → set `account_id` directly (the trigger that resolved string→id is dropped in step 3 of
`up.sql`).

> [!done] 2026-09-08 — the read and write decouple is complete in the contract-phase build.
> Every read below (list/count/filters, free-text search, sort-by-bank, uncategorised, splits
> owed views, CSV/NDJSON export, recurring detection, transfer suggestions, import dedup probe)
> now binds to `account_id`/`accounts.name` and was verified to run against the DROPPED schema
> (up.sql applied to a throwaway DB, smoke passed, down.sql restored). Label resolution is
> `accountRepository.resolveOrCreateByName` — the trigger's own identity, lower(btrim), with the
> JS pre-trim in SQL-btrim semantics (U+0020 only, NOT `String#trim()`) so JS-side and
> trigger-side resolution can never fork one label into two accounts:
>
> - **Import commit** resolves each chunk's labels inside the chunk transaction and writes only
>   `account_id` to canonical transactions. Staging keeps its review label.
> - **UPDATE path** (`transactionRepository.update`,
>   `plannedTransactionRepository.update`/`updateWithLoanSchedule`, via
>   `stampAccountIdForUpdate`): a `bank_account` API edit resolves-or-creates the account,
>   stamps `account_id`, and removes the compatibility field before SQL is built.
>
> The compatibility name remains intentionally visible at the API boundary: request bodies may
> still send `bank_account`, and responses project that field from `accounts.name`. It is no
> longer a canonical-table column. Raw-mirror tables keep their own label columns:
> `import_staging_rows.bank_account` (stage/validate/importRoutes review UI) and
> `manual_raw_transactions.bank_account` (deduplication.js hash + mirror).

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

### 3. Writes — set `account_id` instead of the string — DONE (2026-09-08)

`services/importPipeline/stage.js`, `services/importPipeline/validate.js`,
`services/importPipeline/commit.js`, `services/importPipeline/adapters/generic.js`,
`services/accountMergeService.js`, `services/dataImportService.js` (txn-column half only).
The CSV adapters still _parse_ a bank-account field from the file — keep the parse, but resolve it
to `account_id` at write time (the same name→account mapping the trigger does today) rather than
storing the string.

### 4. Maintenance-window handoff

- Prepare the contract-phase application artifact without activating it.
- Stop Vision and confirm no backend writer remains.
- Create and verify a fresh encrypted backup.
- Confirm the parity guard returns zero in the exact target database.
- Apply `up.sql`, activate the contract-phase build, and start Vision.
- Run create/edit/import/account-rename/account-merge/net-worth smoke checks.
- Keep `down.sql` and the legacy build ready until the healthy boot is confirmed.

## Dry-run record (2026-08-02, throwaway DB)

`up.sql` applied cleanly to a head-migrated (0086) scratch database seeded through the
dual-write path (soak gate passed with data present); all flipped readers ran green against the
dropped schema; `down.sql` re-derived every string from `accounts.name` byte-identically and the
restored trigger onboarded/resolved/detached exactly like head. `down.sql`'s trigger body was
updated in the same pass: it used to restore the 0056 variant, whose `ON CONFLICT (name)`
arbiter matches no unique index since 0066 → 42P10 on every first-seen label (the 0076→0083
regression); it now restores the HEAD (0083) function verbatim.

## Contract lifecycle record (2026-09-08, disposable PostgreSQL 18)

`VISION_TEST_DB_TASK=adr088-contract scripts/with-test-db.sh` applied `up.sql` to a fresh
head schema, ran real create, edit, import, account rename, account repoint, and blank-detach paths
with both legacy columns absent, then ran `down.sql`. The rollback restored both columns, all
three indexes, both triggers, and zero label/FK mismatches.

## Live maintenance record (2026-09-08)

The maintained `vision` database was at revision `0102_retire_adr090_transaction_schema`. A fresh
encrypted `VISIONBAK2` backup was verified, all application writers were stopped, and the parity
guard returned zero mismatches across 5,399 transactions and 11 planned transactions.

The first activation exposed one remaining fallback query in manual-transaction deduplication
that still referenced `transactions.bank_account`. The smoke stopped immediately, removed its
temporary records, restored the compatibility schema with `down.sql`, and restarted a
migration-compatible application build. The query was changed to join `accounts` through
`account_id`, and the dropped-schema test now exercises that fallback.

After a full rebuild and isolated native smoke, the maintenance operation was retried. Health,
transaction create/edit, planned-transaction create/edit, account rename, account merge, custom
CSV import, and net-worth reads passed. All synthetic smoke records and batch receipts were
removed. The final live schema has zero legacy columns, zero legacy triggers, and zero legacy
indexes. The verified encrypted backup, `down.sql`, and a revision-0102-compatible application
bundle remain the rollback path.

## Blast radius

Irreversible drop of two nullable columns + their indexes + the dual-write trigger
(`mv_bank_balances` is already gone since migration 0082 — step 2 is a defensive no-op).
Recovery = `down.sql` (re-derives losslessly from `accounts.name`). Not a chain migration — never
auto-applied.
