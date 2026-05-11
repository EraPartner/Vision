# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] Add more transaction adapters (BNP, etc.) — deferred until sample CSVs are provided 🔽

## Completed in chore/todo-sweep-2026-05-11

- [x] Investigate the pre-existing "shows Attachments section" flake in `TransactionInfoDialog.test.tsx` — added `waitFor` on Loading spinner + raised `findByText` timeout; verified 10/10 green ✅
- [x] Migrate `user_settings.created_at` and `updated_at` from `TIMESTAMP` to `TIMESTAMPTZ` — migration `0032_user_settings_timestamptz.py` (idempotent for legacy DBs missing `created_at`) ✅
- [x] Split `apps/frontend/src/components/tax/TaxProfileDialog.tsx` (~669 LOC) into per-step files — `components/tax/profile-steps/` ✅
- [x] Bump backend pool `idleTimeoutMillis` to 60s — `database/connection.js:25` ✅
- [x] Refactor `apps/node-backend/src/services/aiChat/tools/expenses.js:318-346` 4-deep nested Map loops into `aggregateByMonthCategory(rows)` helper ✅
- [x] Move SQL out of `apps/node-backend/src/routes/importRoutes.js` into `importBatchRepository` — `getPreviewRows`, `overrideRecipient`, `overrideCategory`, `categoryExists` ✅
- [x] Extract `warmupStartupTasks()` from `apps/node-backend/src/main.js:530-663` — new `apps/node-backend/src/startup/warmup.js` ✅
- [x] Add rate-limiter dev bypass + `db:index-stats` helper script for measuring index usage ✅
- [x] Add `db:precision-drift` detector script for raw-bank arithmetic on transactions joins — ran clean, no drift sites ✅
- [x] Drop unused `idx_transactions_date` (0 scans confirmed via `pg_stat_user_indexes`) — migration `0033_drop_unused_transactions_date_index.py` ✅
- [x] Dedup `ix_transactions_*` legacy SQLAlchemy indexes vs `idx_transactions_*` Alembic equivalents — migration `0034_drop_legacy_transactions_ix_duplicates.py` dropped 5 identical duplicates; `ix_transactions_date` retained (sole remaining single-column date index, 529 scans, no `idx_*` pair) ✅
