---
title: ADR-021 Decimal Arithmetic for Monetary Values
type: adr
status: Accepted
date: 2026-04-19
tags: [adr, backend, arithmetic, money, decimal, precision, phase-9]
description: Adopt Decimal.js for all monetary calculations to eliminate floating-point drift in transactions, splits, and financial aggregations
aliases: [adr-021, decimal arithmetic, monetary precision, float drift fix]
---

# ADR-021: Decimal Arithmetic for Monetary Values

## Status
Accepted

## Date
2026-04-19

## Context

Vision handles monetary amounts in EUR, USD, and other currencies at account-level, transaction-level, and aggregation-level precision (2 decimal places). JavaScript's native `number` type uses IEEE 754 double-precision floating-point, which cannot exactly represent decimal values like 0.1 or 0.2.

Classic floating-point arithmetic problems manifest:
- `0.1 + 0.2 === 0.3` → `false` (results in 0.30000000000000004)
- Accumulating rounding errors over many transactions
- Split payment calculations introducing drift (e.g., original amount 100 EUR, paid 33.33 EUR twice, leaves 33.34 EUR outstanding — but computed as 33.339999... in native JS)
- Inconsistency between frontend aggregations (JavaScript) and backend aggregations (PostgreSQL NUMERIC)

**Historic Issues:**
- Portfolio page accumulation drifting across 20+ stock lots
- Split reconciliation showing ±0.01 EUR phantom balance after normal user operations
- Audit trail confusion when computed outstanding ≠ database outstanding

## Decision

### 1. Adopt Decimal.js

Use **Decimal.js v10.4.3+** as the canonical library for all monetary arithmetic:

```js
import Decimal from 'decimal.js';

Decimal.set({ 
  precision: 30,           // 30 significant digits (handles up to quadrillions)
  rounding: Decimal.ROUND_HALF_EVEN  // Banker's rounding; matches PostgreSQL default
});
```

### 2. Money Utility Module

Create `apps/node-backend/src/lib/money.js` with five canonical functions:

```js
export function toDecimal(v)        // Convert any type to Decimal
export function addAll(values)      // Sum array without drift
export function subtract(a, b)      // Safe subtraction
export function roundToCents(v)     // Round to 2 DP with HALF_EVEN
export function toNumber(v)         // Convert Decimal to native number
```

**Contract:**
- All monetary input values (user form input, database NUMERIC strings, API payloads) → `toDecimal()`
- All accumulations (splits, fees, running balances) → `addAll()`
- All rounding → `roundToCents()`
- All final outputs (JSON response, display, aggregation result) → `toNumber()` or `.toString()`
- Null/undefined/empty string → treated as 0

### 3. Scope: Backend Only (Phase 9)

**Backend:**
- `splitRepository.js` — line 28-29 (split total), lines 142, 146 (amount_paid accumulation), line 147 (outstanding calc)
- `services/calculations/splits.js` — line 85 (accumulated running balance)
- Any monetary service adding, subtracting, or rounding amounts

**Frontend:**
- Monetary display uses backend JSON (which is already JavaScript number, precise to 2 DP)
- No frontend calculations of monetary values yet (displays only, no frontend aggregation)
- Future: If frontend aggregations are needed, import Decimal.js and use same patterns

**Database:**
- No changes; PostgreSQL NUMERIC type unaffected
- String coercion: When reading NUMERIC from database, convert to string then `toDecimal(string)` for safe parsing

### 4. Rounding Strategy

- **Banker's rounding (HALF_EVEN)** as default for all financial calculations
- Rounding at two decimal places (cents)
- **Why Banker's:** Matches PostgreSQL `ROUND()` default, eliminates systematic upward bias (normal round-half-up), standard in finance
- **When to round:**
  - After division (interest, fees split across transactions)
  - Before persistence (database NUMERIC fields)
  - Before JSON serialization (API response)

### 5. Testing & Validation

