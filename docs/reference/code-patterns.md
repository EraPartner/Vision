---
title: Code Patterns Reference
type: reference
status: active
date: 2026-04-26
updated: 2026-08-11
tags: [reference, patterns, conventions, code-style, backend, frontend, delete-responses, http-204, phase-0, phase-1, phase-2, phase-3, phase-4, phase-5, phase-6, phase-9, phase-12, phase-14, phase-q, phase-c, phase-d, motion, liquid-glass, design-system, decimal, money, timezone, openapi, domain-split, import, import-pipeline, concurrency, batching, decimal-enforcement, zustand, slice-selection, typescript, error-handling, type-safety, csv, formula-injection, cwe-1236, csv-record-splitter, csv-parsing, multi-line-fields, date-utilities, immutability, aggregation-optimization, recipient-groups, portfolio-totals, query-parameter-filtering, buildquery, bug-hunt-2026-05-05, bug-hunt-2026-05-06, bug-hunt-2026-05-08, react-keys, stable-keys, mount-guard, memory-leak-prevention, parseLocaleNumber, number-parsing, locale-number, settings-backed-hook, portfolio-tax-classifications, audit-2026-05-11, belgian-tax, freeze-display-pattern, adr-059, dev-observability, devtools, api-inspector, observability, postgres-locking, for-update-group-by, accessibility, a11y, keyboard-operability, aria, onActivateKeyDown, shared-utils, monorepo, workspace, banker-rounding, plural, tc, portfolio-unit-math, premium-v3, optimistic-create, chart-scrub, chart-sync, context-menu, dialog-interplay, radix, role-based-glass, june-2026, skin-v2, feature-flag, css-scoping, unlayered-css, visual-skin, theming, inline-token-constraint, adr-104, wire-casing, snake-case, api-casing, database-naming, enum-discipline, check-constraints, chk-uq-idx]
description: Standard code patterns used throughout the Vision project — repositories, routes, hooks, API client, Express setup, error handling, type safety, filter builders, aggregation envelopes, aggregation refresh, trigger-maintained tables, golden fixtures, database fixtures, pure calculation services, atomic multi-step transactions, streaming CSV exports with formula injection prevention, import batch concurrency, motion consumers, surface shells, gradient icon tiles, money utilities, decimal utilities, shared date utilities with input validation and locale support, timezone boundary handling, TypeScript type annotations, type-safe error handling, domain-split API client, Zustand store with useShallow slice selection, immutable PATCH field sanitization, aggregation query optimization with Map-based single-pass accumulation, recipient group resolution via an indexable semi-join (Phase Q; rewritten from the original scalar-subquery OR shape), portfolio totals single-source-of-truth pattern (Phase 14), Belgian Tax freeze/display pattern for engine-drift protection (ADR-059, May 2026), dev-only observability integration pattern (May 2026 devtools: module-level pub-sub event bus with zero-cost tree-shaking in production). May 2026 bug hunt adds React key generation pattern (use UUID instead of index), mount guard pattern (prevent setState after unmount), and documents parseLocaleNumber heuristic with single-comma thousands separator fix. May 2026 a11y pass adds onActivateKeyDown keyboard-activation helper pattern. June 2026: shared-utils monorepo package (@vision/shared-utils) consolidates money/slugify/downsample; banker's rounding is now the canonical roundMoney mode; tc() plural pattern documented. June 2026 (ADR-070): optimistic mutation pattern (snapshot/patch/rollback via setQueriesData); surface shell updated with glass-regular/glass-elevated/opaque-table canonical rules; motion consumer updated for PageTransition re-addition and dialog keyframe animation. June 2026 Premium v3 (ADR-071): optimistic-create pattern (temp negative-id row, server swap, rollback, onSettled invalidate); chart scrub pattern (useChartScrub, pointer capture, glass Δ pill); chart sync pattern (ChartSyncProvider, syncId prop, domain guard). June 2026 Premium v3 V5 (ADR-071): Radix ContextMenu + Dialog interplay pattern — modal={false} prevents body pointer-events race when menu items spawn Dialogs. June 2026 (role-based glass): surface shell canonical rule broadened — glass-regular now applied to ALL content/chart/stat/state cards; old ~6-surface-per-viewport limit superseded; tables/forms/placeholders/callouts/dialog-nested cards remain opaque as role-based exceptions. June 2026 (ADR-104): scoped-skin-behind-a-flag pattern — alternative visual skin shipped as UNLAYERED CSS under :root.skin-v2 toggled by VITE_SKIN_V2 booleanEnv flag (default OFF); localStorage runtime override + window.__setSkinV2 dev helper; critical inline-token constraint: applyThemePalette() writes color tokens as inline styles which beat any stylesheet rule. July 2026: wire casing convention — snake_case is the request/response body contract, translated to camelCase at the route edge; ai/savedCharts/crossWorkspace/admin-dbEditor requests plus marketLookup and import-rollback responses are grandfathered camelCase; dual-accept (`x_y ?? xY`) is banned.
aliases: [code patterns, coding patterns, conventions, patterns, delete response pattern, 204 no content, delete convention, how to write code, repository pattern, route pattern, hook pattern, error handling, type-safe error handling, type annotations, filter builder, golden fixture, aggregation envelope, calculation services, import concurrency, motion pattern, surface shell pattern, gradient icon pattern, money pattern, decimal pattern, timezone pattern, domain split, openapi, typescript types, csv export, safe csv, formula injection, cwe-1236, date utilities, immutability, aggregation optimization, Map pattern, recipient group filter, recipientGroupId, portfolio totals, single source of truth, parseLocaleNumber, number parsing, locale-aware number parsing, thousands separator, decimal separator, belgian-tax-pattern, freeze-display-pattern, as-filed-calculation, engine-drift-protection, shared-utils, workspace, plural, tc, scoped-skin-behind-a-flag-pattern-adr-104, skin-v2 pattern, visual skin flag, unlayered css pattern, inline token constraint, wire casing convention, snake_case bodies, api casing, camelCase grandfathered routers, database naming, enum discipline, text plus check, constraint naming, index naming, chk prefix, uq prefix, idx prefix]
---

# Code Patterns Reference

> [!abstract] Purpose
> This document captures the standard code patterns used throughout the Vision project. AI agents should follow these patterns when writing new code. Developers can use this as a quick reference.

## Shared Utilities Monorepo Package (June 2026, ADR-069)

**Package:** `@vision/shared-utils` at [[packages/shared-utils/]]

Pure helpers that are needed on both the frontend and backend now live in a dedicated Bun workspace package rather than being duplicated in each app.

**Shared modules:**

| Module | Exports | Previous location |
|--------|---------|-------------------|
| `money` | `toDecimal`, `addAll`, `subtract`, `multiply`, `divide`, `roundMoney`, `toNumber` | `apps/node-backend/src/lib/money.js` |
| `slugify` | `slugify` | duplicated in both apps |
| `downsample` | `downsample` | `apps/frontend/src/lib/downsample.ts` |

Both apps add `"@vision/shared-utils": "workspace:*"` to their `package.json` dependencies and re-export from `@vision/shared-utils/money` (and equivalents) so existing import paths continue to work as thin shims.

> [!important] Do not import from `apps/node-backend/src/lib/money.js` directly in the frontend, or vice-versa. Always import from `@vision/shared-utils/money` (or the per-app re-export shim at `src/lib/money.js` / `src/lib/money.ts`).

This eliminates the prior frontend/backend money-rounding drift that was caused by each app carrying its own copy of `roundMoney`.

---

## Money Utility Pattern (Phase 9 + June 2026)

**Source:** [[packages/shared-utils/src/money.js]] (re-exported via [[apps/node-backend/src/lib/money.js]] and [[apps/frontend/src/lib/money.ts]])

All monetary calculations must use Decimal.js to eliminate IEEE 754 floating-point drift. JavaScript's native `number` type cannot exactly represent 0.1 + 0.2 (results in 0.30000000000000004). Vision uses banker's rounding (HALF_EVEN) to match PostgreSQL NUMERIC semantics.

