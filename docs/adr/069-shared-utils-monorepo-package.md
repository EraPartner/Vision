---
title: "ADR-069: @vision/shared-utils Monorepo Package"
type: adr
status: Accepted
date: 2026-06-01
tags: [adr, monorepo, workspace, shared-utils, money, banker-rounding, decimal, slugify, downsample, frontend, backend, bun-workspaces]
description: Introduce @vision/shared-utils as a new Bun workspace package holding pure helpers (money, slugify, downsample) that are needed on both frontend and backend. Kills the prior per-app copy drift that caused frontend/backend rounding divergence. roundMoney now uses ROUND_HALF_EVEN (banker's rounding).
aliases: [shared-utils, workspace package, monorepo utilities, banker rounding, ROUND_HALF_EVEN]
---

# ADR-069: @vision/shared-utils Monorepo Package

## Status

Accepted

## Date

2026-06-01

## Context

Several pure utility modules existed in duplicate form: one copy in `apps/node-backend/src/lib/` and another (often diverged) copy in `apps/frontend/src/lib/`. The most critical divergence was `money.js` / `money.ts`: the backend used `ROUND_HALF_EVEN` (banker's rounding) in some places and `ROUND_HALF_UP` in others; the frontend had its own rounding logic that did not match. This produced subtle per-transaction rounding differences between what the backend stored and what the frontend displayed.

Similar duplication existed for `slugify` (used by both import pipeline and tag normalization on the frontend) and `downsample` (used by portfolio chart data on the frontend, referenced as a concept in backend performance docs).

The Vision monorepo uses Bun workspaces. Adding a new package requires only a `packages/` directory and `package.json` entries in the consuming apps.

## Decision

A new workspace package `@vision/shared-utils` is created at `packages/shared-utils/`:

```
packages/shared-utils/
├── package.json       # name: "@vision/shared-utils"
└── src/
    ├── money.js       # canonical: toDecimal, addAll, subtract, multiply, divide, roundMoney, toNumber
    ├── slugify.js     # canonical slug normalizer
    └── downsample.js  # LTTB-based downsampling for time-series charts
```

Both consuming apps declare `"@vision/shared-utils": "workspace:*"` in their `package.json`. Existing import paths (`src/lib/money.js`, `src/lib/money.ts`) become thin re-export shims to preserve backward compatibility.

**`roundMoney` rounding mode change:** As part of this consolidation, `roundMoney` is standardised to `Decimal.ROUND_HALF_EVEN` (banker's rounding) everywhere. The previous backend default was mixed (`ROUND_HALF_EVEN` in some call-sites, `ROUND_HALF_UP` in legacy code). The frontend historically used `ROUND_HALF_UP`. Banker's rounding is the PostgreSQL `NUMERIC` default and eliminates the systematic bias that accumulates when many 0.005-increment values are always rounded up.

## Consequences

**Positive:**
- Frontend and backend now share a single `roundMoney` implementation. Rounding drift between stored values and displayed values is eliminated.
- Any future pure utility needed on both surfaces goes into `shared-utils` first; per-app copies are lint-blocked.
- Banker's rounding reduces systematic rounding bias across large transaction sets.

**Negative:**
- `ROUND_HALF_EVEN` changes the output for exactly half-cent values (e.g., `roundMoney(0.005)` was `0.01`; now `0.00`). Tests relying on the old behavior must be updated. Real financial impact is negligible for individual transactions but may produce small retroactive restatement differences in aggregate reports for users with large datasets.
- Adds a new Bun workspace package that must be built before either app.

**Neutral:**
- The re-export shims in each app mean no call-site changes are required in the short term.
- Existing frontend `decimal.ts` (`parseDecimal()` for form input parsing) is unchanged — it is a different concern from the shared money math.

## Related

- [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021: Decimal Arithmetic for Monetary Values]]
- [[docs/reference/code-patterns#shared-utilities-monorepo-package-june-2026-adr-069|Code Patterns — Shared Utils]]
- [[docs/reference/code-patterns#money-utility-pattern-phase-9--june-2026|Money Utility Pattern]]
- [[docs/adr/index|All ADRs]]
