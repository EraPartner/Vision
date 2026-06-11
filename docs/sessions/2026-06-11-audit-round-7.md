---
title: Audit Round 7 — Full-Codebase Sweep
type: session
date: 2026-06-11
tags: [audit, correctness, timezone, portfolio, belgian-tax, architecture]
description: Single-agent deep audit after the June backlog was cleared — 19 verified findings written to TODO.md (R7-1…R7-19). Headliners — dead FIFO/LIFO setting, UTC day-shift class in reports/planned-tx, two live FE/BE portfolio-summary drifts.
---

# Audit Round 7 — Full-Codebase Sweep (2026-06-11)

> [!info] Method
> Inline (single-agent) audit on `main` @ `5ac3656c`, immediately after the June 2026 backlog clear. Read the high-risk money/tax/date modules in full ([[docs/reference/code-patterns|patterns]]: `portfolioMath.js`, `pit.ts`, `currencyConversionService.js`, `snapshotBuilder.js`, `loanSchedule.js`, `main.js`, summary hooks); pattern-swept the rest (`toISOString` day-shift class, N+1 loops, transaction coverage, validation gaps). Every finding was verified against code before being written down; one suspected finding (marital-quotient cap semantics) was disproven during verification and reported as clean instead.

## Outcome

**19 findings → [[TODO]] under "Audit Round 7", IDs R7-1 … R7-19 — ALL FIXED the same day (uncommitted).** Key artifacts: [[docs/adr/073-shared-portfolio-math-package|ADR-073]] (shared portfolio math, closes R7-5/6/7/16), `todayAppDateString`/`addDaysYmd`/`firstOfMonthYmd` in `lib/timezone.js` (R7-1/2/4/17), `parseDateFlexibleUtc` in import adapters (R7-3), single bridge-guarded spike sanitizer (R7-8), Belgian-tax union/medical correction + property-tax breakdown row (R7-10/11/12), `assertYmd` route validation (R7-13), health-probe cache (R7-14), single-statement quote cleanup (R7-15), lint to 0 warnings (R7-19). Verified: backend 128 files / 2086 tests green, frontend suite + typecheck + production build green, `validate-locales` clean. Baseline before audit: backend tests 128 files / 2083 green, ESLint 0 errors / 12 warnings, `validate-locales` clean.

| Priority | Count | Headliners |
|---|---|---|
| 🔺 highest | 2 | R7-1 report period day-shift (UTC+), R7-5 FIFO/LIFO setting is a dead toggle |
| ⏫ high | 3 | R7-2 UTC-"today" ×5 call sites, R7-6 `.abs()` vs clamp FE/BE drift, R7-7 FE summary sums mixed currencies |
| 🔼 medium | 5 | adapter date fallbacks, divergent spike-sanitizers, Belgian union/medical deduction, unvalidated date filters, FE/BE duplication ADR |
| 🔽/⏬ low | 9 | health-endpoint throttle, per-investment DELETEs, log mislabel, lint hygiene, … |

## Recurring themes (third audit in a row)

1. **Local-vs-UTC date serialization** — the `new Date(local)` + `toISOString()` combination keeps reappearing in *new* code (report fetchers, route helpers) even after the June per-site pg-DATE fixes. R7-2/R7-17 propose one shared `todayAppDateString()` in `lib/timezone.js` as the structural fix.
2. **FE re-implements BE money math and drifts** — R7-6 and R7-7 are live drift instances; R7-16 proposes moving the pure portfolio calculators into `@vision/shared-utils` (same move already done for [[docs/architecture/index|money helpers]]) and recording it as an ADR.

## Checked clean

Express 5 async error funnel, CORS/CSP, gzip backpressure, graceful shutdown, `withTransaction` coverage, marital quotient (art. 87 cap on the quote-part — verified correct), loan amortization, Holt-Winters recursion, FIFO/LIFO lot math (correct, just unwired), CSSS tables, multer limits, compose-file parity, version sync. Full clean-list at the bottom of [[TODO]].

## Follow-ups

- Fix order suggestion: R7-5 (functionality) → R7-1/R7-2 (date class, one shared helper) → R7-6/R7-7 (parity) → rest.
- R7-16 needs an ADR when implemented (supersedes the implicit "mirror by hand" convention).