**Unit tests (`apps/node-backend/tests/money.test.js`):**
- IEEE 754 regression: `0.1 + 0.2 === 0.3`
- Half-even rounding: 0.005 rounds to 0, 0.015 rounds to 0.02, 0.025 rounds to 0.02
- Long accumulation: 1000 × 0.01 = 10.00 exactly
- Database NUMERIC string inputs (e.g., '100.00', '33.33')
- Order independence: `addAll([0.1, 0.2, 0.3])` = `addAll([0.3, 0.2, 0.1])`
- Null/undefined/empty-string handling

## Consequences

### Positive

- **Elimination of float drift** — Monetary calculations are now exact to 2 DP (within Decimal.js precision of 30 significant digits)
- **Audit consistency** — Backend calculations match database NUMERIC semantics; no more ±0.01 phantom balances
- **Banker's rounding** — Aligns with financial best practice and PostgreSQL default
- **Testability** — Pure calculation functions in `services/calculations/` can be tested against golden fixtures without database
- **Performance** — Decimal.js is ~3-5µs per operation; acceptable for non-realtime batch operations (imports, aggregations, splits)
- **Frontend-ready** — Module is in backend but pattern is exportable to frontend if needed in Phase 10+

### Neutral

- **Library dependency** — Adds Decimal.js (~50kb) to backend bundle; justified by correctness gain
- **Explicit conversions** — Code becomes more verbose (`toDecimal()` calls); intentional to prevent silent rounding bugs
- **Manual rounding** — No implicit rounding; all rounding is explicit and deliberate

### Negative

- **Not all arithmetic uses Decimal.js yet** — Phase 9 roll-out is scoped to split/aggregation hotspots; future phases will expand coverage
- **Slight bundle increase** — Decimal.js adds ~50kb gzipped to backend (acceptable; backend bundles are already 2-3MB)

## Implementation

### Code Changes

1. **Backend dependency:** Add `decimal.js@^10.4.3` to `apps/node-backend/package.json`

2. **Create `apps/node-backend/src/lib/money.js`:**
   - Export: `toDecimal`, `addAll`, `subtract`, `roundToCents`, `toNumber`
   - JSDoc on all exports with type hints
   - Module-level `Decimal.set()` configuration

3. **Update `splitRepository.js`:**
   - Line 28-29 (split total calc): `toNumber(toDecimal(...))` instead of `parseFloat(...)`
   - Lines 142, 146: `toNumber(...)` wrapper on database amounts
   - Line 147 (outstanding): `toNumber(subtract(amount, amount_paid))`

4. **Update `services/calculations/splits.js`:**
   - Line 85: Use `addAll(...)` instead of floating-point accumulation

5. **Add `apps/node-backend/tests/money.test.js`:**
   - 6 test cases covering regressions, edge cases, and order independence

### Testing

```bash
bun test money.test.js          # Unit tests pass
bun test -- --run               # Full test suite; no regressions
bun run build                   # Bundle unchanged in size/structure
```

### Database Migrations

- No schema changes
- NUMERIC columns remain untouched
- String coercion on read (e.g., `'100.00'` → `toDecimal('100.00')` → safe math → `toNumber()` → JSON `100` or `100.00`)

## Rollout

**Immediate (Phase 9 — this PR):**
- Deploy money.js module
- Update split/aggregation paths
- New tests pass

**Future (Phase 10+):**
- Expand to portfolio calculations (loan amortization, cost basis)
- Expand to currency conversion service
- Potentially export for frontend aggregations if needed
- Deprecate any remaining floating-point accumulations

## Compatibility Impact

- **Database:** None; NUMERIC storage unchanged
- **API contracts:** No change; JSON responses remain `number` type (safe to 2 DP)
- **Existing data:** All historical amounts re-computed via new module on mutation; no data migration needed
- **Backward compatibility:** Full; switching to Decimal for new ops doesn't break reads of old data

## Related

- [[docs/adr/014-atomic-merge-transactional-safety|ADR-014: Atomic Merge Transactional Safety]] — Multi-step operations benefit from exact arithmetic
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]] — Aggregations now use exact arithmetic
- [[docs/reference/code-patterns#pure-calculation-services-phase-3|Pure Calculation Services]] — Money utilities are pure, testable functions
- [[docs/reference/data-model|Data Model Reference]] — NUMERIC column semantics
