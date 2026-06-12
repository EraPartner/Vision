# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] Apply Alembic migration 0039 (`bun run db:upgrade`) — adds `value_fx_neutral` to portfolio snapshots; until applied the FX-neutral chart series stays hidden (everything else works). Rollback: `bun run db:downgrade` ⏫
- [ ] Pre-existing frontend test failures (verified present on HEAD before the 2026-06-11 FX work): `portfolioCalculations.property.test.ts` — fast-check finds counterexamples with extreme float inputs (cents-rounded `totalCost` vs unrounded `avgCostBasis` invariant); `usePortfolioSummaries.test.ts` — 3 tests crash with "No QueryClient set" because `useExchangeRates` now uses react-query but the test harness lacks a QueryClientProvider 🔼
- [ ] FX follow-up: non-ECB currencies (AED, SAR, …) have no deep historical-rate source — old conversions fall back to nearest stored rate and are flagged via `usedFallbackRate`; consider a paid/alternative historical provider if these currencies ever matter 🔽
- [ ] FX follow-up: fixed-income snapshot values accumulate at txn-date rates (pre-existing ADR-061 behaviour), so a foreign-currency savings account's snapshot ignores day-to-day FX on the principal — revisit if foreign-ccy fixed income becomes a real use case 🔽
