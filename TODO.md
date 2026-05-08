# TODO

Legend: **P1** blocker/foundation · **P2** high-value · **P3** nice-to-have

---

## Bugs

_None tracked._

### Missing translations

_None tracked._

---

## Features

- Add more adapters (BNP, etc.) **P3**

---

## Follow-ups from 2026-05-08 bug-hunt sweep (`fix/bug-hunt-2026-05-08`)

- Measure `transactions` index bloat with `pg_stat_user_indexes` and drop unused composites (e.g. single-column `idx_transactions_date` is likely covered by composites). **P3**
- Migrate `user_settings.created_at` / `updated_at` from `TIMESTAMP` → `TIMESTAMPTZ` next migration cycle to match the rest of the schema. **P3**
- Split `apps/frontend/src/components/tax/TaxProfileDialog.tsx` (~669 LOC) into per-step files when next touched. **P3**
- Backfill raw bank tables from `NUMERIC(15,2)` → `NUMERIC(18,4)` if join queries against `transactions` ever surface precision drift. **P3**
- Bump backend pool `idleTimeoutMillis` to 60–90s if connection-churn metrics show issue. **P3**
- Refactor `apps/node-backend/src/services/aiChat/tools/expenses.js:318-346` 4-deep nested Map loops into an `aggregateByMonthCategory(rows)` helper. **P3**
- Move SQL out of `apps/node-backend/src/routes/importRoutes.js` into `importBatchRepository`. **P3**
- Extract `warmupStartupTasks()` from `apps/node-backend/src/main.js:530-663`. **P3**
- Investigate pre-existing "shows Attachments section" flake in `TransactionInfoDialog.test.tsx`. **P2**

