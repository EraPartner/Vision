---
title: "Session: FX attribution + backup-path fix"
type: session
date: 2026-06-11
tags: [session, portfolio, fx, currency, backup, electron]
description: Cleared TODO.md — FX-induced portfolio value changes (full attribution feature, ADR-074) and the backup path reverting to default
---

# Session 2026-06-11 — FX attribution + backup-path fix

Cleared both TODO.md items.

## 1. Backup path kept reverting to default (⏫)

Two stacked bugs:

- **Clobber on save:** `DashboardSettingsDialog` held `backupDir`/`backupOnQuit`
  state initialized to `''`/`false`, but only `BackupTab` (mounted on tab
  click — Radix unmounts inactive tabs) loaded the stored values. Saving from
  any other tab wrote the defaults over the real config (DB + settings.json).
- **Dead DB-read branch:** Electron's `backup:load-settings` and the will-quit
  handler read `data.value` from an API that responds
  `{ ok, data: { key, value } }` (ADR-026) — the DB branch never executed.

Fix: dialog loads backup settings on open with a trusted-flag guard (save
skipped unless values were loaded or user-touched); handlers unwrap the
envelope; the settings.json mirror now stores raw (not default-resolved)
values. Regression tests added in `DashboardSettingsDialog.test.tsx`.

## 2. FX-induced portfolio value changes (🔺) — [[074-fx-attribution-historical-rates|ADR-074]]

User interview decided: current-rate valuation **with attribution**, headline
gain **includes** FX with the split shown, all four UI surfaces, full automatic
ECB-history backfill.

- **Shared math** (`@vision/shared-utils/portfolio`): converted track through
  weighted-avg/FIFO/LIFO (per-txn `fxMultiplier`), `converted` block in
  `buildInvestmentSummaryCore` — invested locked at purchase-date rates,
  `gainLoss = assetGain + fxGain` by construction.
- **Live summary**: per-txn historical rates (stamped `fx_rate_to_eur` →
  stored history → today's rate + `usedFallbackRate` flag); new fields per
  investment and in totals.
- **Rates**: ECB full-history tier (1999+, on-or-before convention); startup
  backfill repairs previously fabricated rates (one-time flag
  `fx_full_history_repair_done`), never persists nearest-rate guesses, and
  bulk-stamps `fx_rate_to_eur` (≤7-day lookback, handles the legacy `_base`
  inheritance layout). Write paths auto-stamp from stored rates (DB-only).
- **Snapshots**: `value_fx_neutral` column (migration **0039**, user-applied;
  writer/readers degrade gracefully), cost-weighted purchase-rate valuation in
  the day-walk, sanitizer covers the new series.
- **Frontend**: overview gain card subline + breakdown rows; performance page
  FX-neutral chart toggle + attribution line; FX P/L column on Stocks/Metals
  and Crypto tables; FX Attribution card in the investment detail dialog;
  i18n en/nl validated.

## Verification

Backend 2091 tests green; frontend typecheck/lint clean, suite green except 5
**pre-existing** failures (verified identical with HEAD's shared file:
`portfolioCalculations.property.test.ts` float-extremes flakiness,
`usePortfolioSummaries.test.ts` missing QueryClientProvider); prod build OK;
locales validated; Electron main.js syntax-checked.

## Open items

- User must apply migration 0039 (`bun run db:upgrade`); rollback documented.
- Follow-ups logged in TODO.md: pre-existing test failures, non-ECB deep
  history, foreign-ccy fixed-income snapshot FX.