> [!note] Banker's Rounding is Now Canonical (June 2026)
> `roundMoney` uses `ROUND_HALF_EVEN` (banker's rounding). This was `ROUND_HALF_UP` prior to June 2026. Banker's rounding is the PostgreSQL `NUMERIC` default and eliminates systematic bias in large datasets (e.g., half-cent amounts always round up accumulated ~0.5¢/transaction errors over thousands of rows). Any code relying on HALF_UP semantics must be audited.

> [!note] Hot-Path Enforcement (Phase 12 Bugfix Sweep)
> ESLint custom rule `no-raw-money-arithmetic` now warns on raw `+`, `-`, `*`, `÷` operators on identifiers matching money-like names (e.g., `amount`, `balance`, `cost`). This helps prevent drift in hot paths like split allocation and portfolio math. Not all warnings are errors — context matters — but all should be reviewed before merge.



### Pattern

```js
import { toDecimal, addAll, subtract, multiply, divide, roundMoney, toNumber } from '../lib/money.js';

// Convert any input (number, string, Decimal, null) to Decimal
const amount = toDecimal(100.5);

// Sum an array without drift
const total = toNumber(addAll([0.1, 0.2, 0.3])); // 0.6 exactly

// Safe subtraction (e.g., outstanding balance)
const outstanding = toNumber(subtract('100.00', '66.67')); // 33.33 exactly

// Safe multiplication (e.g., currency conversion, portfolio aggregation)
const converted = toNumber(multiply('100.00', '1.2145')); // 121.45 exactly

// Safe division (e.g., split allocation, fee distribution)
const perShare = toNumber(divide('100.00', 3)); // 33.33 (pre-rounded)

// Round to cents with banker's rounding (HALF_EVEN) or custom places
const rounded = toNumber(roundMoney('10.125')); // 10.12 (rounds to even)
const scaled = toNumber(roundMoney('0.123456', 4)); // 0.1235 (to 4 DP)

// Database NUMERIC strings
const dbAmount = toNumber(toDecimal('100.00')); // Safe from string precision loss

// Repository read boundary: coerce a single DB NUMERIC column, preserving SQL NULL
import { numericColumn, coerceNumericFields } from '../lib/money.js';

const price = numericColumn(row.current_price); // '31.20' → 31.2; null → null; '' → undefined

// Coerce multiple columns at once (shallow copy, does not mutate input)
const NUMERIC_FIELDS = ['amount', 'fees', 'fx_rate_to_eur'];
const normalized = coerceNumericFields(row, NUMERIC_FIELDS);
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| All monetary input | Wrap in `toDecimal()` immediately |
| All accumulations | Use `addAll([...])` instead of `.reduce((a, b) => a + b)` |
| Multiplication | Use `multiply(a, b)` for FX rates, portfolio aggregation, fee scaling |
| Division | Use `divide(a, b)` for per-unit costs, fee splits; result auto-rounded to 2 DP |
| Rounding strategy | Use `roundMoney(value, places=2)` for custom precision; defaults to banker's rounding (HALF_EVEN) |
| Final output | Use `toNumber()` or `.toString()` for JSON/display |
| Null/undefined | Treated as 0 by `toDecimal()` |
| Database NUMERIC | Convert string to `toDecimal(string)` for safe math |
| Banker's rounding | HALF_EVEN default; 0.005 rounds to 0, 0.015 to 0.02 |
| Single column coercion | `numericColumn(v)` — converts NUMERIC string to number; `null`/`undefined` pass through unchanged; `''` → `undefined` |
| Multi-column coercion | `coerceNumericFields(row, fields)` — returns shallow copy with named columns coerced; no-op on nullish row |

### Mandatory Scopes (Phase 9 Complete + May 2026 Audit)

As of 2026-05-14, decimal enforcement is **mandatory** for all monetary API output paths and extends to portfolio aggregation and import pipeline precision:

| Scope | Files | Enforcement |
|-------|-------|-----------|
| **Repository reads** | splitRepository, infoRepositoryBanks/Helpers/Monthly, portfolioTransactionRepository, rawTransactionRepository | `toNumber(toDecimal(value))` on all NUMERIC/DECIMAL DB columns |
| **Repository reads (June 2026 stragglers)** | investmentRepository, watchlistRepository, portfolioTxRepo.reads.js (+ writes via `mapPortfolioTxRow`) | `coerceNumericFields(row, NUMERIC_FIELDS)` via `numericColumn` — covers current_price, interest_rate, cadastral_income, municipality_tax_rate, target_price, amount, units, price_per_unit, fees, taxes, fx_rate_to_eur, getSummary aggregation totals; `null`/`undefined` preserved so response shapes are unchanged |
| **Route responses** | transactions, plannedTransactions, info, aggregations | `toDecimal()` → math → `toNumber()` before JSON serialization |
| **Service calculations** | recurringDetectionService, currencyConversionService, portfolioMath, snapshotBuilder, portfolioSummaryService | Decimal.js throughout; `toNumber()` for output |
| **Portfolio aggregation** | portfolioSummaryService.js, portfolio/snapshotBuilder.js, portfolioMath.js | Per-investment accumulators + FX multipliers routed through Decimal; `multiply()` for conversion factors; `toNumber()` final aggregate |
| **CSV/XML parsing** | Bank import adapters (_shared.js, belfius.js, revolut.js, sabb.js, vision.js) | parseFloat only; streaming running balances held as Decimal throughout import; DB writes go through repositories |
| **Imports** | importPipeline/commit.js | Amount parsers → Decimal; running balance accumulation via Decimal; `roundMoney()` before persistence (`streamingImportService.js` and `rawTransactionImportService.js` deleted 2026-05-29) |
| **Exports** | transactionExport.js, calculations/aggregation/cashflowForecast.js, calculations/recurrence.js | All accumulations (running balance, cumulative flows) via Decimal; `divide()` for per-row allocation |

### When to Use

- **Database reads** — All monetaryvalues from DB (MANDATORY in Phase 9)
- **Split calculations** — outstanding balance, payment allocation
- **Aggregations** — running totals, monthly sums, portfolio valuations
- **Currency conversion** — avoid rounding errors across exchanges
- **Any accumulation loop** — use `addAll()` instead of `for` loop with native arithmetic
- **API output** — All final JSON serialization uses `toNumber()`

### When NOT Necessary

- **Frontend UI** — server sends precise JSON (already 2 DP); frontend displays only
- **Non-monetary calculations** — use native number for counts, ratios, percentages
- **Text parsing for import** — CSV/XML text use parseFloat; decimal enforcement happens at DB write

---

## Decimal Pattern (Frontend, Phase 2.2)

**Source:** [[apps/frontend/src/lib/decimal.ts|decimal.ts]]

Frontend monetary display and form parsing use `parseDecimal()` for safe handling of comma-formatted input and edge cases:

```typescript
import { parseDecimal } from '@/lib/decimal';

// Parse user input (form field)
const amount = parseDecimal('1.234,56'); // → 1234.56
const amount2 = parseDecimal('100');     // → 100
const amount3 = parseDecimal(null);      // → 0 (fallback)

// Safe fallback
const value = parseDecimal(userInput, 0);  // Use 0 if parsing fails
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| User form input | Always wrap in `parseDecimal()` |
| Comma handling | Automatically strips commas (locale-aware parsing) |
| Null/undefined/empty | Returns `fallback` (default 0) |
| Non-finite results | Returns `fallback` (NaN, Infinity handled) |
| API responses | Already precise (server sends 2 DP numbers), display as-is |
| Frontend calculations | Avoid frontend monetary math; compute server-side |

### When to Use

- **Form field parsing** — user enters "1.234,56", parse to 1234.56
- **CSV import preview** — preview user-provided amounts
- **Legacy number input** — handle both comma and decimal separators
- **Fallback safety** — never show NaN in UI

### When NOT to Use

- **API response values** — already precise from backend
- **Arithmetic operations** — keep math on server side
- **Non-monetary numbers** — use `parseFloat()` or `Number()` for counts, ratios

---

## TypeScript Type Annotation Best Practices (Phase 5+)

**Applies to:** Both frontend and backend TypeScript files

### Explicit Type Annotations for Uninitialized Variables

Always explicitly type variables on declaration when not initialized:

```typescript
// WRONG: Type inference on uninitialized variable
let count = 0;  // inferred as number, but looks unintentional
let values = [];  // inferred as unknown[], unclear intent
let currentValue = 0;  // ambiguous for linting

// CORRECT: Explicit type annotation
let count: number;
let values: string[];
let currentValue: number = 0;

// Or use const in loop/scope when possible
let maxValue: number;
for (const item of items) {
  maxValue = Math.max(item.value);  // Now clearly typed
}
```

### Type Narrowing in Conditionals

```typescript
// Avoid casting with `as any`
const value = data.field as any;  // ❌ Disables type safety

// Instead, use type guards with `instanceof` or `typeof`
if (value instanceof Error) {
  console.log(value.message);  // ✅ value is Error here
} else if (typeof value === 'string') {
  console.log(value.toUpperCase());  // ✅ value is string here
}
```

### Interface vs Type (Phase 5+)

**Rule:** Use `type` for simple aliases; use `interface` for object contracts

```typescript
// Type alias (simple/discriminated union)
type ThemeVariant = 'default' | 'dracula' | 'solarized';
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// Empty interface extends becomes type alias (cleaner)
// BEFORE: interface X extends Y { }
// AFTER:  type X = Y;

// Use interface for object contracts with inheritance
interface Entity {
  id: number;
  createdAt: string;
}

interface Transaction extends Entity {
  amount: number;
  category: string;
}
```

### Function Parameter Types (Phase 5+)

```typescript
// WRONG: Accept 'any' parameter
function process(item: any) { ... }  // ❌ Loses type info

// CORRECT: Use specific type
function process(item: Transaction) { ... }  // ✅ Type-safe

// Generic when flexible:
function process<T extends Entity>(item: T) { ... }
```

### No "Useless Assignment" Anti-Pattern

```typescript
// WRONG: Variable assigned but never used before reassignment
let total = 0;
total = calculateSum(items);  // First assignment is useless

// CORRECT: Declare without initial assignment, or initialize correctly
let total: number;
total = calculateSum(items);

// Or use const when possible
const total = calculateSum(items);
```

---

## Timezone-Safe Date Utilities (Frontend, Phase 2.3)

**Source:** [[apps/frontend/src/lib/timezone.ts|timezone.ts]]

Frontend date operations avoid the pitfall of `new Date("YYYY-MM-DD")`, which parses as UTC midnight and shifts the calendar date in timezones east of UTC. Use helper functions instead:

```typescript
import { parseYmd, toYmd, todayYmd, daysBetween } from '@/lib/timezone';

// Parse a YYYY-MM-DD string as local midnight (not UTC)
const date = parseYmd('2026-04-22');  // → Date at 00:00:00 local time

// Convert Date to YYYY-MM-DD string
const ymdString = toYmd(new Date());  // → "2026-04-22"

// Today's date as string
const today = todayYmd();              // → "2026-04-22"

// Days between two dates (fractional)
const elapsed = daysBetween(startDate, endDate);  // → 5.5 (days)
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Date-only values | Always use `parseYmd()`, never `new Date("YYYY-MM-DD")` |
| String output | Use `toYmd()` for YYYY-MM-DD format |
| Today | Use `todayYmd()` for current date string |
| Date arithmetic | Use `daysBetween()` for elapsed time calculations |
| No timezone conversion | These functions work in browser local time (no APP_TIMEZONE crossing) |
| Server dates | Backend sends ISO 8601; parse with `parseYmd(txn.date)` |

### When to Use

- **Form defaults** — "Today's date" field gets `todayYmd()`
- **Date comparisons** — is planned date in future? Compare with `todayLocal()`
- **Calendar UI** — render days using local midnight
- **Filters** — date range "from Jan 1 to Dec 31 local"

### When NOT to Use

- **Backend aggregations** — server uses `APP_TIMEZONE` for bucketing
- **UTC operations** — use native Date for UTC math
- **Timestamp storage** — use ISO 8601 strings from API

---

## Shared Date Utilities (Frontend, Phase 12 Bugfix Sweep)

**Source:** [[apps/frontend/src/components/shared/dateUtils.ts|dateUtils.ts]]

The `parseLocalDateFromYmd()` function safely parses ISO date strings with defensive input validation:

```typescript
import { parseLocalDateFromYmd, toYmd, formatDistanceToNow } from '@/components/shared/dateUtils';

// Parse YYYY-MM-DD safely; returns new Date(NaN) for invalid input
const date = parseLocalDateFromYmd('2026-04-22');  // → Date at 00:00:00 local time
const invalid = parseLocalDateFromYmd(null);        // → new Date(NaN) (safe fallback)
const empty = parseLocalDateFromYmd('');            // → new Date(NaN) (safe fallback)

// Format relative dates with locale support
const ago = formatDistanceToNow(new Date('2026-04-20'), { locale: 'nl' });  // → "2 days ago" (in Dutch)

// Convert Date to YYYY-MM-DD
const ymdString = toYmd(new Date());                // → "2026-04-22"
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Input validation | Guard against non-string/empty input in `parseLocalDateFromYmd()` by returning `new Date(NaN)` instead of throwing |
| Locale support | `formatDistanceToNow()` accepts locale option to respect user language preferences (en or nl) instead of hardcoding English |
| Immutability | All helpers return new values; no mutations of input dates |
| Local time | Parse dates in browser local time (no UTC shifts) |

### When to Use

- **Form input parsing** — user selects date from date picker; parse with `parseLocalDateFromYmd()`
- **Relative time labels** — "posted 2 days ago"; use `formatDistanceToNow()` with locale option
- **Defensive parsing** — fallback to safe `new Date(NaN)` for invalid input instead of throwing

### When NOT to Use

- **Timestamp parsing** — ISO 8601 timestamps from API use `parseISO()`
- **UTC operations** — use native `Date` for UTC math
- **Date formatting** — use `formatDate()` or `formatDateWithAppSettings()` instead

### Chart Month Names — `appLanguageToLocale`

`formatDate(date, pattern, locale)` defaults `locale` to `en-US`, so any caller that
omits it renders English month names ("Jan/May/Oct") in the Dutch UI. Month-name
patterns (`MMM …`) must pass the locale explicitly:

```typescript
import { appLanguageToLocale, formatDate } from '@/components/shared/dateUtils';

const { language } = useLanguage();
const monthLabelLocale = appLanguageToLocale(language);   // 'nl' → 'nl-NL', else 'en-US'

formatDate(d, 'MMM yy', monthLabelLocale);
```

**Do not reuse `numberFormatToLocale` for this.** It maps the *number-format setting*
(`eu` → `de-DE`) and would render German months in a Dutch UI. Month names follow the
UI language; number shapes follow the number setting — two different inputs.

`formatPeriodLabel` / `formatPeriodShort` in `statisticsUtils.ts` take `locale` as a
**required** parameter for exactly this reason: omission is a compile error rather
than a silent English fallback.

---

## Backend Repository Pattern

**Source:** [[apps/node-backend/src/repositories/transactionRepository.js|transactionRepository.js]], [[apps/node-backend/src/repositories/categoryRepository.js|categoryRepository.js]]

> [!note] `null`/`undefined` at the repository boundary
> Repository methods return an empty result (rather than throwing) when a row is not found — a
> deliberate exception to the project-wide "use `undefined` for optional values" convention, because
> a zero-row query means "row does not exist" and callers need to distinguish that from a missing
> argument.
>
> Historically this was standardized on `null` (`rows[0] || null`, e.g.
> `importBatchRepository.js`), and `null` remains the preferred sentinel for new code. Note that
> several newer repositories currently return `undefined` instead (`accountRepository.js`,
> `customParserConfigRepository.js`, `portfolioImportBatchRepository.js` return bare `rows[0]` /
> `?? undefined`), so **callers must treat either as "not found"** — test with `== null` (matches
> both) rather than `=== null`.

> [!note] `null` as a "parse/fetch miss" sentinel
> The same "distinguish absence from a missing argument" reasoning extends `null` to two more
> boundaries beyond the repository layer:
> - **CSV import adapters** (`services/importPipeline/adapters/*.js`, `_shared.js`) return `null`
>   for an unparseable row so the pipeline can count it as skipped rather than treating it as data.
> - **Rate fetching** (`services/currency/rateFetcher.js`) returns `null` when a provider has no
>   rate for a currency/date.
>
> Both are deliberate "miss" sentinels, not the "optional value" case — new code at these two
> boundaries should keep returning `null` (test with `== null`). Everywhere else, prefer `undefined`.

```js
import { query } from '../database/connection.js';

export const entityRepository = {
  async getAll({ limit = 50, offset = 0, active = true, ...filters } = {}) {
    let sql = `SELECT * FROM table_name WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND is_active = true`;
    sql += ` ORDER BY id DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ active = true, ...filters } = {}) {
    let sql = `SELECT count(*) FROM table_name WHERE 1=1`;
    const params = [];
    // Same filter logic as getAll
    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM table_name WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async create(data) {
    const sql = `INSERT INTO table_name (col1, col2) VALUES ($1, $2) RETURNING *`;
    const result = await query(sql, [data.field1, data.field2]);
    return result.rows[0] || null;
  },

  async update(id, fields) {
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIdx++}`);
        params.push(value);
      }
    }
    if (setClauses.length === 0) return this.getById(id);
    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const sql = `UPDATE table_name SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM table_name WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default entityRepository;
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| DB access | Import `query` from `../database/connection.js` |
| Filter building | `WHERE 1=1` + dynamic `AND` clauses |
| Parameters | Positional (`$1`, `$2`) with manual index tracking |
| Single row | `result.rows[0] || null` |
| Delete success | `result.rowCount > 0` |
| Dynamic updates | Build `SET` clauses from `Object.entries()`, skip `undefined` |
| SQL injection | Use parameterized queries only, never string concatenation |

### Layering: repositories must not import services — with one sanctioned exception

The intended layering is `routes → services → repositories`, with pure, framework-free helpers in
`lib/` importable from any layer. Pure helpers that used to sit under `services/` were relocated to
`lib/` in Wave A2 (2026-07) precisely so repositories can use them without inverting the layers:
`lib/filterBuilder.js`, `lib/textNormalization.js`, `lib/calculations/splits.js`,
`lib/calculations/recurrence.js`, and the `VALID_PORTFOLIO_TXN_TYPES` const
(`lib/portfolioTxnTypes.js`).

> [!note] Accepted exception — `info*` read-repositories may import currency conversion + snapshot computation
> Two repository→service imports remain by design and are **sanctioned exceptions**, not bugs:
>
> - Eight `repositories/info*` files import `convertRowsToEur` / `convertToCurrency` from
>   [[apps/node-backend/src/services/currency/currencyConversionService.js|currencyConversionService.js]].
> - [[apps/node-backend/src/repositories/infoRepositoryNetWorth.js|infoRepositoryNetWorth.js]] imports
>   `computeDailySnapshots` from
>   [[apps/node-backend/src/services/portfolio/snapshotBuilder.js|snapshotBuilder.js]] (which itself
>   runs `withTransaction` and reads other repositories).
>
> **Rationale:** these info "repositories" are effectively read-services — they aggregate rows and
> currency-convert them as part of producing API-shaped results. Currency conversion is stateful
> (in-memory rate cache, ECB/er-api fetch, DB fallback, provider-health recording), so it cannot
> move to `lib/`; and lifting the conversion calls up into the info service layer would change the
> seam every info query result flows through — a behaviour-risk refactor deferred until the info
> read-path is restructured. Until then, `repositories/info*` may import currency conversion and
> snapshot computation from the service layer. Do **not** extend this exception to other
> repositories: any other pure helper a repository needs belongs in `lib/`.

---

## Timezone Boundary Handling & APP_TIMEZONE Consistency (Phase 9, ADR-009)

**Source:** [[apps/node-backend/src/lib/timezone.js|timezone.js]], [[apps/node-backend/tests/timezone.test.js|timezone.test.js]]

**May 2026 Update:** As of 2026-05-14, date bucketing throughout the backend now consistently uses `APP_TIMEZONE` (default `Europe/Brussels`):
- `cashflowForecast.js`: All date bucketing via `toAppTz` / `appDateStringToUtc` / `toAppDateString`
- `infoRepositoryPlanned.js`: Month window anchored to APP_TIMEZONE
- `portfolioMath.js`: Calendar-day counts via `calendarDaysBetween` helper
- SQL aggregations: `date_trunc()` with `AT TIME ZONE` clause set to APP_TIMEZONE
- All recurring/loan-schedule date math operates on zoned components `{year, month, day}`

Certain JavaScript environments (some older Intl implementations, edge cases in Safari) report `hour=24` at midnight when converting from UTC to zoned wall-clock time. This is technically valid per ECMAScript (hour is in range [0,24]) but breaks logic expecting [0,23]. The fix normalizes hour=24 to day+1, hour=0 and re-normalizes via `Date.UTC()` to handle month/year overflow.

### Pattern

```js
import { toAppTz } from '../lib/timezone.js';

// Before (buggy):
const zoned = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone,
  // ... parts ...
}).formatToParts(utcDate);
const hour = get('hour');  // Might be 24!
if (hour > 23) /* error or silent bug */

// After (normalized):
const zoned = toAppTz(utcDate, zone);
// zoned.hour is always [0,23]
// zoned.day, month, year are correctly rolled if hour was 24
```

### Implementation

When `hour === 24`:
1. Set `hour = 0`
2. Increment `day` (via `Date.UTC(year, month-1, day+1)`)
3. Extract year, month, day from rolled Date to handle month/year overflow automatically

### Key Cases

| Scenario | Input | Output |
|----------|-------|--------|
| Jan 31 23:00 UTC (Feb 1 00:00 Brussels) | `hour=24, day=31, month=1` | `hour=0, day=1, month=2, year=2026` |
| Dec 31 23:00 UTC (Jan 1 00:00 Brussels) | `hour=24, day=31, month=12` | `hour=0, day=1, month=1, year=2027` |

### Tests

Two new test cases in `timezone.test.js`:
- `toAppTz handles year boundary at Dec 31 -> Jan 1 rollover`
- (Existing case already covered Jan 31 → Feb 1)

---

## Backend Route Pattern

**Source:** [[apps/node-backend/src/routes/transactions.js|transactions.js]], [[apps/node-backend/src/routes/splits.js|splits.js]], [[apps/node-backend/src/routes/categories.js|categories.js]], [[apps/node-backend/src/routes/plannedTransactions.js|plannedTransactions.js]]

Per [[docs/adr/026-unified-api-response-envelope|ADR-026]], all routes return `{ ok: true, data, meta? }` via `res.ok()` middleware. PATCH handlers must sanitize read-only fields immutably:

```js
import { Router } from 'express';
import entityRepository from '../repositories/entityRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/entities — paginated list
router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, ...filters } = req.query;
  const opts = {
    limit: Math.min(parseInt(limit, 10) || 50, 1000),
    offset: parseInt(offset, 10) || 0,
  };

  const [items, total] = await Promise.all([
    entityRepository.getAll(opts),
    entityRepository.getCount(opts),
  ]);

  // List response: wrap payload as {items, total, ...} inside data
  res.ok({ items, total, limit: opts.limit, offset: opts.offset });
});

// GET /api/entities/:id
router.get('/:id', validateIdParam, async (req, res) => {
  const entity = await entityRepository.getById(parseInt(req.params.id, 10));
  if (!entity) throw new NotFoundError('Entity not found');
  res.ok(entity);
});

// POST /api/entities
router.post('/', async (req, res) => {
  const { requiredField, ...data } = req.body;
  if (!requiredField) {
    throw new ValidationError('Missing required fields: requiredField');
  }
  const entity = await entityRepository.create(data);
  res.status(201);
  res.ok(entity);
});

// PATCH /api/entities/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  // Remove read-only fields immutably (via destructuring rest, not in-place delete)
  const { id: _id, createdAt: _createdAt, ...sanitized } = req.body;
  const updated = await entityRepository.update(parseInt(req.params.id, 10), sanitized);
  if (!updated) throw new NotFoundError('Entity not found');
  res.ok(updated);
});

// DELETE /api/entities/:id — hard delete answers 204 with no body (see
// "DELETE Response Pattern" below for the soft-delete / side-effect exceptions)
router.delete('/:id', validateIdParam, async (req, res) => {
  const deleted = await entityRepository.hardDelete(parseInt(req.params.id, 10));
  if (!deleted) throw new NotFoundError('Entity not found');
  res.status(204).send();
});

export default router;
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| **List envelope** | `res.ok({ items, total, limit?, offset? })` wraps items in a `data` object per [[docs/adr/026-unified-api-response-envelope|ADR-026]] |
| **Parallel fetch** | `Promise.all([getAll, getCount])` for list endpoints to avoid N+1 |
| **ID validation** | `validateIdParam` middleware on all `/:id` routes; `validateIntParam('<param>')` (e.g. `validateIntParam('patternId')`, `validateIntParam('accountId')`) for sub-resource id params. Both accept **only** a plain base-10 digit string (or an integer number) in 1..2³¹−1 — `"12abc"`, `"12.5"`, `"1e3"`, `"0x10"`, `" 5 "` and `0` all 400. Never hand-roll an id check with `parseInt` (takes the leading digits of anything) **or `Number()`** (takes `"0x10"` as 16, `"1e3"` as 1000) — both silently address the wrong record. Every id parser delegates to `validateId`: `validateIntArray` for body id arrays, `parseIdArrayQueryParam` (`aggregations.js`) for repeatable id query params, `assertOptionalId` for optional single query ids, `validatedIdField` (`splits.js`) and `coercedIdSchema` (`lib/importBatchIds.js`) for zod bodies/params, `parsePositiveInt` (`aiChat/tools/_validate.js`) for LLM-emitted tool args. Add a call, not another parser — and never *filter* a bad id out of a list, since that answers with a silently different dataset ([[docs/security/input-validation#ID Validation\|Input Validation]]) |
| **PATCH sanitization** | Remove read-only fields immutably via destructured rest: `const { id: _id, ...sanitized } = req.body` (never in-place `delete`) |
| **Error handling** | Throw `NotFoundError`, `ValidationError`, etc.; `errorHandler` middleware converts to `{ ok: false, error: {...} }` |
| **Success response** | All success paths use `res.ok(data)` or `res.ok({items, total})` — except hard deletes, which answer `204` (see [[docs/reference/code-patterns#DELETE Response Pattern|DELETE Response Pattern]]) |
| **Route ordering** | Static routes (e.g., `/providers`) BEFORE `/:id` routes |
| **Rate limiting** | Per-route limiters for heavy endpoints (e.g., export, search) |
| **Export** | `export default router` |

---

## List Response Envelope Pattern (ADR-026 Compliance)

**Source:** [[apps/node-backend/src/routes/splits.js|splits.js]], [[apps/node-backend/src/routes/attachments.js|attachments.js]], test suite

All list/paginated endpoints return a consistent envelope shape per [[docs/adr/026-unified-api-response-envelope|ADR-026]]:

```js
// Backend: Route returns wrapped payload
router.get('/', async (req, res) => {
  const [items, total] = await Promise.all([
    repository.getAll({ limit, offset }),
    repository.getCount(),
  ]);
  // Payload wraps inside res.ok(data) — data object becomes {items, total, ...}
  res.ok({ items, total, limit, offset });
});

// HTTP Response:
{
  "ok": true,
  "data": {
    "items": [...],
    "total": 42,
    "limit": 50,
    "offset": 0
  },
  "meta": {
    "requestId": "...",
    "computedAt": "2026-04-24T..."
  }
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| **Items always present** | `data.items` is the array; never bare `data` as array |
| **Total count required** | Pagination requires `data.total` (total records matching filter) |
| **Limit/offset optional** | Include if pagination is used; omit for fixed-size responses |
| **Payload wrapping** | `res.ok({items, total, ...})` wraps the list payload inside `data`; never `res.ok(items)` |
| **Parallel fetch** | Use `Promise.all([getAll, getCount])` to avoid N+1 queries |
| **Frontend unwrapping** | API client returns `body.data` automatically; consumer receives `{items, total, ...}` |
| **Pagination lives in the body** | `{items, total, limit, offset}` inside `data` — never `meta.pagination`. The envelope-level variant was documented once, emitted by exactly one endpoint, and has been retired ([[packages/types/src/api.js]]) |

### Common Patterns

```js
// List endpoint with filtering
res.ok({ items, total, limit: opts.limit, offset: opts.offset });

// Small fixed list (no pagination)
res.ok({ items: summary, total: summary.length });

// With metadata
res.ok({ items, total }, { source: 'mv', computedAt: '...' });
```

### Adding pagination to a list that never had it

A list endpoint that has always returned every row cannot simply adopt
`parsePagination` — its `defaultLimit` would truncate every existing client on the
next deploy. Use the opt-in pair from [[apps/node-backend/src/lib/pagination.js]]:

```js
// null when the caller sent neither limit nor offset ⇒ serve the whole list.
const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
const items = await repository.getAll({ active, ...(page ?? {}) });
// Unbounded query ⇒ the rows ARE the total; skip the COUNT round-trip.
const total = page ? await repository.getCount({ active }) : items.length;
res.ok(listBody(items, total, page));   // adds limit/offset only when paging
```

Repository side: build the tail with `buildLimitOffset(params, { limit, offset })`
([[apps/node-backend/src/lib/sqlClauses.js]]) so a `null` limit emits no `LIMIT`
clause at all, rather than a large default that silently caps the result.

### Frontend Consumption

```typescript
// API client unwraps envelope; frontend gets {items, total, ...}
const { items, total } = await apiClient.getEntities({ limit: 50 });

items.forEach(item => console.log(item));  // items is already the array
```

---

## DELETE Response Pattern

**Source:** [[apps/node-backend/src/routes/categories.js|categories.js]], [[apps/node-backend/src/routes/tags.js|tags.js]], [[apps/node-backend/src/routes/importRoutes.js|importRoutes.js]]

DELETE success responses previously used six different shapes (`204` empty, `{message}`, `{deleted:true}`, `{removed}`, `{ok:true}`, `{patternId}`), which made a generic delete-mutation hook impossible. One rule now applies:

> **A hard delete answers `204 No Content` with no body. A 200 body is allowed only when the operation is *not* a plain delete and the body carries something the caller cannot derive.**

```js
// Hard delete — the row is gone; nothing to report.
router.delete('/:id', validateIdParam, async (req, res) => {
  const deleted = await entityRepository.hardDelete(parseInt(req.params.id, 10));
  if (!deleted) throw new NotFoundError('Entity not found');
  res.status(204).send();
});

// Soft delete / deactivate — the row survives with is_active = false, so the
// caller gets the updated entity back (same shape as PATCH).
router.delete('/:id', validateIdParam, async (req, res) => {
  const deactivated = await tagService.softDelete(parseInt(req.params.id, 10));
  res.ok({ ...deactivated, links: [] });
});

// Side-effect-reporting delete — a rollback deletes N other rows; the UI
// renders the count, so it is a real payload.
res.ok({ deleted, recipientsRemoved });
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| **204 has no envelope** | `res.status(204).send()`, never `res.ok(...)`. Per [[docs/adr/026-unified-api-response-envelope|ADR-026]] the envelope is a property of JSON bodies; a 204 has no body to wrap |
| **Not-found still throws** | `throw new NotFoundError(...)` → the error envelope is unaffected. 204 applies to the success path only |
| **Idempotent deletes** | Where an already-removed row is deliberately not an error (`/api/research/mappings/:id`, `/api/research/provider-keys/:provider`), answer 204 regardless — do not leak a `{removed:false}` body |
| **No echo bodies** | Never return the id/params the caller just sent (`{patternId}`), a bare `{ok:true}`, or a human-readable `{message}`. None of it is information |
| **Frontend clients return `void`** | `await apiRequest<void>(path, { method: 'DELETE' })`. `apiRequest` short-circuits on 204 and resolves `undefined`; a client typed to return a body would be lying |
| **openapi.yaml** | Document `"204": { description: No Content }` with no `content:` block, then re-run `bun run generate:types` |

### The Exceptions

Only these four justify a 200 body. Each is annotated in-route with a pointer back here.

| Endpoint | Body | Why not 204 |
|----------|------|-------------|
| `DELETE /api/tags/:id` | the deactivated tag | Soft delete — `is_active` flips, the row survives, and the caller wants the new state |
| `DELETE /api/recipients/:id/bank-accounts/:accountId` | the deactivated bank account | Same soft delete; mirrors the sibling `set-primary` response |
| `DELETE /api/import/batches/:id` | `{ deleted, recipientsRemoved }` | Rollback, not a delete of the addressed resource — the counts are rendered by the import history card |
| `DELETE /api/portfolio/import/batches/:id` | `{ deleted }` | Same rollback semantics |

Side-effect-count bodies keep their existing key names; unifying response keys across endpoints is a separate concern from this convention.

### When Adding a DELETE Route

1. Hard delete? → `res.status(204).send()`, `"204"` in `openapi.yaml`, frontend client returns `Promise<void>`.
2. Soft delete / deactivate? → `res.ok({ ...entity, links: [] })` and say so in a route comment.
3. Reporting counts the UI displays? → `res.ok({ ...counts })` and say so in a route comment.
4. Anything else (a message, an echoed id, `{ok:true}`) is not a reason — use 204.

---

## Wire Casing Convention (snake_case bodies)

**Source:** [[apps/node-backend/src/routes/transactions.js|transactions.js]], [[apps/node-backend/src/routes/recipients.js|recipients.js]], [[apps/node-backend/src/routes/research.js|research.js]]

Request and response bodies were split by router: the domain API speaks snake_case (`transaction_ids`, `alias_ids`, `instrument_key`) while a handful of later routers speak camelCase (`conversationId`, `chartType`, `targetWeights`). One rule now applies:

> **snake_case is the wire convention. Request bodies, response bodies, and query parameters use snake_case keys — matching the DB column names the majority of them mirror. camelCase stays inside the process: services, repositories, and frontend types.**

```js
// Route: snake_case in, camelCase from there inward.
router.post('/portfolio-forecast', async (req, res) => {
  const body = req.body ?? {};
  const result = await runPortfolioForecast({
    horizonMonths: body.horizon_months,          // wire → internal, once, at the edge
    monthlyContribution: body.monthly_contribution,
  });
  res.ok(result);                                // response keys are snake_case too
});
```

```ts
// Frontend client owns the same translation on its side.
return researchSend<PortfolioForecast>('/api/research/portfolio-forecast', 'POST', {
  horizon_months: input.horizonMonths,
  monthly_contribution: input.monthlyContribution,
});
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| **snake_case on the wire** | Request bodies, response bodies, and query params. It matches the DB columns most payloads mirror, so a row can be returned without a rename pass |
| **Translate at the edge** | The route handler is the only place the two spellings meet. Services and repositories never see wire keys; the frontend client maps them back to camelCase for React |
| **Never dual-accept** | Accepting `horizon_months ?? horizonMonths` ships two undocumented contracts and doubles the surface every future validator has to cover. Pick snake_case; the camel key is simply an unknown field |
| **New routers are snake_case** | No matter which neighbour they sit next to in `routes/`. A grandfathered router is not a precedent |
| **openapi.yaml is the check** | The documented spelling is the contract. If a handler reads a key `openapi.yaml` does not list, one of the two is wrong |

### Grandfathered Exceptions

These predate the rule and keep camelCase — including **new endpoints added to them** — until a dedicated migration retires the list. Do not half-migrate one: a router with both spellings is worse than a router that is consistently camel.

| Surface | camelCase keys | Direction |
|---------|----------------|-----------|
| [[apps/node-backend/src/routes/ai.js|ai.js]] | `conversationId`, `useTools` | request + response |
| [[apps/node-backend/src/routes/savedCharts.js|savedCharts.js]] | `chartType`, `chartVariant`, `timeBucket`, `categoryIds`, `dateRangeStart`, … | request + response |
| [[apps/node-backend/src/routes/crossWorkspace.js|crossWorkspace.js]] | `targetWeights`, `availableCash` | request + response |
| [[apps/node-backend/src/routes/admin.js|admin.js]] DB-editor routes | `changes`, `dryRun`, `orderBy` ([[docs/adr/101-db-data-editor|ADR-101]]) | request |
| [[apps/node-backend/src/routes/marketLookup.js|marketLookup.js]] | `changePercent`, `dayHigh`, `prevClose`, `publishedAt`, … | response only — passthrough of the upstream provider shape |
| [[apps/node-backend/src/routes/importRoutes.js|importRoutes.js]] rollback bodies | `{ deleted, recipientsRemoved }` on `DELETE /api/import/batches/:id` and `DELETE /api/portfolio/import/batches/:id` | response only |

Everything else in `importRoutes.js` is snake_case (`auto_linked_count`); only the two rollback bodies are grandfathered.

### When Adding a Route

1. New router? → snake_case bodies, no exceptions.
2. New endpoint in a grandfathered router? → match that router's camelCase, so the router stays internally consistent.
3. Tempted to accept both spellings? → don't. Fix the caller instead; a wire contract with two spellings has no documented shape.

---

## Frontend Hook Pattern

**Source:** [[apps/frontend/src/hooks/useTransactions.ts|useTransactions.ts]], [[apps/frontend/src/hooks/useCategories.ts|useCategories.ts]]

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

// LIST query
export function useEntities(params?: { limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ['entities', params],
    queryFn: () => apiClient.getEntities(params),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// SINGLE query
export function useEntity(id: number) {
  return useQuery({
    queryKey: ['entities', id],
    queryFn: () => apiClient.getEntity(id),
    enabled: !!id,
    staleTime: 60_000,
  });
}

// CREATE mutation
export function useCreateEntity() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: (data: EntityCreate) => apiClient.createEntity(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      toast.success(t('entities.created'));
    },
    onError: (error: Error) => {
      toast.error(t('entities.createFailedTitle'), { description: error.message });
    },
  });
}

// UPDATE mutation
export function useUpdateEntity() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: EntityUpdate }) =>
      apiClient.updateEntity(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      toast.success(t('entities.updated'));
    },
    onError: (error: Error) => {
      toast.error(t('entities.updateFailedTitle'), { description: error.message });
    },
  });
}

