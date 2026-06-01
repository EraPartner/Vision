# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] 🔽 Visually spot-check `apps/frontend/src/components/ui/calendar.tsx` in the running app after its react-day-picker v10 migration ([[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]]). The code migration is **done** — v10 `classNames` keys, the `Chevron` component, and the removed temporary cast (typecheck + frontend tests green) — but the theme (selected/today/range styling, nav button positioning) has not been confirmed visually. Open any date picker (e.g. Add Transaction → date) at 320/768/1440 in both themes. 🛫 2026-05-29

## Codebase audit — May 2026 (open backlog)

> The **2026-06-01 remediation pass shipped the rest of the open backlog** (global rate limiting, XFF-trust hardening, zip-bomb guard, provider response caps, dev-mode fail-safe, money rounding unification, portfolio Decimal math, snapshot timezone + split/return_of_capital, PlannedPayments virtualization + toasts, i18n plurals, route→service layer + lint enforcement, features/imports consolidation, `@vision/shared-utils` package, dead-code/stale-config cleanup, and the recipient-MV decision). Only the items below remain open.

### Performance (perf-DB) — implemented, PENDING on-stack validation

> Both rewrites below are **code-complete with unit tests for the JS combine math**, but their SQL correctness **cannot be proven by the Vitest suite** (tests mock `query()`), so they are **not yet verified**. Validate against a running multi-currency, multi-year Postgres before trusting the numbers:
>
> 1. `bun run docker:dev` (or `docker compose up`) + `bun run db:upgrade`.
> 2. Seed a multi-currency (USD + EUR), multi-year dataset with historical `exchange_rates`.
> 3. Diff the endpoint output **before vs after** these commits — numbers must match exactly (read-only perf rewrites).
> 4. Confirm the perf win with `EXPLAIN ANALYZE` (rows scanned / time).

- [ ] ⏫ **`/transaction-summary` grouped scan** — `getTransactionSummary` (`infoRepositoryStatistics.js`) now pushes `COUNT/SUM/MIN/MAX … GROUP BY currency` into SQL and combines per-currency aggregates in JS (count = Σ; total = Σ sum_c×rate_c; min/max = min/max of (extremum_c×rate_c); valid because the default conversion is one latest rate per currency and rate_c > 0 is monotonic). Unit test asserts the combine math. **Validate end-to-end equality vs the old output on real data.** 🛫 2026-06-01
- [ ] ⏫ **Report monthly summary pushdown (all-time path)** — `infoRepo.monthly.js` live path now aggregates per `(date, currency)` in SQL (`COUNT`, `SUM … FILTER` sign-split) and converts each day's income/spending at that date's historical rate, bucketing into months in JS. NB: this deliberately groups by **date** (not month) because the path uses per-transaction-date FX — a month-level GROUP BY would change results. Numerically identical to the old per-transaction loop by construction; unit test covers the bucketing. **Validate report output equality vs the old path on real data.** 🛫 2026-06-01