// DELETE mutation
export function useDeleteEntity() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: (id: number) => apiClient.deleteEntity(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      toast.success(t('entities.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('entities.deleteFailedTitle'), { description: error.message });
    },
  });
}
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Query key | `['entities', params]` — params for cache differentiation |
| Stale time | 30s for transactional data, 2min for reference data |
| Pagination | `placeholderData: (prev) => prev` for smooth transitions |
| Conditional queries | `enabled: !!id` for single-item queries |
| Invalidation | Mutations invalidate base key `['entities']` |
| Toasts | `useLanguage()` for i18n, `description` for error details |

### Search Debounce Pattern (June 2026)

Every search-as-you-type input debounces the server call through one shared
constant — `SEARCH_DEBOUNCE_MS` (300ms), exported from
[[apps/frontend/src/hooks/useDebounce.ts|useDebounce.ts]]. 300ms is the
best-practice value for search autocomplete: long enough to skip intermediate
keystrokes during fast typing, short enough to still feel instant. Never
hardcode a search delay — import the constant so every search box stays in sync.

```ts
import { useDebounce, SEARCH_DEBOUNCE_MS } from '@/hooks/useDebounce';

const debouncedSearch = useDebounce(searchText.trim(), SEARCH_DEBOUNCE_MS);
// table components that hand-roll setTimeout use the same constant:
//   setTimeout(() => onSearchChange(value), SEARCH_DEBOUNCE_MS)
```

Consumers: `VirtualDataTable` (transactions), `DataTable`, `CommandPalette`
(general + ticker), `RecipientCombobox`, `AddToWatchlistDialog`, and the
research pages (Home/Compare/ChartBuilder/MarketLookup).

> [!warning] Non-search exception
> `PortfolioForecastPage` debounces at **450ms** and is deliberately NOT on the
> search standard — it debounces a structured forecast-input object before an
> expensive recompute, not a text query, so a longer delay is correct there.

---

## API Client Pattern

**Source:** [[apps/frontend/src/lib/api.ts|api.ts]]

```ts
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

class ApiClient {
  cancelAll(): void { /* abort all in-flight requests */ }

  async getEntities(params?: Record<string, any>): Promise<EntitiesListResponse> {
    const query = this.buildQuery(params);
    return this.request(`/api/entities${query ? '?' + query : ''}`);
  }

  async createEntity(data: EntityCreate): Promise<Entity> {
    return this.request('/api/entities', { method: 'POST', body: JSON.stringify(data) });
  }

  private buildQuery(params?: Record<string, any>): string {
    if (!params) return '';
    const qp = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) qp.append(key, String(value));
    });
    return qp.toString();
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, retries = MAX_RETRIES): Promise<T> {
    const url = API_BASE_URL + endpoint;
    const method = options.method || 'GET';
    const isIdempotent = ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method);

    for (let attempt = 0; attempt <= (isIdempotent ? retries : 0); attempt++) {
      if (attempt > 0) await backoffDelay(attempt - 1);
      try {
        const response = await this.rawFetch(url, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...options.headers },
        });

        if (RETRYABLE_STATUS_CODES.has(response.status) && isIdempotent && attempt < retries) continue;

        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Request failed' }));
          throw new Error(error.detail || 'Request failed with status ' + response.status);
        }

        if (response.status === 204) return undefined as unknown as T;
        return response.json();
      } catch (err) {
        if (!isIdempotent || attempt >= retries) throw err;
      }
    }
    throw new Error('Request failed');
  }
}

export const apiClient = new ApiClient();
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Base URL | `VITE_API_URL` env var, fallback to `localhost:3002` |
| Singleton | Export single `apiClient` instance |
| Query params | `buildQuery()` skips `undefined`/`null` values |
| Retry | Exponential backoff for idempotent methods only |
| Timeout | AbortController with 30s default timeout |
| 204 handling | Returns `undefined` |
| Cancel | `cancelAll()` aborts all in-flight requests |

---

## HTTP Request Parameter Parsing Pattern (Phase 10)

**Source:** [[apps/node-backend/src/routes/aggregations.js|aggregations.js]], [[apps/node-backend/src/routes/info.js|info.js]]

Query parameters from `req.query.*` are always strings (or string arrays if multi-valued). Safe parsing requires explicit validation, bounds checking, and fallback defaults to prevent type coercion bugs.

### Pattern: `parseIntClamped()`

Extracts and validates integer query parameters with configurable bounds:

```js
import { parseInt } from 'builtins';  // Standard parseInt, not a library

function parseIntClamped(raw, { min = 1, max, fallback }) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return max != null ? Math.min(parsed, max) : parsed;
}

// Usage in route handlers
router.get('/forecast', async (req, res) => {
  // months: defaults to 3, accepts 1–24
  const months = parseIntClamped(req.query.months, { max: 24, fallback: 3 });
  // mcPaths: defaults to 1000, accepts 1–5000
  const mcPaths = parseIntClamped(req.query.mc_paths, { max: 5000, fallback: 1000 });
  // historyMonths: defaults to 36, accepts 1–120
  const historyMonths = parseIntClamped(req.query.history_months, { max: 120, fallback: 36 });
  
  const { data, meta } = await computeCashflowForecast({ months, mcPaths, historyMonths });
  res.ok({ data, meta });
});
```

### Pattern: `parseIdArrayQueryParam()`

Repeatable **id** query params (`?excluded_category_ids=5&excluded_category_ids=9`). A thin
throwing wrapper around `validateIntArray`, so query ids, body ids and `:id` path params share
one accept set:

```js
function parseIdArrayQueryParam(raw, field) {
  if (raw == null || raw === '') return [];      // absent/empty = no filter, not an error
  const result = validateIntArray(raw, field);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

// Usage in route handlers
router.get('/monthly-summary', async (req, res) => {
  const { data, meta } = await computeMonthlySummary({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseIdArrayQueryParam(req.query.excluded_category_ids, 'excluded_category_ids'),
    excludedRecipientIds: parseIdArrayQueryParam(req.query.excluded_recipient_ids, 'excluded_recipient_ids'),
  });
  res.ok({ data, meta });
});
```

> [!warning] Never filter bad ids out of a list — reject the request
> This was `.map(Number).filter(Number.isFinite)` until 2026-08-11, which **dropped** the bad
> element: `?excluded_category_ids=12abc` became `[]`, so the exclusion silently switched off and
> the endpoint answered with a different dataset than the caller asked for — no error anywhere.
> A dropped element is worse than a rejected request, because nothing surfaces. Keep the
> empty/absent case (`[]`, a legitimate "no filter") distinct from the malformed case (400).

The lenient numeric form survives for `mc_percentiles` only — distribution percentiles in 0..100,
where fractional values are legitimate and a bad one costs a chart band, not a row set.

### Key Rules

| Pattern | Rule |
|---------|------|
| `parseInt(raw, 10)` | Always radix 10 (avoid accidental octal from leading 0) |
| Non-finite check | Reject NaN, Infinity, undefined parse results |
| Bounds enforcement | Apply min (default 1) and max bounds; use `fallback` if out of range |
| String arrays | Handle both single `?param=val` and multi `?param=val1&param=val2` |
| Array filtering | **Ids: never filter.** One bad element rejects the request (`parseIdArrayQueryParam`); a dropped id silently changes the answer. Non-id numeric arrays (`mc_percentiles`) still drop non-finite values |
| Type narrowing | Results are always `number | number[]` or fallback type, never string |

### When to Use

- **Single integer param** — `parseIntClamped()` with max bounds
- **Array of ids** — `parseIdArrayQueryParam()`, which delegates to `validateIntArray`/`validateId` and 400s on a bad element
- **Array of non-id numbers** — `parseNumericArrayQueryParam()` (only `mc_percentiles` qualifies)
- **Currency strings** — Direct upper-casing and regex validation (3-letter ISO code)
- **Boolean flags** — `=== 'true' || === '1'` string comparison (no parsing needed)
- **Dates** — Treat as ISO strings, validate with Date constructor or date lib

### When NOT to Use

- **Path parameters** (e.g., `/resource/:id`) — Use Express route constraints or numeric middleware
- **Request body** — Use schema validation (Zod) at middleware layer
- **Header values** — Parse at middleware layer, attach to `req.locals`

---

## Express App Setup

**Source:** [[apps/node-backend/src/main.js|main.js]]

### Middleware Stack (in order)

1. **CORS** — custom inline middleware; checks `Origin` header against `settings.api.corsOrigins` allowlist, sets `Access-Control-*` headers, handles OPTIONS preflight with 204 response (Phase 5 slim-down)
2. **JSON parsing** — `express.json({ limit: '1mb' })`
3. **Security headers** — CSP, HSTS (prod), X-Frame-Options, etc.
4. **Compression** — custom inline middleware using `node:zlib` createGzip(); compresses for `Accept-Encoding: gzip` + compressible types + ≥1 KB responses (Phase 5 slim-down)
5. **Request logging** — `logger.debug('[REQ] METHOD PATH')`
6. **Global rate limiter** — applied before routes
7. **Routes** — registered with per-route limiters where needed
8. **404 handler** — `{ detail: 'Not Found: METHOD PATH' }`
9. **Global error handler** — suppresses details in production

### Startup Sequence

1. Wait for DB with exponential backoff (40 attempts, 50ms to 1s)
2. `initializeSchema()` — idempotent table creation
3. `app.listen()` on configured port
4. Warm caches (exchange rates, inflation) — fire-and-forget
5. Set up 12h refresh interval for external data

### Graceful Shutdown

```js
process.on('SIGINT', async () => { await closePool(); process.exit(0); });
process.on('SIGTERM', async () => { await closePool(); process.exit(0); });
```

---

## Error Handling Pattern

**Source:** [[apps/node-backend/src/middleware/errorHandler.js|errorHandler.js]], [[apps/node-backend/src/services/deduplication.js|deduplication.js]]

Centralized error-handling middleware with typed error classes. Routes throw typed errors; middleware maps to HTTP responses.

### Handling Missing Tables (Schema Evolution, 2026-04-26)

When a table or column may not exist in older schema versions, use PostgreSQL error code `42P01` (undefined_table) to gracefully handle the missing table:

```js
try {
  const result = await query(
    `SELECT transaction_id FROM manual_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
    [hash]
  );
  if (result.rows.length > 0) {
    return { isDuplicate: true, existingTransactionId: result.rows[0].transaction_id };
  }
} catch (err) {
  // Only suppress table-not-exist errors (42P01); log other unexpected errors
  if (err.code !== '42P01') {
    logger.warn('Unexpected error in manual dedup hash check', { error: err.message, code: err.code });
  }
  // Fall through to field-based check — table may not exist yet
}
```

**Rationale:**
- Services must work across multiple schema versions during gradual migrations
- PostgreSQL error code 42P01 = "undefined table"
- Only this error is expected and silenced; other errors are logged for visibility
- Fallback logic is executed when table is missing

### Typed Error Classes

```js
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitedError,
} from '../middleware/errorHandler.js';

// Usage in routes:
if (!requiredField) {
  throw new ValidationError('Missing required field');
}

const entity = await repository.getById(id);
if (!entity) {
  throw new NotFoundError(`Entity ${id} not found`);
}

if (isDuplicate) {
  throw new ConflictError('Duplicate entry');
}
```

### Response Format

The `errorHandler` middleware ([[apps/node-backend/src/middleware/errorHandler.js|errorHandler.js]]) converts every thrown error into the unified envelope (ADR-026):

```json
{ "ok": false, "error": { "code": "ERROR_TYPE", "message": "Human-readable error message" }, "meta": { "requestId": "…" } }
```

`error.details` is included only when the thrown `AppError` carried a non-sensitive `details` object; `meta.requestId` is included when the request has an id. 5xx messages are suppressed in production.

| Status Code | Class | Error Code | When to Use |
|-------------|-------|-----------|-------------|
| 400 | ValidationError | VALIDATION_ERROR | Validation error, missing fields |
| 401 | UnauthorizedError | UNAUTHORIZED | Authentication required |
| 403 | ForbiddenError | FORBIDDEN | Access denied |
| 404 | NotFoundError | NOT_FOUND | Resource not found |
| 409 | ConflictError | CONFLICT | Duplicate entry |
| 429 | RateLimitedError | RATE_LIMITED | Rate limit exceeded |
| 500 | AppError | APP_ERROR (INTERNAL_SERVER_ERROR when unhandled) | Internal server error |

### Frontend Error Handling (Phase 5+)

```ts
// Type-safe error handling with unknown type
try {
  const result = await apiClient.createEntity(data);
  toast.success('Created successfully');
} catch (err: unknown) {
  // Always type err as unknown, then narrow
  const message = err instanceof Error ? err.message : String(err);
  toast.error('Failed to create', { description: message });
}

// When re-throwing, preserve error context
try {
  await riskyOperation();
} catch (err: unknown) {
  // Chain error context for logging
  throw new Error('Operation failed', { cause: err });
}

// Empty catch blocks must include comment
try {
  await nonCriticalTask();
} catch {
  // Failure is expected/handled elsewhere
}
```

### Type-Safe Catch Pattern (Phase 5+)

Always use `catch (err: unknown)` instead of `catch (err: any)`:

| Pattern | Status | Reason |
|---------|--------|--------|
| `catch (err: any)` | ❌ **Deprecated** | Disables type checking; allows silent bugs |
| `catch (err: unknown)` | ✅ **Required** | Enforces type narrowing before access |
| `catch { ... }` | ✅ **Acceptable** | When error is unused; must have comment |

Type narrowing in catch blocks:

```ts
try {
  // operation
} catch (err: unknown) {
  // Narrowing examples:
  if (err instanceof Error) {
    logger.error('Error message:', err.message);
  } else if (typeof err === 'string') {
    logger.error('String error:', err);
  } else {
    logger.error('Unknown error type:', String(err));
  }
}
```

### Base AppError Constructor

```js
class AppError extends Error {
  constructor(message, {
    status = 500,
    code = 'APP_ERROR',
    cause,        // native Error for logging (Phase 5+)
    details = {}  // non-sensitive debug context
  } = {})
}
```

---

## Filter Builder Pattern

**Source:** [[apps/node-backend/src/lib/filterBuilder.js|filterBuilder.js]] _(moved from `services/` to `lib/` in Wave A2, 2026-07)_

Centralized SQL WHERE clause builder for transaction-like queries. Consolidates previously duplicated filter logic across repositories.

### Usage

```js
import { buildTransactionWhere, validateInt4Ids } from '../lib/filterBuilder.js';

const opts = {
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  categoryId: 5,
  excludedCategoryIds: [10, 11, 12],
  excludedRecipientIds: [20, 21],
  bankAccount: 'CH93%',  // ILIKE substring
  active: true,
  startParamIdx: 1,
};

const { sql, params, nextParamIdx } = buildTransactionWhere(opts);

const query = `
  SELECT t.*, r.name, c.general, c.detail
  FROM transactions t
  LEFT JOIN recipients r ON t.recipient_id = r.id
  LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN categories rc ON r.default_category_id = rc.id
  LEFT JOIN categories pc ON pr.default_category_id = pc.id
  WHERE ${sql}
  ORDER BY t.date DESC
  LIMIT 50;
`;

const result = await db.query(query, params);
```

### Contract

Every builder returns `{ sql, params, nextParamIdx }`:
- `sql` — Composable fragment with no leading/trailing whitespace guarantees
- `params` — Flattened array of bind parameters (in order with `sql`)
- `nextParamIdx` — First unused `$`-index for further predicates

### Options

| Option | Type | Purpose |
|--------|------|---------|
| `recipientId` | number | Filter by recipient ID directly and its aliases (one direction) |
| `recipientGroupId` | number | Filter by full primary-recipient group (Phase Q) — resolves the complete group via scalar subqueries: matches recipient itself, all aliases, recipient's own primary, and siblings |

### Key Functions

| Function | Purpose |
|----------|---------|
| `validateInt4Ids(ids, fieldName?)` | Validate a list of PostgreSQL INT4 IDs. **Rejects, does not filter** — throws `ValidationError` if any element is not a plain digit string or integer number in `1..2^31-1`. Nullish input means "no ids" and returns `[]` |
| `buildTransactionWhere(opts)` | Build full transaction WHERE clause with all filters; includes `recipientGroupId` support (Phase Q) |

### Recipient Group Resolution (Phase Q)

`recipientGroupId` resolves a complete primary-recipient group with a four-branch **semi-join** — the same indexable shape as `recipientId`, so `t.recipient_id` is the only transactions-side column in the predicate:

```sql
t.recipient_id IN (
  SELECT id FROM recipients
  WHERE id = $N                          -- Match the recipient itself
     OR primary_recipient_id = $N        -- Match any aliases under it
     OR id = (
       SELECT primary_recipient_id FROM recipients WHERE id = $N AND primary_recipient_id IS NOT NULL
     )                                   -- Match the recipient's own primary (if alias)
     OR primary_recipient_id = (
       SELECT primary_recipient_id FROM recipients WHERE id = $N AND primary_recipient_id IS NOT NULL
     )                                   -- Match siblings under that primary
)
```

The branch set is unchanged from the earlier shape, which ORed `t.recipient_id` against the **joined** `r.primary_recipient_id`. Because `r` is joined on `t.recipient_id = r.id`, `r.primary_recipient_id` is by definition the `primary_recipient_id` of the recipient whose id equals `t.recipient_id` — so every branch can be resolved inside `recipients` without changing which rows match. The old shape spanned two relations, which the planner could only evaluate as a join Filter (no `Index Cond` on `idx_transactions_recipient_id`, no BitmapOr); the semi-join restores index probing and lets the count-only callers join nothing at all.

**Use case:** `RecentRecipientTransactionsTable` in `OwesPage` queries `recipient_group_id` to show all transactions for a recipient and linked aliases in a unified view, enabling discovery of the full transaction history even when linked recipients are involved.

---

## Aggregation Query Optimization Pattern (Phase 12 Bugfix Sweep)

**Source:** [[apps/node-backend/src/repositories/infoRepositoryBanks.js|infoRepositoryBanks.js]]

For aggregation queries that combine per-account and total monthly data, avoid nested `.find()` loops over account arrays (O(n²) or worse). Instead, build a single-pass `Map` to accumulate totals:

```js
// BEFORE (O(months × accounts²)):
const totalsByMonth = {};
for (const row of historyConverted) {
  for (const account of accounts) {
    if (account.bank_account === row.bank_account) {
      // Found matching account; accumulate
      totalsByMonth[month] = (totalsByMonth[month] ?? 0) + row.amount;
    }
  }
}

// AFTER (O(months)):
const totalsByMonth = new Map();
for (const { month, balance } of Object.values(historyMap)) {
  totalsByMonth.set(month, (totalsByMonth.get(month) ?? 0) + balance);
}
const totalHistory = [...totalsByMonth.keys()]
  .sort()
  .map((month) => ({ month, balance: roundToCents(totalsByMonth.get(month)) }));
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Single-pass aggregation | Use `Map` to accumulate values in one loop, not nested searches |
| Key-value lookup | `.get()` / `.set()` for O(1) aggregation; avoid `.find()` in loops |
| Deferred sorting | Collect keys, sort once, then map to results (not sort during accumulation) |
| Null coalescing | Use `?? 0` for safe defaults when key not yet in map |

### When to Use

- Monthly aggregations across multiple accounts or entities
- Computing totals from per-item detail rows
- Any aggregation where you iterate once and accumulate

### When NOT to Use

- Small datasets (< 100 rows) where O(n²) is negligible
- When the order matters before aggregation (e.g., sorted per-account history)

---

## Pure Calculation Services (Phase 3)

**Source:** [[apps/node-backend/src/services/calculations/|services/calculations/]], [[apps/node-backend/src/utils/portfolioMath.js|portfolioMath.js]]

As of Phase 3, business logic for non-trivial calculations has been extracted into **pure, stateless functions** with no I/O side effects. These are hosted in `services/calculations/` and `utils/` and are suitable for golden-fixture testing and migration to shared utility libraries.

**Modules:**

| Module | Purpose |
|--------|---------|
| `services/calculations/loanSchedule.js` | Loan amortization schedule generation (amortizing, fixed_principal, interest_only) |
| `lib/calculations/recurrence.js` _(moved from `services/calculations/` in Wave A2)_ | Recurring payment date calculation (daily, weekly, monthly, yearly, custom) |
| `lib/calculations/splits.js` _(moved from `services/calculations/` in Wave A2)_ | Transaction-split allocation/payment validation and owed-summary projection |
| `utils/portfolioMath.js` | Cost basis calculations (weighted average, FIFO, LIFO) with immutable lot handling |

**Immutability in portfolioMath (2026-04-25):**
- `calculateCostBasisFIFO()` and `calculateCostBasisLIFO()` now use immutable patterns throughout: spread operators for array construction, immutable object creation for lot updates, and immutable transformations via `.map()` in helper functions.
- `applyEventToLots()` returns an object with mapped lot arrays (never mutations), supporting corporate actions (splits, return_of_capital) with immutable lot transformations.
- All portfolio math calculations avoid in-place mutations, enabling safe concurrent processing and eliminating hidden side effects.

**Migration Status:** Complete. The old `services/loanRepaymentService.js` and `services/recurrenceService.js` shims have been removed; `routes/plannedTransactions.js` now uses the canonical `services/calculations/` modules directly.

---

## Golden-Fixture Pattern

**Source:** [[apps/node-backend/tests/golden/runGolden.js|runGolden.js]]

Regression testing for non-trivial calculations (loan amortization, recurrence expansion, etc.). Input + expected output stored as JSON fixtures. Paired with pure calculation services in `services/calculations/`.

### Fixture Layout

```
tests/golden/__fixtures__/
├── loanSchedule/
│   ├── amortizing-standard.input.json
│   ├── amortizing-standard.expected.json
│   ├── fixed-principal-basic.input.json
│   ├── fixed-principal-basic.expected.json
│   └── ...
├── recurrence/
│   ├── monthly-basic.input.json
│   ├── monthly-basic.expected.json
│   ├── jan-31-leap-year.input.json
│   └── ...
```

### Coverage (Phase 3)

**loanSchedule.golden.test.js:**
- Amortizing: standard, zero-APR, month-end clamp, single-month, 360-month
- Fixed principal: standard, edge cases
- Interest-only: standard, edge cases

**recurrence.golden.test.js:**
- Built-in patterns: daily, weekly, biweekly, monthly, quarterly, yearly
- Edge cases: Jan 31 clamping (non-leap + leap), Feb 29 yearly rollover, custom "every N days" regex
- Invalid patterns return null

### Usage in Vitest

```js
import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { generateLoanSchedule } from '../../src/services/calculations/loanSchedule.js';

describe('loanSchedule golden', () => {
  it('amortizing-standard', async () => {
    await runGolden('loanSchedule/amortizing-standard', (input) =>
      generateLoanSchedule(input),
    );
  });
});
```

### Updating Fixtures

Run tests with `UPDATE_GOLDENS=1` to rewrite expected outputs:

```bash
UPDATE_GOLDENS=1 bun vitest run loanSchedule.golden.test.js
```

This workflow is ideal for business-logic regressions where the visual shape of a result matters more than exact implementation.

### Workflow: Adding a New Test Case

1. Create a new fixture pair: `tests/golden/__fixtures__/module/case-name.input.json` + `...expected.json`
2. In `.expected.json`, set `output` to a placeholder (e.g., `null`) or the value you expect
3. Run with `UPDATE_GOLDENS=1` — test framework will compute the actual output and rewrite `.expected.json`
4. Review the generated `.expected.json` to ensure it's correct
5. Commit both fixtures to git

### Calculation Inventory Lock (Phase 8)

The authoritative coverage matrix for every non-trivial calc lives in [[apps/node-backend/tests/golden/INVENTORY.md|tests/golden/INVENTORY.md]]. It enumerates each function in `services/calculations/` with three coverage markers:

- **G** — golden-fixture count (input/expected pairs under `tests/golden/__fixtures__/<module>/`)
- **P** — covered by a property test under `tests/property/*.property.test.js`
- **S** — covered by the aggregation shadow middleware

**Rule:** any new calc (or new aggregation) **must append a row to INVENTORY.md before merge**. A new calc must land with at least one golden input/expected pair; a new aggregation must land registered with the shadow middleware. Fixture drift is intentional only and must be paired with an ADR in the same PR.

See [[docs/testing/testing#Property Test Pattern (Phase 8)|Property Test Pattern]] for invariant-style coverage and [[docs/adr/016-aggregation-shadow-mode|ADR-016]] for the shadow-middleware rollout gate.

---

## Aggregation Envelope Pattern (Phase 2, Updated Phase 1)

**Source:** [[apps/node-backend/src/services/calculations/aggregation/_envelope.js|_envelope.js]], [[apps/node-backend/src/routes/aggregations.js|aggregations.js]]

All `/api/aggregations/*` endpoints follow the unified transport envelope (ADR-026) with a nested aggregation domain envelope. Calculation modules return `{ data, meta: { source, computedAt } }`, and routes pass this directly to `res.ok()`.

### Double-Nested Envelope Structure (Phase 1 Compliance)

Routes use `res.ok({ data, meta })` to nest the aggregation envelope inside the transport envelope. After the frontend unwraps the outer `{ ok, data }` transport layer, consumers receive the inner `AggregationEnvelope<T>`:

```js
// Route handler (aggregations.js)
router.get('/monthly-summary', async (req, res) => {
  const { data, meta } = await computeMonthlySummary({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseIdArrayQueryParam(req.query.excluded_category_ids, 'excluded_category_ids'),
    excludedRecipientIds: parseIdArrayQueryParam(req.query.excluded_recipient_ids, 'excluded_recipient_ids'),
  });
  // Nest domain envelope inside transport envelope
  res.ok({ data, meta });
});

// HTTP Response:
{
  "ok": true,
  "data": {
    "data": { /* calculation result */ },
    "meta": {
      "source": "mv" | "live",
      "computedAt": "2026-04-16T12:34:56.789Z"
    }
  },
  "meta": {
    "requestId": "..."
  }
}

// Frontend receives (after unwrapEnvelope):
{
  data: { /* calculation result */ },
  meta: { source: "mv" | "live", computedAt: "..." }
}
```

### Source Heuristic

The `meta.source` field indicates whether the response was served from a materialized view or computed live.

**Rules:**

1. **Unfiltered request** → `'mv'`
   - No `excluded_category_ids[]`, no `excluded_recipient_ids[]`
   - Fast, from materialized view (stale by ~15 min)
   - Safe for dashboard-level aggregations

2. **Filtered request** → `'live'`
   - At least one `excluded_category_ids[]` OR `excluded_recipient_ids[]` present
   - Slower, dynamically scans transactions
   - Respects user exclusion preferences

3. **Special cases** → Always `'live'`
   - `/average-vs-current` (Phase 2 always computes current-period live)
   - Any endpoint computing "now" relative to historical averages

### Implementation in Calculation Services

```js
// Service: computeMonthlySummary (calculation module)
import { buildEnvelope } from './_envelope.js';
import { getMonthlyFinancialSummary } from '../../repositories/infoRepository.js';

export async function computeMonthlySummary({
  targetCurrency,
  excludedCategoryIds,
  excludedRecipientIds,
}) {
  const hasExclusions = excludedCategoryIds.length > 0 || excludedRecipientIds.length > 0;
  const source = hasExclusions ? 'live' : 'mv';

  const data = await getMonthlyFinancialSummary(
    excludedCategoryIds,
    targetCurrency,
    excludedRecipientIds
  );

  // Return domain envelope; route will nest inside transport envelope
  return buildEnvelope(data, { source });
}
```

### Frontend Consumption

The API client unwraps the outer envelope, so consumers receive the aggregation envelope directly:

```tsx
function DashboardStatCards() {
  const { data: envelope, isLoading } = useQuery({
    queryFn: () => apiClient.getAggregationMonthlySummary({ currency: 'EUR' }),
  });

  if (!envelope) return null;

  // envelope has shape: { data: {...}, meta: { source, computedAt } }
  const isMV = envelope.meta.source === 'mv';
  const freshness = isMV ? '~15 min old' : 'current';

  return (
    <>
      <StatCard title="Monthly Income" value={envelope.data.summary.total_income} />
      <small>{freshness} ({envelope.meta.source})</small>
    </>
  );
}
```

---

## Aggregation Refresh Orchestrator (Phase 1)

**Source:** [[apps/node-backend/src/services/aggregationRefresh.js|aggregationRefresh.js]]

Single entrypoint for refreshing PostgreSQL aggregations (materialized views + trigger-maintained tables).

### Full Refresh (After Bulk Operations)

After bulk imports or mass updates:

```js
import { refreshAggregations } from '../services/aggregationRefresh.js';

// In import service:
await bulkInsertTransactions(transactions);
await refreshAggregations();  // Refreshes all MVs in parallel
logger.info('Aggregations refreshed');
```

**What it does:**
- Refreshes legacy MVs via `materializedViewService.refreshMaterializedViews()`
- Refreshes Phase-1 MVs (`mv_recipient_monthly`) in parallel
- No-op for trigger-maintained tables (automatic updates)

### Debounced Refresh (Single-Row Mutations)

After editing or deleting a transaction:

```js
import { scheduleAggregationRefresh } from '../services/aggregationRefresh.js';

// In transaction route:
app.patch('/api/transactions/:id', async (req, res) => {
  const updated = await transactionService.update(req.params.id, req.body);
  
  // Fire-and-forget debounced refresh
  scheduleAggregationRefresh().catch(err =>
    logger.error('Scheduled refresh failed', { error: err?.message })
  );
  
  res.json(updated);
});
```

**Behavior:**
- Coalesces rapid changes into one refresh (1s debounce)
- Fire-and-forget (doesn't block response)
- Triggers maintain `agg_recipient_totals` and `agg_split_outstanding` automatically

### Exported Surface

```js
import aggregationService, {
  TRIGGER_MAINTAINED_TABLES,  // ['agg_recipient_totals', 'agg_split_outstanding']
} from './aggregationRefresh.js';

await aggregationService.refreshAggregations();
await aggregationService.scheduleAggregationRefresh();
```

---

## Trigger-Maintained Aggregation Tables

**Source:** [[alembic/versions/0035_add_recipient_aggregations.py|Migration 0035]] (consolidated baseline; originally introduced in legacy 0026)

Two tables kept in sync via row-level PostgreSQL triggers. Never require refresh from application code.

### agg_recipient_totals

Running all-time totals per recipient per currency.

**PK:** `(recipient_id, currency)`

**Automatic Updates:** Via `fn_agg_recipient_totals_sync()` trigger on `transactions` (AFTER INSERT/UPDATE/DELETE)

**Important:** Do NOT query inside transaction handlers before triggers fire. If you need fresh totals within the same request, refetch after the transaction commits or read from the MV instead.

```js
// ❌ WRONG: Trigger hasn't fired yet
const txn = await query('INSERT INTO transactions (...) RETURNING *');
const totals = await query('SELECT * FROM agg_recipient_totals WHERE recipient_id = $1', [txn.recipient_id]);
// totals is stale

// ✓ CORRECT: Read after transaction commits or fetch in separate query
const txn = await query('INSERT INTO transactions (...) RETURNING *');
// Now (after transaction commit) the trigger has fired
const totals = await query('SELECT * FROM agg_recipient_totals WHERE recipient_id = $1', [txn.recipient_id]);
```

### agg_split_outstanding

Outstanding balance per split (original minus paid).

**PK:** `split_id`

**Automatic Updates:** Via two triggers:
- `fn_trg_split_sync()` on `transaction_splits`
- `fn_trg_split_payment_sync()` on `split_payments`

**Same caveat:** Triggers fire at transaction commit. If you need immediately-fresh outstanding balances within the request, compute manually instead of reading the aggregate.

```js
// After split_payments insert:
const payment = await query('INSERT INTO split_payments (split_id, amount) VALUES (...) RETURNING *');

// The trigger has now fired. Safe to read:
const outstanding = await query(
  'SELECT outstanding_amount FROM agg_split_outstanding WHERE split_id = $1',
  [payment.split_id]
);
```

### Best Practices

1. **Document trigger-maintained aggregates** — Add a comment in code that reads them:
   ```js
   // Reads agg_recipient_totals; maintained by fn_agg_recipient_totals_sync trigger
   const result = await query('SELECT * FROM agg_recipient_totals WHERE ...');
   ```

2. **Never manually INSERT/UPDATE trigger tables** — Writes bypass triggers and create inconsistency. The triggers are the source of truth.

3. **Verify triggers are enabled** — If aggregates look stale:
   ```sql
   SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid = 'transactions'::regclass
   AND NOT tgisinternal;
   ```

4. **Test trigger firing in DB-backed tests** — Use the `hasTestDatabase()` gate:
   ```js
   import { hasTestDatabase, getTestPool } from './setup/db.js';
   
   describe.skipIf(!hasTestDatabase())('trigger-maintained tables', () => {
     it('syncs agg_recipient_totals on insert', async () => {
       const pool = getTestPool();
       // Insert transaction, verify agg_recipient_totals updated
     });
   });
   ```

---

## Materialized View Availability & Caching Pattern (Bug-Hunt 2026-05-08)

**Source:** [[apps/node-backend/src/repositories/infoRepositoryHelpers.js|infoRepositoryHelpers.js]]

When querying PostgreSQL materialized views that may not exist or may be empty (e.g., after schema creation or migrations), use the `mvAvailable(viewName)` helper with allowlist validation and negative caching.

### Problem

Without caching, checking view existence on every request produces N+1 round-trips under load. Schema migrations may create views asynchronously, and fresh deployments need time to build the first view. Without negative caching, missing views trigger repeated DB queries.

### Solution

```js
import { mvAvailable } from '../repositories/infoRepositoryHelpers.js';

// Always use the helper, never raw SELECT without it
const isCategoryTotalsAvailable = await mvAvailable('mv_category_totals');

if (isCategoryTotalsAvailable) {
  const result = await query('SELECT * FROM mv_category_totals ORDER BY count DESC LIMIT 500');
  // Process result
} else {
  // Fallback: compute inline or return empty set
  return { data: [] };
}
```

### Key Features

1. **Allowlist validation:** View names are pinned in `ALLOWED_MV_NAMES` set (e.g., `'mv_category_totals'`, `'mv_monthly_summary'`) to prevent SQL injection if names ever come from user input.

2. **Positive caching (indefinite):** If a view exists and has rows, the result is cached in-process forever. View existence is a stable schema fact.

3. **Negative caching (60s TTL):** If a view is missing or empty, the result is cached for 60 seconds. This avoids DB round-trips for missing views on every request, but recovers quickly when a view is created.

4. **Cache clearing:** After bulk imports or migrations that recreate views, call `clearMvCache()` to force fresh checks:
   ```js
   import { clearMvCache } from '../repositories/infoRepositoryHelpers.js';
   
   await bulkImportTransactions(rows);
   await refreshAggregations();
   clearMvCache();  // Views now exist; next mvAvailable() call hits DB
   ```

### When to Use

- **Route handlers** that read from views and need fallback paths (e.g., `/api/statistics`)
- **Initialization code** that populates views asynchronously
- **Multi-tenant scenarios** where view existence varies by tenant

### When NOT Needed

- **Trigger-maintained aggregation tables** (`agg_recipient_totals`, `agg_split_outstanding`) — these are always present and maintained by triggers; query directly
- **Hard schema constraints** — if a view is guaranteed to exist (e.g., created at migration time), skip the check

---

## Query Result Bounding (Bug-Hunt 2026-05-08)

**Pattern:** Always add `LIMIT` clause to queries that enumerate unbounded result sets.

### Problem

Queries without `LIMIT` can return unbounded result sets when table size grows unexpectedly. This causes:
- Memory spikes from large result sets in Node.js
- Slow response times for front-end pagination or dropdowns
- Denial-of-service risk from users with large datasets

### Solution

```js
// ❌ WRONG: No limit; can return 10,000+ rows if table grows
const stats = await query('SELECT * FROM transactions ORDER BY date DESC');

// ✓ CORRECT: Explicit LIMIT prevents runaway result sets
const stats = await query('SELECT * FROM transactions ORDER BY date DESC LIMIT 500');

// ✓ CORRECT: Even for aggregations, bound the output
const catStats = await query(
  'SELECT category_id, count, total FROM mv_category_totals ORDER BY count DESC LIMIT 500'
);
```

### Guidelines

| Query Type | Recommended LIMIT |
|------------|------------------|
| Enumerate all items (UI list) | 50–500 (depends on UI viewport) |
| Top-N aggregations | 500 (rarely need more) |
| Full-table scan (e.g., export) | Use pagination or streaming (not LIMIT) |
| Single-row lookups (WHERE id = ...) | No LIMIT needed (indexed) |

### Fallback Path

When applying `LIMIT` to a query for the first time, add a fallback for backwards compatibility:

```js
// Statistics may not have aggregated yet on fresh deployment
if (!isCategoryTotalsAvailable) {
  // Compute or return empty
  return { categories: [], total: 0 };
}

// MV exists; safe to query with LIMIT
const result = await query('SELECT ... FROM mv_category_totals LIMIT 500');
```

---

## Safe CSV Export Pattern (Phase 5+)

**Source:** [[apps/node-backend/src/lib/csv.js|csv.js]] — Shared utility with formula injection guard
**Used in:** [[apps/node-backend/src/routes/transactions.js|transactions.js]], [[apps/node-backend/src/routes/splits.js|splits.js]]

CSV exports must escape field values to prevent formula injection (CWE-1236). A centralized utility ensures all exports are protected.

### Safety Requirement: Formula Injection Prevention

Excel and Google Sheets auto-execute leading `=`, `+`, `-`, or `@` as formulas. Example attack:

```
Cell value: =cmd|'/c powershell IEX(New-Object Net.WebClient).DownloadString(...)'
Result: Arbitrary code execution when file is opened
```

**Solution:** Prefix dangerous leading characters with a single quote (`'`). The spreadsheet renders as literal text.

### Shared Implementation

```js
// apps/node-backend/src/lib/csv.js
const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@']);

export function neutralizeCsvFormula(value) {
  if (!value) return value;
  const trimmedStart = value.trimStart();
  if (!trimmedStart) return value;
  const firstChar = trimmedStart.charAt(0);
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(firstChar)) return value;
  return `'${value}`;  // Prefix dangerous char with '
}

export function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = neutralizeCsvFormula(String(value));
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
```

### Usage in Routes

Import the utility and use it to escape all user-controllable fields before CSV serialization:

```js
import { escapeCsvValue } from '../lib/csv.js';

function buildTransactionCsvRow(row, { includeBalance = false } = {}) {
  const cols = [row.date, row.bank_account, row.recipient_name, row.memo,
                row.amount, row.currency, row.balance, row.category_name, row.comment];
  if (includeBalance) cols.push(row.running_balance);
  return cols.map(escapeCsvValue).join(',');  // ← All fields escaped
}
```

### Streaming Large Exports

For large datasets, stream in fixed-size chunks to keep memory bounded:

```js
const CSV_EXPORT_CHUNK_SIZE = 1000;

router.get('/export/csv', rateLimiter(...), async (req, res) => {
  try {
    // Build filter clauses (dynamic WHERE with parameterized queries)
    const filterClauses = ['t.is_active = true'];
    const params = [];
    let paramIdx = 1;
    // ... add date, category, bank_account filters with params.push() ...

    // Probe for empty results before streaming
    const probe = await dbQuery(
      `SELECT 1 FROM transactions t WHERE ${filterClauses.join(' AND ')} LIMIT 1`,
      params
    );
    if (probe.rows.length === 0) {
      return res.status(404).json({ detail: 'No transactions found' });
    }

    // Set response headers
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=transactions_export_${new Date().toISOString().slice(0, 19)}.csv`);

    // Write CSV header
    res.write('Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment\n');

    // Stream in chunks to bound memory
    let offset = 0;
    while (true) {
      const chunkSql = `
        SELECT t.id, t.date, t.bank_account, 
               COALESCE(pr.name, r.name) AS recipient_name,
               t.memo, t.amount, t.currency, t.balance,
               CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE '' END AS category_name,
               t.comment
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE ${filterClauses.join(' AND ')}
        ORDER BY t.date ASC, t.id ASC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
      
      const chunk = await dbQuery(chunkSql, [...params, CSV_EXPORT_CHUNK_SIZE, offset]);
      if (chunk.rows.length === 0) break;

      const lines = chunk.rows.map(row => buildTransactionCsvRow(row));
      res.write(lines.join('\n') + '\n');
      
      if (chunk.rows.length < CSV_EXPORT_CHUNK_SIZE) break;
      offset += CSV_EXPORT_CHUNK_SIZE;
    }

    res.end();
  } catch (err) {
    logger.error('Error exporting', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Error exporting' } });
    } else {
      res.end();  // Headers already sent, close gracefully
    }
  }
});
```

### Key Points

| Pattern | Rule |
|---------|------|
| **Escaping** | **All fields must use `escapeCsvValue()`** to prevent CWE-1236 formula injection |
| **Chunk size** | 1000–5000 rows per chunk depending on row width; tuned to balance memory + latency |
| **Stable sort** | `ORDER BY date ASC, id ASC` ensures no gaps or duplicate rows across chunks |
| **Probe first** | Check for empty results before streaming headers (early 404 return) |
| **Error recovery** | If headers sent, close gracefully (`res.end()`); otherwise return JSON error |
| **Rate limiting** | Apply per-route limiter to protect DB from concurrent bulk exports |

---

## CSV Record Splitter — Multi-Line Field Handling (Phase C)

**Source:** [[apps/frontend/src/hooks/useCsvPreview.ts|useCsvPreview.ts]]

When parsing CSV import previews on the frontend, naive `split('\n')` fails for multi-line field values enclosed in quotes. A quote-aware record splitter respects RFC 4180 CSV escaping (double-quote inside quoted field = literal quote).

### Problem

```csv
Name,Description,Amount
"John Doe","Multi-line
description here",100.50
"Jane Smith","Single line",200.75
```

Naive split:
```typescript
const records = csvText.split('\n');  // ❌ Splits on line 2, breaking multi-line field
// Result: ["Name,Description,Amount", "\"John Doe\",\"Multi-line", "description here\",100.50", ...]
```

### Solution: Quote-Aware Splitter

```typescript
function splitCsvRecords(csvText: string): string[] {
  const records: string[] = [];
  let currentRecord = '';
  let insideQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];

    if (char === '"') {
      // Check if next char is also a quote (escaped quote in RFC 4180)
      if (csvText[i + 1] === '"') {
        currentRecord += '""';
        i++; // Skip the next quote
      } else {
        // Toggle quote state
        insideQuotes = !insideQuotes;
        currentRecord += char;
      }
    } else if (char === '\n' || char === '\r') {
      if (insideQuotes) {
        // Preserve line break inside quoted field
        currentRecord += char;
      } else {
        // End of record
        if (currentRecord.trim()) records.push(currentRecord);
        currentRecord = '';
        // Skip \r\n sequence
        if (char === '\r' && csvText[i + 1] === '\n') i++;
      }
    } else {
      currentRecord += char;
    }
  }

  // Don't forget last record
  if (currentRecord.trim()) records.push(currentRecord);
  return records;
}
```

### Usage in useCsvPreview

```typescript
const [csvData, setCsvData] = useState<CsvPreviewRow[]>([]);

const handleCsvSelect = (file: File) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target?.result as string;
    // ✅ Use quote-aware splitter
    const records = splitCsvRecords(text);
    
    // Parse header
    const headerRecord = Papa.parse(records[0]).data[0] as string[];
    
    // Parse preview rows (first 10 data rows)
    const preview = records.slice(1, 11).map(record => {
      const parsed = Papa.parse(record).data[0] as string[];
      return headerRecord.reduce((row, header, idx) => {
        row[header] = parsed[idx] ?? '';
        return row;
      }, {} as Record<string, string>);
    });
    
    setCsvData(preview);
  };
  reader.readAsText(file);
};
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Track quote state | Toggle on unescaped `"` character |
| Handle `""` escape | RFC 4180 uses doubled quotes for literal quotes inside quoted fields |
| Preserve line breaks in fields | Only treat `\n` as record boundary when outside quotes |
| Trim empty records | Skip blank lines that parse to empty strings |
| Test with edge cases | Empty quotes `""`, trailing newlines, CRLF line endings |

### When to Use

- **CSV import preview** — Display uploaded CSV with multi-line field support
- **CSV parsing on frontend** — Before sending to backend for validation
- **Excel/Google Sheets exports** — Often contain quoted multi-line cells

---

## Query Parameter Filtering Pattern (Phase C)

**Source:** [[apps/frontend/src/lib/api/helpers.ts|helpers.ts]] — `buildQuery` function

When building query strings, filter out falsy and empty values to keep URLs clean and prevent spurious cache key mismatches.

### Problem

```typescript
// Without careful filtering, query strings include noise and spurious values:
const params = {
  category: 'FOOD:GROCERIES',
  recipient: '',           // Empty string (should be filtered)
  start_date: null,        // Null (should be filtered)
  exclude_splits: false,   // Boolean false (meaningful; should be preserved)
  limit: 50
};

// ❌ Without filtering: ?category=FOOD:GROCERIES&recipient=&start_date=null&exclude_splits=false&limit=50
// ✓ With filtering:    ?category=FOOD:GROCERIES&exclude_splits=false&limit=50
```

### Solution: Value Filtering

```typescript
function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const queryParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.append(key, String(value));
    }
  });
  return queryParams.toString();
}
```

The function preserves `false` boolean values because they represent explicit filter choices (e.g., "exclude splits = false" means "include splits").

### Usage

```typescript
// In a hook
const query = buildQuery({
  limit: 50,
  offset: 0,
  category: selectedCategory || undefined,  // Filtered if undefined
  start_date: filters.startDate || null,   // Filtered if null
  exclude_splits: false,                    // PRESERVED as "false"
});

// Result: ?limit=50&offset=0&exclude_splits=false
// (undefined, null, and empty strings filtered; false values preserved)
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Filter `null` and `undefined` | Prevents `?param=null` or `?param=undefined` strings |
| Filter empty string `''` | Reduces noise; `?param=` is meaningless |
| Preserve `false` | Boolean false is a meaningful filter choice (e.g., "exclude splits = false" means "include splits") |
| Keep `0` | Numeric zero is valid (offset=0, limit=0 are meaningful) |
| Keep `true` | Boolean true is serializable (some APIs use flag params) |
| Use `String()` serialization | Converts values to canonical string form for URLSearchParams |

### When to Use

- **Building API query strings** — Keep URLs clean and readable
- **React Query keys** — Prevent cache mismatches when optional params change
- **Form filters** — User may not fill all fields; omit falsy ones
- **API client methods** — Generic `buildQuery` for all endpoints

---

## Import Batch Concurrency Pattern (Phase 1, Phase 3.1, Phase C)

**Source:** [[apps/node-backend/src/services/importPipeline/index.js|importPipeline/index.js]], [[apps/node-backend/src/services/importPipeline/validate.js|validate.js]], [[apps/node-backend/src/services/importPipeline/commit.js|commit.js]]

> [!info] Phase C Refactor
> Import batch concurrency was consolidated into the unified `importPipeline` orchestrator (Phase C, April 2026). The pattern remains unchanged; the three legacy services are deprecated.

For bulk CSV imports, rows are processed in adaptive concurrent batches to balance throughput against database pool constraints. Concurrency is derived from the pool configuration, not hardcoded, to remain safe across different deployment pool sizes.

### Pattern

```js
// At module scope (import time, not per-request)
// Derive from DB pool config: ensure at least half the pool remains available for other requests
const _poolMax = Math.max(
  parseInt(process.env.DB_POOL_SIZE, 10) || 5,      // Default: 5
  parseInt(process.env.DB_MAX_OVERFLOW, 10) || 10,  // Default: 10
);
const IMPORT_BATCH_SIZE = Math.max(2, Math.floor(_poolMax / 2));
// With stock settings (poolMax=10): IMPORT_BATCH_SIZE=5
// With custom pool (poolMax=50): IMPORT_BATCH_SIZE=25

// In import processing loop
for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
  const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
  
  // Process batch rows in parallel (up to IMPORT_BATCH_SIZE concurrent queries)
  const settled = await Promise.allSettled(
    batch.map(async (row) => {
      // Dedup check
      const isDup = await isDuplicateByFields(row.date, row.amount, row.recipient, row.memo);
      if (isDup) return { dup: true };
      
      // Recipient upsert (single round-trip via INSERT ... ON CONFLICT)
      const recipientId = await getOrCreateRecipient(row.recipient, row.account, row.address, row.bank);
      
      return { dup: false, row: [row.date, row.amount, recipientId, ...] };
    })
  );
  
  // Aggregate results
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      results.errors++;
    } else if (outcome.value.dup) {
      results.duplicates++;
    } else {
      results.imported++;
      pendingInserts.push(outcome.value.row);
    }
  }
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Compute concurrency from pool ceiling | Adapts to deployment config (local dev vs. production) |
| Use `Math.max(2, Math.floor(poolMax / 2))` | Always keep ≥50% of pool for other requests |
| Read env vars at module init | Avoid per-request resolution overhead |
| Default: 5 (for poolMax=10) | Safe for single-user self-hosted deployments |
| Use `Promise.allSettled()` per batch | One bad row doesn't stall the entire batch |
| Preserve insertion order | `pendingInserts` array maintains order across batches |

### When to Use

- **Large CSV imports** (100+ rows) — batching prevents connection pool exhaustion
- **Streaming imports** — backpressure from concurrent batch processing limits memory growth
- **Multi-bank imports** — handles raw data preservation and dedup across multiple tables

### Configuration

```bash
# Stock settings (recommended for local/small deployments)
DB_POOL_SIZE=5           # Min pool size
DB_MAX_OVERFLOW=10       # Max overflow; total poolMax=10
# Result: IMPORT_BATCH_SIZE = Math.max(2, floor(10/2)) = 5

# Production (larger pool)
DB_POOL_SIZE=20
DB_MAX_OVERFLOW=30       # poolMax=30
# Result: IMPORT_BATCH_SIZE = 15 (up to 15 concurrent dedup/recipient checks)
```

---

## SSE Backpressure Pattern (Phase 3.2)

**Source:** [[apps/node-backend/src/lib/sse.js|sse.js]], [[apps/node-backend/src/routes/ai.js|ai.js]], [[apps/node-backend/src/routes/importRoutes.js|importRoutes.js]]

For long-running streaming responses (AI chat, CSV import progress), propagate TCP backpressure from the HTTP client into the server's event-generation loop to prevent unbounded write buffer growth and memory exhaustion.

### Problem

Without backpressure handling:

```js
// ❌ WRONG: Unbounded memory growth if client is slow
while (importing) {
  res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
  // If the client reads slowly, Node.js TCP buffer fills up
  // Memory keeps growing as rows are processed
}
```

Node.js's `res.write()` returns `false` when the internal buffer is full (`res.writableNeedDrain === true`), signaling that the caller should pause. Ignoring this signal causes the write buffer to grow without bound, consuming all available memory.

### Solution

Create a backpressure-aware writer and `await` after each frame:

```js
import { createSseWriter } from '../lib/sse.js';

router.post('/import/csv/stream', async (req, res) => {
  const writer = createSseWriter(req, res);
  
  try {
    // Probe for data...
    
    res.setHeader('Content-Type', 'text/event-stream');
    
    // Import in batches
    for (const batch of batches) {
      for (const row of batch) {
        const { imported, duplicates, errors } = await processRow(row);
        
        // Backpressure-aware write
        await writer.write('progress', {
          imported,
          duplicates,
          errors,
          total: totalRows,
        });
        
        // Early exit if client disconnected
        if (writer.closed) return;
      }
    }
    
    await writer.write('complete', { imported, duplicates, errors });
    writer.end();
  } catch (err) {
    if (!writer.closed) {
      await writer.write('error', { detail: 'Import failed' });
    }
    writer.end();
  }
});
```

### API Reference

#### `drainIfNeeded(res)`

**Returns:** `Promise<void>`

- If `res.writableNeedDrain` is false: resolves immediately (no pause needed)
- If `res.writableNeedDrain` is true: awaits `res.once('drain', ...)` (TCP buffer full)

#### `createSseWriter(req, res)`

**Returns:** `{ closed: boolean, write(event, data): Promise<void>, end(): void }`

| Property | Purpose |
|----------|---------|
| `closed` | Getter that returns `true` if the client disconnected |
| `write(event, data)` | Async. Writes SSE frame if not closed; calls `drainIfNeeded()` after write |
| `end()` | Ends the response if not already ended |

### Implementation Details

```js
export function createSseWriter(req, res) {
  let closed = false;
  // Listen on res only. req is a Readable stream and emits 'close' after the
  // body is consumed by upstream middleware (e.g., express.json()), which would
  // mark the writer closed before any event is emitted. res's 'close' event
  // covers both client disconnects and normal end-of-response.
  if (typeof res?.on === 'function') res.on('close', () => { closed = true; });

  return {
    get closed() { return closed; },

    async write(event, data) {
      if (closed) return;  // No-op if client disconnected
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await drainIfNeeded(res);  // Pause if buffer full
    },

    end() {
      if (!res.writableEnded) res.end();
    },
  };
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Always use `createSseWriter` for streaming | Single source of truth for backpressure and client tracking |
| `await writer.write()` in loops | Critical: pauses production when client can't keep up |
| Check `writer.closed` between writes | Exit early if client disconnected to avoid wasted work |
| Async progress callbacks | Make import/AI callbacks `async` and `await` the `write()` result |
| Call `writer.end()` in finally | Ensures response is always closed, even on error |

### When to Use

- **Long-running SSE streams** (>1 second, >100 events)
- **CSV import with progress** — especially large files
- **AI chat streaming** — token-by-token generation
- **Any endpoint that writes multiple times before closing** — prevents memory leak

### When NOT Necessary

- **Single-shot responses** — normal `res.json()` handles backpressure automatically
- **Small fixed-size responses** — TCP buffer unlikely to fill
- **Webhook events** — if you own the client, size is known

### Testing

```js
import { test, expect } from 'vitest';
import { createSseWriter, drainIfNeeded } from '../lib/sse.js';

test('drainIfNeeded returns immediately when buffer not full', async () => {
  const res = { writableNeedDrain: false };
  const start = Date.now();
  await drainIfNeeded(res);
  expect(Date.now() - start).toBeLessThan(10);  // No pause
});

test('createSseWriter tracks client close', (done) => {
  const req = new EventEmitter();
  const res = { write: () => true, writableEnded: false };
  
  const writer = createSseWriter(req, res);
  expect(writer.closed).toBe(false);
  
  req.emit('close');
  expect(writer.closed).toBe(true);
  
  done();
});
```

---

## Atomic Transaction Pattern (Multi-Step Operations)

**Source:** [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]], [[apps/node-backend/src/repositories/splitRepository.js|splitRepository.js]] (Phase 12 Bugfix Sweep)

For complex operations spanning multiple tables (e.g., merging recipients across transactions, splits, planned transactions, and bank accounts), or for race-sensitive single-table operations (e.g., recording payments against a split with overpayment risk), use explicit transaction control with row-level locking to ensure atomicity and serialize concurrent access.

### Pattern

```js
import { getClient } from '../database/connection.js';

export async function complexMultiStepOperation(primaryId, aliasIds) {
  // Validate inputs
  if (!Number.isInteger(primaryId) || !Array.isArray(aliasIds)) {
    throw new Error('Invalid inputs');
  }

  // Get a dedicated client for transaction control
  const client = await getClient();
  try {
    // Begin transaction
    await client.query('BEGIN');

    // Lock the primary row to serialize concurrent operations
    const primaryCheck = await client.query(
      `SELECT id FROM primary_table WHERE id = $1 FOR UPDATE`,
      [primaryId],
    );
    if (!primaryCheck.rows.length) {
      throw new Error('Primary not found');
    }

    // Step 1: Update first dependent table
    const step1 = await client.query(
      `UPDATE table1 SET primary_id = $1 WHERE primary_id = ANY($2)`,
      [primaryId, aliasIds],
    );

    // Step 2: Update second dependent table
    const step2 = await client.query(
      `UPDATE table2 SET primary_id = $1 WHERE primary_id = ANY($2)`,
      [primaryId, aliasIds],
    );

    // Step 3: Deduplicate via INSERT ... ON CONFLICT (race-safe)
    await client.query(
      `INSERT INTO dedup_table (primary_id, unique_field, data)
       SELECT $1, unique_field, data FROM source_table WHERE id = ANY($2)
       ON CONFLICT (primary_id, unique_field) DO NOTHING`,
      [primaryId, aliasIds],
    );

    // Step 4: Mark aliases as merged
    await client.query(
      `UPDATE primary_table SET primary_reference_id = $1 WHERE id = ANY($2)`,
      [primaryId, aliasIds],
    );

    // Commit all steps atomically
    await client.query('COMMIT');

    return { 
      primaryId, 
      mergedAliasIds: aliasIds,
      reassigned: {
        table1: step1.rowCount,
        table2: step2.rowCount,
      }
    };
  } catch (error) {
    // Rollback on any error — all partial changes discarded
    await client.query('ROLLBACK');
    throw error;
  }
}
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Explicit tx | Use `BEGIN` / `COMMIT` / `ROLLBACK` for control |
| Row locking | Lock primary row with `FOR UPDATE` before updates to serialize concurrent access |
| Dependency order | Update tables in FK dependency order (parents before children or children before parents, as FK constraints dictate) |
| Conflict dedup | Use `INSERT ... ON CONFLICT (uk_fields) DO NOTHING` for race-safe deduplication |
| Error handling | `ROLLBACK` on any error; caller receives clear error message |
| Fallback reads | After `ON CONFLICT DO NOTHING`, use `RETURNING id` or follow-up query to get the inserted-or-existing row ID |
| Validation first | Validate all inputs before `BEGIN` to fail fast |
| No nested txs | PostgreSQL does not support nested transactions (except savepoints); keep transaction boundaries explicit |

### When to Use

- Multi-step operations that must all succeed or all fail
- Operations with race conditions (e.g., deduplication during merge)
- Operations that need to serialize concurrent access (e.g., merging into the same primary)
- Operations that need to roll back partial work on error

### When NOT to Use

- Simple single-statement operations (repositories handle implicit tx)
- Pure calculation services (no DB access)
- Streaming or large-batch operations (explicit chunking may be more efficient)

### PostgreSQL Limitation: FOR UPDATE with GROUP BY

**Problem:** PostgreSQL does not allow combining `SELECT ... GROUP BY ... FOR UPDATE OF table_name` in a single query. Attempting this raises: `ERROR: FOR UPDATE is not allowed with GROUP BY`.

**Solution:** Split into two separate queries within the same transaction:

```javascript
// WRONG: PostgreSQL rejects this
const result = await client.query(`
  SELECT id FROM transactions WHERE id = $1
  GROUP BY id, amount
  FOR UPDATE OF t
`, [transactionId]);

// CORRECT: Separate the lock from the aggregate
const lockResult = await client.query(
  `SELECT id FROM transactions WHERE id = $1 FOR UPDATE`,
  [transactionId]
);
if (lockResult.rows.length === 0) throw new NotFoundError('Transaction not found');

const aggregateResult = await client.query(`
  SELECT ABS(t.amount) AS transaction_total,
         COALESCE(SUM(ts.amount), 0) AS current_split_total
    FROM transactions t
    LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
   WHERE t.id = $1
   GROUP BY t.id, t.amount
`, [transactionId]);
```

Both queries execute within the same transaction, so atomicity is preserved: the lock acquired on the first query holds until `COMMIT`.

**Used in:** [[apps/node-backend/src/repositories/splitRepository.js]] for `createSplitAtomic()` and `createSplitsBatchAtomic()` — lock the transaction row, then aggregate its splits in a separate query to validate allocation before insert.

---

## Motion Consumer Pattern (Phase 9 + June 2026)

**Source:** [[apps/frontend/src/lib/motion.ts|motion.ts]]

All Framer Motion-enabled components must check `useReducedMotion()` and conditionally apply animations to respect OS accessibility settings.

> [!info] PageTransition Re-added (June 2026 — ADR-070)
> `PageTransition.tsx` was removed in 2026-04-17 (ADR-020) and re-added in 2026-06-10 (ADR-070) as an enter-only spring keyed on `location.pathname`. There is no `AnimatePresence` exit — that caused double-renders of React Suspense boundaries around lazy routes. Under `prefers-reduced-motion`, the transition is instant.

> [!info] Dialog Animation Changed (June 2026 — ADR-070)
> Dialog and AlertDialog no longer use framer-motion for their enter/exit. They use CSS `dialog-in`/`dialog-out` keyframes with an overshoot bezier (`cubic-bezier(0.34, 1.45, 0.64, 1)`). `motion-reduce` disables both keyframes. This fixes the Tailwind v4 `translate`-property double-offset bug from the prior `slide-in-from-left-1/2` recipe.

### Pattern

```tsx
import { motion } from 'framer-motion';
import { DURATION_NORMAL, SPRING_SMOOTH, useReducedMotion } from '@/lib/motion';

export function MyAnimatedComponent() {
  const prefersReduced = useReducedMotion();
  
  return (
    <motion.div
      initial={prefersReduced ? {} : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={prefersReduced ? {} : { opacity: 0, scale: 0.90 }}
      transition={prefersReduced ? {} : { duration: DURATION_NORMAL / 1000, ...SPRING_SMOOTH }}
    >
      {/* Content */}
    </motion.div>
  );
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Always check `useReducedMotion()` | Mandatory accessibility compliance for non-essential motion |
| Empty initial/exit when reduced | Simplest way to skip animations entirely (no jank from animation state) |
| Instant transition when reduced | Zero delay, zero animation time |
| Use token-based timing | Never hardcode durations; import from `motion.ts` |
| Only animate transforms/opacity | GPU-accelerated, no layout thrashing |
| Centralize motion configs | New patterns go into `motion.ts`, not scattered in components |

### Use Cases

| Pattern | Duration | Timing | When |
|---------|----------|--------|------|
| Dialog enter | 300ms | SPRING_SMOOTH | Modal overlay, form dialog |
| Dialog exit | 200ms | ease-out-cubic | Dismissal or cancel |
| Page transition | 300ms enter, 200ms exit | SPRING_BOUNCE | Route change |
| Hover elevation | 150ms | ease-out-cubic | Card, button hover state |
| Micro-interaction | 150ms | ease-out-expo | Icon action, toggle state |
| Loading pulse | 1.5s | ease-in-out | Skeleton screens (opacity only) |
| Fade in | 200-300ms | ease-out-cubic | Content appearance |

---

## Surface Shell Pattern (Phase 9 + June 2026)

**Source:** [[apps/frontend/src/components/ui/card.tsx|card.tsx]], [[apps/frontend/src/components/dashboard/StatCard.tsx|StatCard.tsx]], [[apps/frontend/src/components/layout/AppLayout.tsx|AppLayout.tsx]]

Standard card and surface shell for consistent material hierarchy and visual cohesion.

> [!info] Updated June 2026 — ADR-070 + role-based glass broadening (June 2026, no ADR yet)
> The canonical card material rule changed in two steps. Step 1 (ADR-070): `surface-elevated … bg-card backdrop-blur-sm` replaced by the glass vocabulary below; `premium-frame` baked into base `Card`. Step 2 (June 2026): the narrow "only ~6 KPI/hero/chart surfaces" rule was broadened to role-based glass — ALL content/chart/stat/state cards now carry `glass-regular`. See the note in [[docs/components/ui-components#surface-styling-liquid-glass-v2-june-2026|UI Components — Surface Styling]] for full rationale. A future ADR may formalize this.

### Canonical Card Material Rule (June 2026, role-based)

| Surface type | Class | Notes |
|---|---|---|
| Content / chart / stat / state card | `glass-regular` | ALL cards in these roles — peers must shine consistently (role-based glass, June 2026) |
| Dashboard hero card | `glass-elevated` | 32px blur + saturate; trend tint in overlay child |
| Table container (DataTable / VirtualDataTable / Watchlist / pivot/summary/RatesTable) | opaque (no glass class) | Dense row rendering; GPU budget exemption |
| Dense form/import card | opaque | Intentional flat surface |
| Dashed "add" placeholder card | opaque | `bg-muted/30 border-dashed` — flat by design |
| Accent/danger callout card | opaque | `bg-primary/5` / `bg-destructive/5` — colored tint defeats glass |
| Card nested inside a glass dialog | opaque | Avoids double-blur (e.g., `InvestmentDetailDialog` inner cards) |
| Modal dialog | `glass-thick` | Handled by the base Dialog component |
| Toast | `glass-thick` | Handled by Sonner |
| Navigation chrome | `glass-chrome` | Handled by AppLayout/AppSidebar |

`premium-frame` is baked into the base `Card` component — you no longer need to add it as a className. Both `premium-frame` and `micro-lift` declare identical full `transition` lists (border-color, box-shadow, transform) so whichever class wins the cascade still animates all three properties.

> [!warning] GPU trade-off (card-dense pages)
> Card-dense pages (e.g., PortfolioOverviewPage, StatisticsPage) now have more active `backdrop-filter` surfaces per viewport than the old ~6-surface budget. This is mitigated by ADR-075 tier auto-adapt: glass auto-degrades to near-opaque on large displays (`fx-reduced` class via `VisualEffectsController`) and under `prefers-reduced-transparency`. Profile the packaged Electron app on Apple Silicon before each release to catch regression.

### Pattern

```tsx
// Content / chart / stat card (most common — role-based glass)
<Card className="glass-regular micro-lift">
  {/* Content — premium-frame hover outline included automatically from Card base */}
</Card>

// State cards (loading/empty/error) also get glass-regular for peer consistency
<Card className="glass-regular">
  <EmptyState ... />
</Card>

// Dashboard hero card (income/net summary)
<Card className="glass-elevated micro-lift">
  {/* Trend tint as overlay child, not on the card itself */}
  <div className="absolute inset-0 opacity-30 bg-gradient-to-br from-primary/20 to-transparent pointer-events-none" />
  {/* Content */}
</Card>

// Opaque table container (role-based exception — dense rows)
<Card>
  <DataTable ... />  {/* No glass class — tables stay opaque */}
</Card>

// Glass surface (dialogs, overlays — handled by Dialog component)
<div className="relative overflow-hidden glass-thick rounded-lg border border-white/10">
  {/* Content */}
</div>

// Navigation chrome
<div className="glass-chrome border-r border-white/10">
  {/* Sidebar content */}
</div>
```

### Utilities Breakdown

| Utility | Purpose |
|---------|---------|
| `glass-regular` | Content/chart/stat/state cards — 20px blur + saturate |
| `glass-elevated` | Hero cards — 32px blur + saturate + lensing edges |
| `glass-thick` | Modal dialogs, toasts — 28px blur + saturate |
| `glass-chrome` | Sidebar/topbar navigation — 24px blur + saturate |
| `glass-thin` | Subtle elements — 12px blur + saturate |
| `premium-frame` | Primary-tinted hover outline (baked into Card base since ADR-070) |
| `micro-lift` | Hover transform: `translateY(-2px)` + shadow increase |
| `group` | Parent selector for hover states affecting children |
| `overflow-hidden` | Clip rounded corners (important for glass + grain texture) |
| `border border-white/10` | Subtle highlight rim at 10% white opacity |

### Gradient Icon Tile Pattern (Phase 9 + June 2026)

**Source:** [[apps/frontend/src/pages/DashboardPage.tsx|DashboardPage.tsx]], [[apps/frontend/src/components/dashboard/StatCard.tsx|StatCard.tsx]]

Summary cards and stat tiles use a glass-elevated or glass-regular card with a tint overlay child for hero emphasis. The gradient lives in an overlay child (not on the card background) so it survives the `backdrop-filter` cascade.

#### Canonical approach: `<TrendHue>` (2026-06-24)

The shared `TrendHue` component (see [[docs/components/shared-components#trendhue|TrendHue]]) is the single source of truth for the diagonal card-hue wash on all summary/stat cards. Use it instead of inlining a gradient div:

```tsx
import { TrendHue } from "@/components/shared/TrendHue";

// Summary/stat card with gain/loss/neutral tint
<Card className="glass-elevated micro-lift relative overflow-hidden">
  <TrendHue variant="gain" />   {/* or "loss" or "neutral" */}
  <CardContent className="relative flex items-center gap-3">
    {/* ... */}
  </CardContent>
</Card>
```

`TrendHue` renders `bg-gradient-to-br from-{gain|loss|primary}/10 to-.../5` as an `absolute inset-0 pointer-events-none rounded-[inherit]` overlay — structurally identical to the manual div pattern below, but token-reactive and DRY.

**Do not inline a gradient div on new summary cards.** Use `<TrendHue>` instead. The old inline pattern is shown only for reference:

```tsx
<Card className="glass-elevated micro-lift relative">
  {/* Tint overlay as child — not on the card background itself */}
  <div className="absolute inset-0 opacity-30 bg-gradient-to-br from-primary/20 to-transparent pointer-events-none rounded-[inherit]" />
  <CardContent className="relative flex items-center gap-3">
    <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-emerald-400/30 via-transparent to-primary/20 flex items-center justify-center">
      <TrendingUpIcon className="h-6 w-6 text-emerald-400" />
    </div>
    <div>
      <p className="text-sm text-muted-foreground">Monthly Income</p>
      <p className="text-2xl font-semibold">€4,250</p>
    </div>
  </CardContent>
</Card>
```

#### Colour-role rule for summary/stat cards (2026-06-24)

| Surface | Rule |
|---|---|
| Card background tint | `<TrendHue variant="gain|loss|neutral" />` — gain/loss/neutral at 0.10 opacity; **neutral border always** (no gain/loss border) |
| Featured total headline (net worth, portfolio total, total value) | `text-primary` |
| Directional figures (return %, gain/loss amounts) | `amount-gain` / `amount-loss` |
| Component figures (cost basis, unrealized, realized) | `text-foreground` (neutral) |

> [!info] The gain/loss coloured BORDER on `PerformancePage` CompactReturnCard and TotalValueCard (previously via `liquid-glass-trend-up/down`) was removed in the 2026-06-24 consistency pass. The card hue is retained via `<TrendHue>`; the coloured border is gone everywhere for consistency. The `glass-trend-up`, `glass-trend-down`, `liquid-glass-trend-up`, and `liquid-glass-trend-down` CSS classes have been deleted from `index.css`.

### Key Rules

| Rule | Rationale |
|------|-----------|
| Always use `overflow-hidden` with rounded corners | Prevents gradient overflow; clips grain texture properly |
| Do NOT put `premium-frame` on `<Card>` manually | It is now baked into the Card base class |
| Use `glass-regular` for ALL content/chart/stat/state cards | Role-based glass (June 2026) — peer cards must shine consistently; the old "~6 surfaces" limit is superseded |
| Use `glass-elevated` for hero/summary cards | Max-tier material for dashboard emphasis |
| Tables, forms, placeholders, and callout cards stay opaque | Role-based exceptions — see table above |
| Cards nested in glass dialogs stay opaque | Avoid double-blur |
| Tint overlay as child, not on card bg (`<TrendHue>` or manual div) | `backdrop-filter` shorthand resets `background`, silently defeating tints set on the card itself |
| Gradient icons muted opacity (20-40%) | Ensure text contrast and readability |
| Summary card tint via `<TrendHue>`, not inline divs | Single source of truth; token-reactive with `--gain`/`--loss` toggle |

---

## Optimistic Mutation Pattern (Frontend, June 2026 — ADR-070)

**Source:** [[apps/frontend/src/hooks/useTransactions.ts|useTransactions.ts]], [[apps/frontend/src/hooks/__tests__/useOptimisticTransactions.test.tsx|useOptimisticTransactions.test.tsx]]

Use this pattern for mutations where instant perceived feedback matters and rollback on error is required. Implemented for `useUpdateTransaction` and `useDeleteTransaction` in ADR-070 Tier 5.

### Pattern

```typescript
export function useUpdateTransaction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: TransactionUpdate }) =>
      apiClient.updateTransaction(id, data),

    onMutate: async ({ id, data }) => {
      // 1. Cancel any in-flight refetches so they don't overwrite optimistic data
      await queryClient.cancelQueries({ queryKey: ['transactions'] });

      // 2. Snapshot all matching cache entries
      const snapshots = queryClient.getQueriesData<TransactionListResponse>({
        queryKey: ['transactions'],
      });

      // 3. Apply optimistic update across all ['transactions', params] caches
      //    NOTE: ['transactions-virtual'] is intentionally NOT patched here
      queryClient.setQueriesData<TransactionListResponse>(
        { queryKey: ['transactions'], exact: false },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((tx) =>
              tx.id === id
                ? { ...tx, ...data, tags: tx.tags }  // tags excluded from merge
                : tx,
            ),
          };
        },
      );

      return { snapshots };  // context passed to onError
    },

    onError: (_err, _vars, context) => {
      // 4. Roll back all patched caches on error
      if (context?.snapshots) {
        for (const [queryKey, data] of context.snapshots) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },

    onSettled: () => {
      // 5. Always invalidate so server truth wins after settlement
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| `cancelQueries` before `setQueriesData` | Prevents an in-flight refetch from overwriting the optimistic state |
| Snapshot with `getQueriesData` | Returns all matching cache entries (not just the most recent) |
| `setQueriesData` with `exact: false` | Patches all `['transactions', params]` variants (different pages, filters) |
| Exclude `['transactions-virtual']` | `useTransactionListData` mirrors its first page to local state; patching would collapse the scrolled list |
| Exclude `tags` from merge | Payload carries `string[]` slugs; cache holds `Tag[]` objects; shapes differ |
| Rollback via snapshot | Restore every key from the snapshot in `onError` |
| Invalidate in `onSettled` | Always refetch after success OR error so server truth wins |

### When to Use

- **Mutations that change values the user just edited** — amount, category, memo on a visible list row.
- **Deletions** — row should disappear instantly; if the request fails, it reappears.
- **Any mutation where a ~200–500ms network delay would produce visible "lag"** on a live list.

### When NOT to Use

- **Bulk mutations** — diff against large snapshots is expensive; invalidate after settle instead.
- **Mutations with derived fields** — e.g., `category_name` / `recipient_name` (only the id is in the payload). The optimistic row will show the stale name until `onSettled` refetches. This is acceptable when the amount/date/memo are correct.

> [!note] Optimistic Creates are supported (Premium v3)
> `useCreateTransaction` now performs optimistic inserts using a temp negative id (`-Date.now()`). The pattern is: `onMutate` inserts the temp row at head of `['transactions']` caches; `onSuccess` swaps temp→server row; `onError` removes temp row + rollback; `onSettled` invalidates. The `['transactions-virtual']` exclusion still applies. See [[docs/components/hooks#optimistic-create-premium-v3-june-2026-adr-071|useTransactions — Optimistic Create]].

### Virtual List Exception

`['transactions-virtual']` is not patched optimistically. `useTransactionListData` keeps the virtual list's first-page cache entry mirrored into local React state. Patching the cache key mid-scroll would cause the list to collapse. The `onSettled` invalidation corrects it.

---

## Chart Scrub and Sync Pattern (Premium v3, June 2026)

### Scrub-to-Compare

`AreaChart` and `LineChart` accept a `scrubbable?: boolean` prop. To add scrub to a new chart:

```tsx
import { useChartScrub, formatScrubDelta } from '@/components/charts/scrub';

// Inside chart component
const { scrubRange, handlePointerDown, handlePointerMove, handlePointerUp } = useChartScrub(data, xScale);

// The hook suppresses tooltip while scrubbing
// A glass Δ pill div is rendered over the chart when scrubRange is non-null
```

Key rules:
- Use pointer events (not mouse events) — works on desktop and touch.
- Use `setPointerCapture` on pointer-down so drags work even when the pointer leaves the SVG.
- Suppress `ChartTooltip` while `scrubRange !== null`.
- Render the Δ pill with `formatScrubDelta(start, end)` — returns `{ abs, percent }`.

**Enabled on:** CashFlowComparisonChart, ForecastInner, ForecastInnerRolling, BankBalancesWidget, PerformancePage, NetWorthChart.

### Synced Crosshairs

Wrap a group of time-series charts in `ChartSyncProvider` and give each chart the same `syncId`:

```tsx
import { ChartSyncProvider } from '@/components/charts/ChartSyncContext';

// In DashboardPage
<ChartSyncProvider>
  <CashFlowComparisonChart syncId="dashboard-timeline" ... />
  <BankBalancesWidget syncId="dashboard-timeline" ... />
</ChartSyncProvider>
```

Inside each chart, `useChartSync(syncId)` provides the shared hovered x-key and a setter. Charts must implement a **domain guard**: if the hovered x-key falls outside the chart's own domain, show no crosshair (prevents edge-pinning across disjoint timelines).

**BarChart (categorical):** Excluded — band scale is not compatible with this mechanism.

---

## Zustand Store Pattern (Frontend, Phase 4)

**Source:** [[apps/frontend/src/stores/settingsStore.ts|settingsStore.ts]]

Use Zustand for client state that spans multiple pages or contexts. Vision uses Zustand to unify settings state (app settings, dashboard settings, theme) that previously required three separate React contexts.

### Pattern

```typescript
import { create } from 'zustand';

interface AppState {
  // State slices
  count: number;
  settings: Record<string, any>;

  // Actions
  increment: () => void;
  updateSettings: (updates: Partial<Record<string, any>>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  count: 0,
  settings: {},

  increment: () => set((state) => ({ count: state.count + 1 })),
  updateSettings: (updates) =>
    set((state) => ({
      settings: { ...state.settings, ...updates },
    })),
}));
```

### Slice Selection with useShallow (Best Practice)

When using multiple slices in a component, use `useShallow()` to prevent re-renders when unrelated slices change:

```typescript
import { useShallow } from 'zustand/react'; // v4.5+

// AVOID: Re-renders if ANY part of state changes
const settings = useAppStore((s) => s.settings);
const count = useAppStore((s) => s.count);

// PREFER: Only re-renders if this slice changes
const slice = useAppStore(
  useShallow((s) => ({
    settings: s.settings,
    count: s.count,
  }))
);
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Store for cross-page state only | Local component state → useState; UI state → Context |
| Use `useShallow()` for multiple selections | Prevents unrelated updates from triggering re-renders |
| Actions mutate immutably | Always spread objects: `{ ...state, field: value }` |
| Split large stores into slices | Keep each store <200 LOC; use multiple stores if needed |
| Pair with Context wrappers | Zustand for state, Context Providers for side-effects (hydration, persistence) |

### When to Use

- Settings/preferences that affect multiple pages
- Theme state across the app
- User session data
- Multi-page forms with shared draft state

### When NOT to Use

- **Local UI state** — Use `useState` instead
- **Server data** — Use React Query
- **Form state** — Use `useFormState()` hook or React Hook Form

---

## Feature Flag Pattern (Deprecated)

> [!warning] Deprecated
> This pattern was removed via [[docs/adr/035-remove-feature-flags|ADR-035]]. The `feature_flags` table, backend service/repo, and admin UI were deleted in Phase 9. All features are now always enabled unconditionally.

**Removal Date:** 2026-04-24

**Historical Reference:** The pattern documented runtime-toggleable feature flags via a `feature_flags` PostgreSQL table with admin endpoints to toggle flags. In practice, no flags were ever toggled off in production; the system added maintenance surface without delivering value.

**Migration Path:** Alembic migration `0011_drop_feature_flags` drops the table while preserving the creation migration (`0002_feature_flags.py`) in the history for audit/compliance purposes.

**For New Features:** If you need to control feature availability, use environment variables or configuration instead of database-backed toggles. See [[docs/adr/035-remove-feature-flags|ADR-035]] for rationale.

---

## Scoped-Skin Behind a Flag Pattern (ADR-104)

**Source files:**
- `[[apps/frontend/src/lib/env.ts]]` — flag declaration via `booleanEnv`
- `[[apps/frontend/src/lib/skin.ts]]` — activation logic
- `[[apps/frontend/src/main.tsx]]` — pre-render call
- `[[apps/frontend/src/styles/skin-v2.css]]` — scoped overrides

This pattern ships an **alternative visual skin** as a CSS file that is completely inert when a root class is absent, toggled by a build-time env flag with a `localStorage` runtime override. Implemented for the "dense-fintech" skin-v2 redesign (ADR-104).

### When to use

Use this pattern when a visual redesign is large enough to ship incrementally, needs side-by-side comparison with the production aesthetic, and must have a guaranteed rollback path that does not require a code change.

### Parts

**1. Register the flag (ADR-030 env schema)**

```ts
// apps/frontend/src/lib/env.ts
VITE_SKIN_V2: booleanEnv(false),   // default OFF
```

Export a named constant:

```ts
export const isSkinV2Default = env.VITE_SKIN_V2 as boolean;
```

**2. Activation module**

```ts
// apps/frontend/src/lib/skin.ts
const STORAGE_KEY = 'vision_skin_v2';
const ROOT_CLASS  = 'skin-v2';

export function isSkinV2Active(): boolean {
    try {
        const override = localStorage.getItem(STORAGE_KEY);
        if (override === 'true')  return true;
        if (override === 'false') return false;
    } catch { /* SSR / private mode */ }
    return isSkinV2Default;   // build-time flag
}

export function applySkinV2Class(): void {
    document.documentElement.classList.toggle(ROOT_CLASS, isSkinV2Active());
}

export function setSkinV2(on: boolean | undefined): void {
    try {
        if (on === undefined) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, String(on));
    } catch {}
    applySkinV2Class();
}

// Dev-mode escape hatch — never ships in production
if (import.meta.env.DEV) {
    (window as any).__setSkinV2 = setSkinV2;
}
```

**3. Call before first render**

```ts
// apps/frontend/src/main.tsx
import { applySkinV2Class } from './lib/skin';
applySkinV2Class();   // must run before createRoot / render
```

**4. UNLAYERED CSS scoped under the root class**

```css
/* apps/frontend/src/styles/skin-v2.css  — imported AFTER `@import "tailwindcss"` */
/* No @layer wrapper — unlayered rules win over all Tailwind layers by cascade order. */

:root.skin-v2 {
    --radius: 0.5rem;
    /* structural token overrides ... */
}

:root.skin-v2 .glass-regular {
    background: hsl(var(--card));
    /* override Tailwind utilities without specificity tricks */
}
```

> [!warning] Cannot override color tokens from CSS
> `applyThemePalette()` in `apps/frontend/src/styles/themes.ts` writes all color tokens (`--background`, `--card`, `--primary`, `--accent`, and every key in `ThemeTokens`) as **inline styles** on `document.documentElement` via `element.style.setProperty()`. Inline styles always win over external stylesheet rules. Any skin CSS that tries to change a color token will be silently ignored. Only structural tokens that `applyThemePalette()` does not touch (radius, blur sizes, aurora alphas, motion durations/easings) can be overridden from CSS.

> [!info] Exception: `--gain` and `--loss` are CSS-overridable (2026-06-24)
> `--gain` and `--loss` are defined in `tokens.css` (not by `applyThemePalette()`), so `skin-v2.css` **can** override them. These are the only color-bearing tokens that are safely overridable from CSS. `skin-v2.css` overrides only these two tokens to apply the Okabe-Ito colorblind-safe palette; all other color overrides still require `themes.ts` changes.
>
> **Gain/loss contributor rule**: any gain/loss-semantic color must use `.amount-gain`/`.amount-loss`, the `gain`/`loss` Tailwind utilities (`text-gain`, `bg-loss/12`, etc.), or `hsl(var(--gain))`/`hsl(var(--loss))` — never raw `text-success`/`text-destructive`/`text-accent`.

**5. Gating component branches (Phase 3+)**

When a skin change requires JSX changes (not pure CSS), gate it behind `isSkinV2Active()` so the flag-off path is byte-identical to the legacy code:

```tsx
import { isSkinV2Active } from '@/lib/skin';

function AmountCell({ value }: { value: number }) {
    const sign = value >= 0 ? '+' : '−';
    if (isSkinV2Active()) {
        // skin-v2: always show +/− and arrow, use --gain/--loss tokens
        return <span className="gain-loss" data-positive={value >= 0}>{sign}{format(value)}</span>;
    }
    // legacy: unchanged
    return <span>{format(value)}</span>;
}
```

### Rollback

- **Per-user (dev)**: `window.__setSkinV2(false)` or clear `vision_skin_v2` from localStorage.
- **Build-level**: set `VITE_SKIN_V2=false` (or remove the env var; default is `false`).
- **Emergency**: with Phases 0–2 CSS-only, removing the `.skin-v2` class from `<html>` restores the production aesthetic with zero JS change.

### Related

- [[docs/adr/104-skin-v2-dense-fintech-visual-redesign|ADR-104]] — decision and design constraints
- [[docs/adr/030-frontend-env-schema|ADR-030]] — `booleanEnv` and the env-schema pattern
- [[docs/adr/103-per-account-holdings-ui-flag|ADR-103]] — precedent for `booleanEnv` feature flags
- [[docs/adr/035-remove-feature-flags|ADR-035]] — why database-backed flags were removed

---

## Number Parsing Pattern: parseLocaleNumber

**Source:** `[[apps/frontend/src/utils/currency.ts]]`

`parseLocaleNumber` intelligently parses user-entered numeric strings that may use either comma-as-decimal (EU format) or period-as-decimal (US format), plus handles currency symbols, whitespace, and negative numbers. Returns `NaN` for unparseable input.

### Heuristic Rules

The function disambiguates locale formats by examining the position of commas and dots:

1. **Both comma and dot present:** rightmost wins as decimal separator
   - `"1,234.56"` → `1234.56` (dot is rightmost → decimal)
   - `"1.234,56"` → `1234.56` (comma is rightmost → decimal)

2. **Only comma, non-3-digit tail:** comma is decimal
   - `"1,5"` → `1.5` (2 digits after comma → EU format)
   - `"1,99"` → `1.99` (2 digits after comma → EU format)

3. **Only comma, exactly 3-digit tail:** comma is thousands separator (US format)
   - `"1,000"` → `1000` (3 digits after comma → US thousands)
   - `"5,000"` → `5000`
   - `"999,000"` → `999000`
   - `"12,345,500"` → `12345500` (multiple commas with 3-digit tail → all commas are thousands)

4. **No comma or dot:** direct parse
   - `"42"` → `42`

### Pre-Processing

Before heuristic evaluation:
- Strip leading/trailing whitespace
- Remove internal whitespace
- Strip currency symbols (`$`, `€`, `£`, `¥`)
- Handle negative indicators: prefix `-` or parentheses `(value)` = negative
- A leading `+` is stripped but does not flip sign

### API

```typescript
parseLocaleNumber(input: string | number | null | undefined): number
```

**Returns:** Parsed number or `NaN` if unparseable.

### Examples

```typescript
// US formats
parseLocaleNumber("1,234.56")      // → 1234.56
parseLocaleNumber("1,000")         // → 1000 (single-comma thousands)
parseLocaleNumber("12,345,500")    // → 12345500

// EU formats
parseLocaleNumber("1.234,56")      // → 1234.56
parseLocaleNumber("1,50")          // → 1.5

// With currency symbols and whitespace
parseLocaleNumber("$ 1,234.56 ")   // → 1234.56
parseLocaleNumber("€1,50")         // → 1.5

// Negatives
parseLocaleNumber("-42.50")        // → -42.5
parseLocaleNumber("(42.50)")       // → -42.5

// Invalid
parseLocaleNumber("")              // → NaN
parseLocaleNumber("abc")           // → NaN
parseLocaleNumber(null)            // → NaN
parseLocaleNumber(undefined)       // → NaN

// Numbers pass through unchanged
parseLocaleNumber(42.5)            // → 42.5
parseLocaleNumber(-7)              // → -7
parseLocaleNumber(0)               // → 0
```

### Bug Fix (2026-05-08)

**Issue:** Single-comma values with exactly 3 digits after the comma (e.g., `"1,000"`) were incorrectly treated as decimal instead of thousands separator, returning `1` instead of `1000`.

**Root Cause:** The condition was `if (tail === 3 && s.indexOf(',') !== lastComma)` — the second clause excluded single-comma cases by requiring at least two commas.

**Fix:** Simplified to `if (tail === 3)` — any comma with exactly 3 digits after it is now treated as a US thousands separator, regardless of whether there are other commas. Test coverage added: `parseLocaleNumber("1,000")`, `parseLocaleNumber("5,000")`, `parseLocaleNumber("999,000")`.

### Usage Sites

Primary usage: transaction amount input dialogs and CSV import amount parsing where users may be in any locale.

---

## Percent Formatting Pattern

**Source:** `[[apps/frontend/src/utils/currency.ts]]` (`formatPercent`)

Every user-facing percentage goes through `formatPercent` so it picks up the same
decimal separator as the money beside it. Before this existed, ~55 sites
string-concatenated `toFixed()`, which always emits a dot — a Belgian user on the
default `eu` number format saw `1.234,56 €` next to `12.5%` on the same card.

```typescript
import { formatPercent } from "@/utils/currency";

formatPercent(12.5)                                  // "12,5%"  (eu) / "12.5%" (us)
formatPercent(-3.2, { digits: 1, signed: true })     // "-3,2%"
formatPercent(60, { digits: 1, minDigits: 0 })       // "60%"    ("up to" 1 decimal)
```

**Value scale — percent units, never fractions.** `12.5` means 12.5%. Call sites
holding a fraction scale at the boundary (`formatPercent(v * 100, …)`), exactly as
they did before their `toFixed`. The helper deliberately does *not* use
`Intl` `style: 'percent'`, so there is no hidden ×100 to get wrong.

**Why `decimal` + a literal `%` instead of `style: 'percent'`.** The locale here is a
number-format proxy, not the user's language: `numberFormatToLocale` maps the `eu`
setting to `de-DE` purely for `1.234,56` grouping, while the app's languages are
en/nl. `style: 'percent'` would drag German typography along with the separator and
render `12,5 %` (non-breaking space), wrong for both languages and enough to reflow
the tight delta chips. Same trap `ForecastInnerRolling` documents for month names —
take the locale's number shape, not its unit typography.

**Sign.** `signed: true` maps to `signDisplay: 'exceptZero'`, the convention
`formatCurrency` / `useCurrencyPartsFormatter` already use for money, so a gain/loss
percent and the amount next to it agree about what a zero looks like. This inherits
the known `exceptZero` pitfall (a loss rounding to zero prints `0,0%` and loses its
minus) — but inherits it *identically* to its money sibling, which is the point.
Don't move one site to `always`/`auto` without moving its money sibling too.

**Digits.** Gain/loss deltas on portfolio holdings use signed 1dp. Market-quote day
moves keep 2dp (domain convention). Rate readouts (tax rates, allocation shares)
keep whatever precision their surface already showed.

---

## Compact Currency Formatting Pattern

**Source:** `[[apps/frontend/src/utils/currency.ts]]`, `[[apps/frontend/src/hooks/useChartCurrencyFormatter.ts]]`

Large monetary totals in headline slots (dashboard cards, statistics tables) abbreviate automatically when the full formatted string exceeds 9 characters. Full precision is preserved in a native `title` tooltip. No user-configurable toggle — always on.

### Utility Function

```typescript
import { formatCurrencyCompact } from "@/utils/currency";

const result = formatCurrencyCompact(1_253_632, "EUR", "en-US", 2);
// result.display  → "$1.3M"    (compact, shown in UI)
// result.full     → "$1,253,632.00"  (full, shown on hover)
// result.isCompact → true
```

`CompactFormatResult`:
```typescript
export interface CompactFormatResult {
  display: string;   // compact if full > 9 chars AND compact is shorter, else full
  full: string;      // always full-precision
  isCompact: boolean;
}
```

Threshold constant: `COMPACT_LENGTH_THRESHOLD = 9`. Guard: if `compact.length >= full.length`, returns full (avoids mid-range values where compact is paradoxically longer).

### Hook Usage (Preferred)

```tsx
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";

function HeadlineCard({ amount }: { amount: number }) {
  const { formatCompact } = useChartCurrencyFormatter();
  const r = formatCompact(amount);
  return <span title={r.isCompact ? r.full : undefined}>{r.display}</span>;
}
```

`formatCompact` is bound to the current user locale and currency from `AppSettingsContext` — no need to pass currency/locale explicitly.

### Render Pattern

- Attach `title` **only when `isCompact` is true** — avoids redundant tooltip on full-precision renders.
- Use `tabular-nums` class alongside compact values in tables for alignment consistency.
- In animated count-up contexts (`useCountUp`), pass `formatValue={r => formatCompact(r).display}` and a static `titleValue={r.isCompact ? r.full : undefined}` computed once from the final value (not every animation frame).

### Scope

Apply compact formatting to headline / summary slots only:
- Dashboard: `NetSummaryCard`, `BankBalancesWidget`, `StatCard` (income/spending/net cards)
- Statistics: `SummaryCards`, `YearlySummaryTable`, `CategoryPivotTable` (grand-total row/column only)

**Out of scope:** portfolio cards, transactions table rows, per-cell values inside `CategoryPivotTable` body (preserve full precision there).

---

## Portfolio Totals Pattern (Phase 14)

> [!important] Single Source of Truth
> **Rule**: Any future UI surface displaying portfolio totals (total value, invested, gain/loss, return %) MUST source from `/api/info/portfolio-summary` endpoint, NOT recompute client-side or fetch raw investments + do FX manually.

### Problem It Solves

Prior to Phase 14, dashboard and performance page computed portfolio totals via different code paths with different FX timing, causing visible divergence:

- Dashboard: loop over investments, convert each to target currency at request time
- Performance page: use pre-computed snapshots with FX rates from snapshot creation time (stale)

Result: Same portfolio, different totals on two pages (e.g., EUR 100,000 vs EUR 99,999.50).

### Pattern

**Backend (`portfolioSummaryService.js`):**

```javascript
/**
 * Compute realtime portfolio totals for a target currency.
 * All FX conversion applied server-side before serialization.
 * @param {string} targetCurrency - Target currency code (default: EUR)
 * @returns {Promise<object>}
 */
export async function getPortfolioSummary(targetCurrency = 'EUR') {
  // 1. Fetch all active investments with current prices
  const investments = await investmentRepository.getAll();
  
  // 2. Group by asset class
  // 3. For each group: aggregate values in their native currency
  // 4. Convert group totals to target currency (single FX call per group, not per investment)
  // 5. Return { currency, computed_at, totals, summaries }
  //
  // Invariant: sum(summaries[].currentValue) === totals.currentValue
}
```

**Frontend Hook:**

```typescript
// apps/frontend/src/hooks/portfolio/usePortfolioSummary.ts
export function usePortfolioSummaryQuery(currency = 'EUR') {
  return useQuery({
    queryKey: ['portfolio-summary', currency],
    queryFn: () => apiClient.getPortfolioSummary({ currency }),
    staleTime: 60_000, // 60 second TTL matches backend cache
    retry: 1,
  });
}
```

**Consumer (Dashboard):**

```typescript
function PortfolioOverviewPage() {
  const { data: summary } = usePortfolioSummaryQuery(displayCurrency);
  
  return (
    <div>
      <Card>Total: {summary?.totals.currentValue.toFixed(2)}</Card>
      <Card>Invested: {summary?.totals.totalInvested.toFixed(2)}</Card>
      <Card>Gain/Loss: {summary?.totals.totalGainLoss.toFixed(2)}</Card>
      <Card>Return: {summary?.totals.totalReturnPct.toFixed(2)}%</Card>
    </div>
  );
}
```

**Consumer (Performance Page):**

```typescript
function PerformancePage() {
  const { data: performance } = usePortfolioPerformanceQuery(displayCurrency, period);
  const { data: summary } = usePortfolioSummaryQuery(displayCurrency);
  
  // Override snapshot-era totals with realtime values
  const metricsBlock = {
    ...performance.metrics,
    currentValue: summary?.totals.currentValue,
    totalInvested: summary?.totals.totalInvested,
    totalGainLoss: summary?.totals.totalGainLoss,
    totalReturnPct: summary?.totals.totalReturnPct,
  };
  
  return <MetricsCard metrics={metricsBlock} />;
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| **No client FX loops** | Don't recompute totals client-side; always use `/api/info/portfolio-summary` |
| **Single API call per surface** | Dashboard = 1 call, Performance = 1 call (not per-investment calls + FX magic) |
| **Cache invalidation** | `clearInvestmentsCaches()` on investment/transaction writes clears the summary cache automatically |
| **FX applied server-side** | All monetary values in response are pre-converted; client just renders them |
| **Reconciliation invariant** | `sum(summaries[].currentValue) === totals.currentValue` guaranteed by service, verified by tests |
| **Future totals surfaces** | Any new portfolio-total UI (widgets, exports, reports, etc.) must use this endpoint |

### When to Use

- **Dashboard overview cards** — Total value, invested, gain/loss, return %
- **Performance page headline metrics** — Current value, invested, gain/loss, return %
- **Portfolio export/report cover pages** — Showing summary totals
- **Any widget/card displaying portfolio totals** — Use this endpoint

### When NOT to Use

- Per-investment summaries (use `GET /api/investments` and breakdown response)
- Historical snapshot data (use `GET /api/info/portfolio-performance` snapshots array)
- Per-asset-class drill-down (available in summaries[] array from same endpoint)

### Related

- [[docs/api/portfolio-summary|Portfolio Summary API]]
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]]
- [[apps/node-backend/src/services/portfolio/portfolioSummaryService.js|Service Implementation]]

---

## Settings-Backed Hook Pattern: usePortfolioTaxClassifications (May 2026)

**Purpose:** Persist per-investment tax metadata (ETF structure, Reynders routing) to the Settings API with in-memory cache and transparent hydration.

**Source:** `[[apps/frontend/src/hooks/usePortfolioTaxClassifications.ts]]`

```typescript
// Hook definition
interface TaxClassification {
  investmentId: number;
  etfStructure?: 'accumulating' | 'distributing';
  subjectToReynders?: boolean;
}

export function usePortfolioTaxClassifications() {
  // Derive classifications from SettingsPreloadContext or Settings API
  const classifications = useQueryData(settingsKey) as Record<number, TaxClassification>;

  const setClassification = (investmentId: number, classification: TaxClassification) => {
    // Merge into existing map; client-side optimistic update
    const updated = { ...classifications, [investmentId]: classification };
    setQueryData(updated);
  };

  const saveToSettings = () => {
    // Persist to backend settings API
    return apiClient.saveSetting(settingsKey, classifications);
  };

  return { classifications, setClassification, saveToSettings };
}

// Consumer
function PortfolioTaxPage() {
  const { classifications, setClassification, saveToSettings } = usePortfolioTaxClassifications();

  const onEtfStructureChange = (investmentId: number, structure: 'accumulating' | 'distributing') => {
    setClassification(investmentId, {
      investmentId,
      etfStructure: structure,
      subjectToReynders: classifications[investmentId]?.subjectToReynders,
    });
  };

  const handleSave = async () => {
    await saveToSettings();
    toast.success('Tax classifications saved');
  };

  return (
    <PortfolioTaxAdjustmentsDialog
      classifications={classifications}
      onEtfStructureChange={onEtfStructureChange}
      onReyndersChange={(id, value) => setClassification(id, { investmentId: id, subjectToReynders: value })}
      onSave={handleSave}
    />
  );
}
```

### Key Patterns

| Pattern | Rationale |
|---------|-----------|
| **Settings JSONB keying** | Store all classifications under a single `portfolio_tax_classifications_v1` key; map by investmentId internally |
| **Optimistic updates** | `setClassification()` updates local state immediately; `saveToSettings()` persists asynchronously |
| **Transparent hydration** | `SettingsPreloadContext` provides initial data; hook reads from context during mount to avoid loading states |
| **Per-investment overrides** | Only store non-default values (e.g., omit `etfStructure` if default accumulating is intended) |
| **No API endpoint** | Use generic `apiClient.saveSetting()` method; no dedicated PATCH /api/portfolio-tax/classifications endpoint |

### When to Use

- **Per-item metadata that is user-configured, not computed** (user-selected ETF type, investment-specific tax routing)
- **Metadata that spans multiple investments or time periods** (portfolio-level preferences)
- **Data that should persist across sessions but isn't business-critical** (settings, preferences, overrides)

### When NOT to Use

- **Investment data itself** (allocation, cost basis, holdings) — store in investment records
- **Transactional data** (taxes, fees, gains) — compute server-side, store in transaction records
- **Highly mutable state** (portfolio valuation, real-time prices) — use React Query or signals

---

## React Key Generation Pattern (2026-05-05 Bug Hunt)

**Problem:** Using array index as React key (`key={index}`) causes reconciliation bugs when list items are reordered, filtered, or when item state changes between renders.

**Symptoms:**
- Form state persists across different items (checkbox checked on wrong item after reorder)
- Animation state mismatches (entered animation plays for wrong item)
- Component-local state mixups (focus lost, internal state corrupted)

### Solution: Stable Unique Identifiers

#### For Database Entities
Use database ID (guaranteed unique and stable):
```typescript
// ✅ CORRECT
{items.map(item => (
  <SplitEntry key={item.id} item={item} />
))}
```

#### For Generated Items (Splits, Residences)
Generate stable UIDs on initialization and store in a ref:

```typescript
// SplitTransactionDialog.tsx
const [splits, setSplits] = useState<SplitEntry[]>([
  { uid: crypto.randomUUID(), amount: 0, recipient_id: null },
  { uid: crypto.randomUUID(), amount: 0, recipient_id: null },
]);

return (
  <>
    {splits.map(split => (
      <SplitEntry key={split.uid} split={split} />
    ))}
  </>
);
```

#### Ref-Based UID Management
For immutable lists that need UID rebinding on external changes:

```typescript
// TaxProfileDialog.tsx
const residenceUids = useRef<Map<number, string>>(new Map());

const ensureUid = (residenceId: number): string => {
  if (!residenceUids.current.has(residenceId)) {
    residenceUids.current.set(residenceId, crypto.randomUUID());
  }
  return residenceUids.current.get(residenceId)!;
};

return (
  <>
    {residences.map(res => (
      <ResidenceRow key={ensureUid(res.id)} residence={res} />
    ))}
  </>
);
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Never use index | Index changes with reorder/filter; causes state corruption |
| Use DB ID when available | Guaranteed unique and stable across renders |
| Generate UIDs for new items | Use `crypto.randomUUID()` at creation time |
| Store UIDs in state or ref | Never regenerate on every render |
| Don't change keys between renders | Same item must have same key always |
| For linked lists with refs | Use ref to maintain UID→ID mapping across external changes |

### When to Use

- **Lists with reordering** — drag-drop, sort, filter
- **Dynamic form arrays** — splits, tax residences, portfolio positions
- **Stateful list items** — forms, checkboxes, focus states
- **Any list rendered via `.map()`** — universal safety rule

---

## Mount Guard Pattern (2026-05-05 Bug Hunt)

**Problem:** Async operations (fetch, timers) can set state after a component unmounts, causing React warnings and potential memory leaks.

**Symptoms:**
- "Can't perform a React state update on an unmounted component" warning
- Stale state updates overwriting newer data
- Leaked timers/intervals continuing after unmount

### Solution: useEffect Mount Ref

```typescript
function usePlannedPayments(options?: UsePlannedPaymentsOptions) {
  const mountedRef = useRef(true);
  const [data, setData] = useState<PlannedPayment[]>([]);
  
  // Set ref to true on mount, false on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      try {
        const response = await apiClient.getPlannedPayments(options);
        // Only update state if still mounted
        if (mountedRef.current) {
          setData(response.data);
        }
      } catch (error) {
        if (mountedRef.current) {
          console.error('Failed to load planned payments:', error);
        }
      }
    };

    loadData();
  }, [options]);

  return { data };
}
```

### Interval Cleanup
For long-running intervals, guard cleanup and state updates:

```typescript
useEffect(() => {
  const intervalId = setInterval(() => {
    if (!mountedRef.current) return; // Skip if unmounted
    
    // Perform work
    fetchStatus();
  }, 5000);

  return () => {
    clearInterval(intervalId);
  };
}, []);
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Initialize to `true` in mount effect | Synchronous, guaranteed before any async work |
| Check before all `setState()` calls | Guards against post-unmount updates |
| Clear timers in cleanup | `clearInterval`, `clearTimeout` still required |
| Use in custom hooks | Not in component bodies directly |
| Return false on unmount | Cleanup effect sets it to false |

### When to Use

- **Custom hooks with async operations** — `useFetch`, `useQuery` wrappers
- **Long-running intervals/timeouts** — Real-time data, health checks
- **AbortController-free code** — Before migrating to AbortSignal
- **Legacy hooks without error boundaries** — Temporary safety measure

### When NOT Necessary

- **React Query / SWR** — Handles cleanup automatically
- **useEffect with AbortController** — Abort signal prevents post-unmount updates
- **Synchronous effects only** — No async work = no race condition
- **Modal/Dialog components** — These typically unmount with parent, not selectively

---

## Belgian Tax Freeze/Display Pattern (ADR-059, Phase 11, May 2026)

**Source:** [[apps/frontend/src/contexts/BelgianTaxProfileContext.tsx|BelgianTaxProfileContext]], [[apps/frontend/src/lib/belgianTax/types.ts|belgianTax/types.ts]]

When displaying calculated tax information (PIT, effective rates, etc.) for historical years, use `displayCalculationForYear(year)` instead of always recomputing from the live profile. This pattern solves engine-drift: a bug fix to `computeBelgianPIT` should not retroactively change filed years.

### Pattern

```typescript
// In a read site (page, component, hook):
const { displayCalculationForYear, isYearFiled } = useBelgianTaxProfileContext();

// For the viewed year, use the display getter (not live recompute)
const calculation = displayCalculationForYear(viewedYear);

// isYearFiled tells you if the year is locked behind explicit amend confirmation
const canEditFreely = !isYearFiled(viewedYear);
```

### How it Works

1. **Frozen calculation preference** — If a year has a frozen calculation (captured when marked filed or explicitly frozen), `displayCalculationForYear` returns it verbatim (no recompute).
2. **Live fallback** — If no frozen calculation exists, `displayCalculationForYear` computes fresh via `computeBelgianPIT(profileForYear(year))`.
3. **Freezing** — Call `freezeCalculation(year)` to capture the current calculation and prevent engine drift for that year.
4. **Filing** — Call `markYearAsFiled(year, reference?)` to freeze + record filing metadata. Unfiling preserves the frozen calc.

### Behavioral rules

| Scenario | Result | Why |
|----------|--------|-----|
| User marks year filed | Frozen calc captured (if not already frozen); filing metadata recorded | Engine changes won't alter filed numbers |
| User unfiling (clerical correction) | Frozen calc preserved; filing record removed | User may still want the frozen calc for reference |
| User explicitly freezes a year | Frozen calc captured before marking filed | Deliberate freeze point wins if filed afterward |
| Viewing a filed year on read sites | `displayCalculationForYear` returns frozen calc verbatim | Filed numbers are byte-stable across sessions |
| Editing a filed year | `TaxProfileDialog` gates behind "Amend this filed year" confirmation | Deliberate escape hatch, not hard-lock |

### Read-site example

```typescript
// Tax Overview page — yearly chart
function YearlyChart({ viewedYear }) {
  const { displayCalculationForYear, profileForYear, calculationForYear } = useBelgianTaxProfileContext();
  
  const calculation = displayCalculationForYear(viewedYear);
  const profile = profileForYear(viewedYear);
  
  return (
    <div>
      <h2>PIT for {viewedYear}: {calculation.totalPIT}</h2>
      <p>Gross: {profile.grossIncome}</p>
      {/* Chart bars use displayCalculationForYear so filed years stay aligned */}
    </div>
  );
}
```

### Mutator example

```typescript
// Year Actions Menu — freeze button clicked
async function handleFreezeYear(year) {
  const { freezeCalculation } = useBelgianTaxProfileContext();
  
  try {
    await freezeCalculation(year);
    showToast('Year calculation frozen. Engine changes will not affect this year.');
  } catch (err) {
    showError('Failed to freeze year calculation');
  }
}
```

### Context surface

| Member | Purpose |
|---|---|
| `snapshotMetas` | Sparse per-year meta map (`Record<incomeYear, BelgianTaxProfileSnapshotMeta>`). |
| `displayCalculationForYear(year)` | Returns frozen calc if present, else live recompute. Use this on all read sites. |
| `getFrozenCalculation(year)` | Returns frozen calc or `null`. |
| `isYearFiled(year)` | Boolean — true iff filing metadata exists. |
| `freezeCalculation(year)` | Capture and persist frozen calc for the year. |
| `unfreezeCalculation(year)` | Clear frozen calc (filed metadata preserved). |
| `markYearAsFiled(year, reference?)` | Freeze (if not already frozen) + record filing metadata. |
| `unmarkYearAsFiled(year)` | Clear filing metadata (frozen calc preserved). |
| `getSnapshotHistory(year)` | Audit log entries (append-only, capped at 200 per year). |

### Storage

Persisted in Settings API under key `belgian_tax_profile_snapshot_meta_v1`:

```typescript
type BelgianTaxProfileSnapshotMeta = {
  frozenCalculation?: BelgianTaxCalculation;  // "as-filed" calc, byte-stable
  filing?: { filedAt: string; reference?: string }; // present iff year is filed
  history?: SnapshotAuditEntry[];             // append-only, diff-only entries, trimmed at 200
};
```

### When to Use

- **All read sites** (pages, component displays) — Use `displayCalculationForYear` to respect frozen calcs.
- **Audit/comparison surfaces** — Use `getSnapshotHistory`, `isYearFiled` to show user-facing metadata.
- **Before persisting edits** — If year is filed, show "Amend this filed year" confirmation (gated in `TaxProfileDialog`).
- **Export / reporting** — Use `displayCalculationForYear` so exports contain filed numbers verbatim.

### When NOT Necessary

- **Live editing flow** — While user is actively editing, `profileForYear` and `calculationForYear` work fine (no persistence yet).
- **Profile mutations** — `updateSnapshot`, `markYearAsFiled` handle append-only audit logging internally.
- **Components that don't display calculations** — e.g., `TaxYearSwitcher` only needs `viewedYear` state, not frozen calcs.

---

## Devtools Integration Pattern (Dev-Only Observability, May 2026)

**Source:**
- [[apps/frontend/src/lib/devtools/apiEventBus.ts|apiEventBus.ts]] — Event bus
- [[apps/frontend/src/lib/devtools/apiRequestLog.ts|apiRequestLog.ts]] — Request log hook
- [[apps/frontend/src/lib/devtools/queryMetrics.ts|queryMetrics.ts]] — Metrics hook
- [[apps/frontend/src/lib/api/client.ts|client.ts]] — API client integration
- [[apps/frontend/src/components/devtools/|devtools components]] — UI layer

All API requests automatically participate in dev-only observability via the `apiRequest()` chokepoint, which:

1. **Mints requestId** (UUID) before each attempt and sets `X-Request-Id` header
2. **Emits ApiRequestEvent** with lifecycle phases:
   - `phase: 'start'` — Request initiated
   - `phase: 'success'` — Response received with status and durationMs
   - `phase: 'error'` — Error occurred with errorCode and errorMessage
3. **No changes to domain hooks** — All 38 hooks (`useTransactions`, `usePortfolio`, etc.) participate automatically

### Pattern: Adding Observable Operations

Ensure any new API operations flow through `apiRequest()` via the [[docs/reference/frontend-api-client|API client pattern]]:

```typescript
// Good: Uses apiRequest() chokepoint
import { apiRequest } from '@/lib/api/client';

export async function getTransactions(params) {
  return apiRequest('/api/transactions', 'GET', null, { query: params });
}

// Then in a hook:
const { data } = useQuery({
  queryKey: ['transactions'],
  queryFn: () => getTransactions({ limit: 50 })
});
// Observability: automatically tracked in inspector
```

### Pattern: Lazy-Chunk Gated Activation

DevtoolsRoot ships in a lazy chunk and mounts when a dev build flag is set OR the
runtime Admin Mode toggle is on:

```tsx
// In App.tsx
const isDevtoolsBuildEnabled =
  import.meta.env.DEV || import.meta.env.VITE_DEVTOOLS === 'true';

function DevtoolsGate() {
  const adminMode = useSettingsStore((s) => s.appSettings.adminMode);
  if (!isDevtoolsBuildEnabled && !adminMode) return null;
  return (
    <Suspense fallback={null}>
      <DevtoolsRoot />
    </Suspense>
  );
}
```

- Build flags (`import.meta.env.DEV` / `VITE_DEVTOOLS`) keep it always-on in dev
- `adminMode` exposes it at runtime in any build — the only path that works in the
  packaged Electron app and public release image (normally-built bundle)
- The devtools chunk is **lazy**: only fetched when the gate first renders it, so
  users who never enable Admin Mode pay no load cost

### Pattern: Querying Request Log

Use `useApiRequestLog()` in components to subscribe to request history:

```typescript
const requests = useApiRequestLog(); // Returns ApiRequest[] (max 200)

// Filter in-flight requests
const inFlight = requests.filter(r => r.phase === 'start');

// Get error count
const errorCount = requests.filter(r => r.phase === 'error').length;
```

### Pattern: Querying Metrics

Use `useQueryMetrics()` to access aggregated statistics:

```typescript
const metrics = useQueryMetrics();
// Returns:
// {
//   totalRequests: number;
//   errorRate: number; // 0-100
//   slowRequests: ApiRequest[];
//   topEndpoints: { endpoint: string; count: number; p50: number; p95: number }[];
//   cacheHitRatio: number; // 0-100
//   mutationSuccessRate: number; // 0-100
// }
```

### When to Use

- **Development** — Dev server with inspector open for real-time request visibility
- **Debugging** — Identify slow requests, error patterns, cache efficiency
- **Performance profiling** — Compare p50/p95 latencies across endpoints
- **Integration testing** — Verify request counts and cache behavior

### When NOT to Use

- **Default user experience** — Stays dormant unless Admin Mode is enabled; the lazy chunk isn't fetched, so there's no load cost for ordinary users
- **User-facing observability** — Use [[docs/features/admin-observability|Admin Observability API]] instead (backend-provided system health)

---

## Keyboard Activation Helper — `onActivateKeyDown` (Frontend, 2026-05-29)

**Source:** [[apps/frontend/src/utils/a11y.ts|a11y.ts]]

Use `onActivateKeyDown` to give keyboard users an activation path for surfaces that were previously reachable only via mouse click or double-click.

```typescript
import { onActivateKeyDown } from "@/utils/a11y";

// Non-interactive element that must become keyboard-operable:
<div
  role="button"
  tabIndex={0}
  onClick={handleOpen}
  onKeyDown={onActivateKeyDown(handleOpen)}
>
  ...
</div>

// Native <button> that had only onDoubleClick — add keyboard path:
<button
  type="button"
  onDoubleClick={handleOpen}
  onKeyDown={onActivateKeyDown(handleOpen)}
>
  ...
</button>
```

The helper fires the handler on **Enter** or **Space** and ignores events that bubbled from a nested focusable child (`e.target !== e.currentTarget`), preventing double-firing when an inner control is operated.

### Key Rules

| Rule | Rationale |
|------|-----------|
| Pair with `role="button"` + `tabIndex={0}` | Required on non-interactive elements; omit on native `<button>` |
| `e.preventDefault()` is called inside | Prevents Space from scrolling the page |
| Do not fire on bubbled events | Inner `<input>`, `<select>`, or `<button>` key events must not trigger the outer handler |
| Keep `onDoubleClick` / `onClick` as-is | Keyboard path supplements, does not replace, the mouse binding |

### When to Use

- A `<div>` or `<Card>` has `onClick`/`onDoubleClick` but no `role`/`tabIndex`/`onKeyDown`.
- A native `<button>` has `onDoubleClick` only (pressing Enter/Space fires `click`, not `dblclick`).
- Any non-interactive container that acts as a primary navigation target.

### When NOT to Use

- Elements that are already fully keyboard-operable via native semantics (links, standard buttons with `onClick`).
- Forms — use `onSubmit` on `<form>` instead.
- Elements inside a `VirtualDataTable` row — the table's own inline `onKeyDown` covers row activation.

See [[docs/components/shared-components#onActivateKeyDown (a11y utility)|onActivateKeyDown component doc]] for the list of surfaces where it is applied.

---

## Radix ContextMenu + Dialog Interplay — `modal={false}` (Premium v3 V5, June 2026)

**Source:** [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/features/transactions/components/TransactionsTable.tsx]]

When a Radix `ContextMenu` has items that open a page-level `Dialog`, the menu **must** be mounted with `modal={false}`.

### Why

A modal Radix overlay (`modal={true}`, the default) sets `pointer-events: none` on `document.body` while it is open. The `Dialog` component does the same when it opens. If the menu closes at the same moment the dialog opens, the two locks race: the menu's cleanup removes the `pointer-events` override while the dialog has already set its own. Depending on timing, the result is a page stuck in an inert state where no pointer events reach any element until the dialog closes.

`modal={false}` skips the body pointer-event lock entirely. The menu still dismisses on item selection and on outside clicks — all expected Radix ContextMenu behavior is preserved.

### Pattern

```tsx
// Inside VirtualDataTable render (per row):
<ContextMenu modal={false}>
    <ContextMenuTrigger asChild>{rowEl}</ContextMenuTrigger>
    {rowContextMenu(row, sourceIndex, { startEditing: () => startEditing(sourceIndex, row) })}
</ContextMenu>
```

### Rules

| Rule | Rationale |
|------|-----------|
| Use `modal={false}` when any menu item opens a `Dialog` or `AlertDialog` | Prevents the body pointer-events race described above |
| Do not use `modal={false}` on standalone menus with no dialog children | The default modal=true is safer (traps focus correctly for pure menus) |
| Verify with both mouse and keyboard (Tab + Space/Enter) | Keyboard-only users open dialogs from menu items too |

### When to Apply

- Any `ContextMenu` or `DropdownMenu` whose items conditionally open a `Dialog`, `AlertDialog`, or `Sheet`.
- Per-row menus in virtual tables (the most common case — each row context menu spawns the edit, delete-confirm, or quick-look dialog).

---

## Database Naming & Enum Discipline (August 2026, migrations 0089/0090)

**Source of the rule:** migrations [[alembic/versions/0089_free_text_enum_checks.py]] and [[alembic/versions/0090_constraint_index_naming.py]].

### Enum-like columns: TEXT + named CHECK

Every **new** enum-like column is `TEXT` with a **named** CHECK constraint listing the vocabulary. Do not create new PostgreSQL native enum types.

```sql
-- Right
ALTER TABLE things ADD COLUMN kind TEXT NOT NULL,
    ADD CONSTRAINT chk_things_kind CHECK (kind IN ('alpha','beta'));

-- Wrong (new work)
CREATE TYPE thing_kind AS ENUM ('alpha', 'beta');
```

Why: PG enums require `ALTER TYPE ... ADD VALUE` ceremony (non-transactional before PG 12, still awkward in migrations), **cannot drop values**, and this schema already carries dead enum values as permanent residue (`revolut_state`: 3 of its 5 values are unreachable because the Revolut adapter drops non-COMPLETED rows before insert). A named CHECK is changed with a two-statement `DROP CONSTRAINT` / `ADD CONSTRAINT` — see 0053/0068/0073/0075/0081 for the idiom.

The nine existing PG enums (`asset_class`, `portfolio_txn_type`, `recurrence_interval`, `price_provider`, `revolut_state`, `account_type`, `account_liquidity_class`, `account_tax_wrapper`, `account_owner`) stay as they are — the rule governs new work, not a retrofit.

**Adding a CHECK to an existing table** (retrofitting a vocabulary): add it `NOT VALID`, then `VALIDATE CONSTRAINT` tolerantly inside a `DO` block that catches `check_violation` and logs a WARNING with the audit/cleanup recipe instead of bricking boot (migrations run fail-fast on app start). Precedent: 0046 → 0049, and 0089.

**Recurrence vocabulary:** the app-side vocabulary for `planned_transactions.recurrence_pattern` is `'biweekly'` (no hyphen; enforced by `chk_planned_transactions_recurrence_pattern` since 0089, matching `SUPPORTED_PATTERNS` plus the `every N days` grammar). The `recurrence_interval` PG enum used by `portfolio_transactions` keeps its historical `'bi-weekly'` spelling — do not introduce `'bi-weekly'` into any new column, and keep the frontend mapper's compat shim until the enum is retired.

### Constraint & index naming

Name **every** constraint and index explicitly — an anonymous inline CHECK/FK gets an auto-generated name that later migrations must discover at runtime via `pg_constraint` (this bit twice: 0015 and 0048). Canonical prefixes, aligned across the whole schema by 0090:

| Object | Prefix | Example |
|--------|--------|---------|
| CHECK constraint | `chk_` | `chk_transactions_transfer_source` |
| UNIQUE constraint or unique index | `uq_` | `uq_transactions_tx_hash` |
| Index (plain or partial) | `idx_` | `idx_db_editor_audit_table_time` |
| Named foreign key | `fk_` | `fk_asset_price_history_investment` |

Not canonical (renamed away by 0090; do not reintroduce): `ck_`, `uniq_`, `ux_`, `ix_`, and suffix-style `*_idx`. Prefer `chk_<table>_<column-or-rule>` / `uq_<table>_<columns>` / `idx_<table>_<columns>`; keep names ≤ 63 chars (PostgreSQL truncates silently beyond that).

Known residue (pre-existing, not worth a rename until touched): the auto-named `*_key` UNIQUE constraints from 0001's inline `UNIQUE` columns (e.g. `*_deduplication_hash_key`), the explicitly-named `*_check`-suffix CHECKs (0015/0040/0059/0081), and 0001's unnamed FKs — rename any of these to the canonical prefix in the same migration that next alters them.

---

## Related

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]]
- [[docs/adr/014-atomic-merge-transactional-safety|ADR-014: Atomic Merge Transactional Safety]]
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/performance/materialized-views|Materialized Views & Aggregation]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/guides/how-to-add-api-endpoint|How to Add an API Endpoint]]
- [[docs/guides/how-to-add-react-component|How to Add a React Component]]
- [[docs/guides/how-to-add-new-page|How to Add a New Page]]
- [[docs/reference/react-query-keys|React Query Keys Reference]]
- [[docs/reference/error-codes|Error Codes Reference]]
