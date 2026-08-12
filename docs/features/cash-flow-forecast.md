---
title: Cash Flow Forecast
type: feature
status: active
date: 2026-04-25
updated: 2026-06-01
last_modified: 2026-06-01
tags: [feature, cash-flow, forecast, planning, aggregations, phase-6, phase-10, phase-c, phase-d, phase-e, phase-g, planned-transactions, statistical-forecasting, ensemble-methods, ensemble-v2, empirical-bayes, frontend-visualization, multi-method-forecast, diagnostics-sheet, accuracy-persistence, materialized-cache, nightly-job, category-breakdown, fallback-resilience]
aliases: [cashflow-forecast, forward-projections, cash-flow-planning, income-expense-forecast, budget-projection, multi-method-forecast, ensemble-forecast, category-breakdown]
description: Project income and expenses forward based on planned transactions (Phase 6) or using 8 statistical methods including 7 base methods + Ensemble (v2) (Phase 10, F). Phase C adds frontend dashboard visualization with controls, MC confidence bands, and diagnostics panel. Phase E adds nightly cache materialization. Phase G adds per-category breakdown with hierarchical reconciliation. June 2026: ensemble weighting upgraded from plain inverse-MSE to sample-size-shrunk RMSE + uniform-blend floor (empirical Bayes).
related_code:
  - apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js
  - apps/node-backend/src/services/calculations/forecast/index.js
  - apps/node-backend/src/services/calculations/forecast/categoryBreakdown.js
  - apps/node-backend/src/services/calculations/forecast/accuracyStore.js
  - apps/node-backend/src/routes/aggregations.js
  - apps/node-backend/src/repositories/plannedTransactionRepository.js
  - apps/node-backend/src/repositories/infoRepositoryMonthly.js
  - apps/node-backend/src/repositories/cashflowForecastAccuracyRepository.js
  - apps/node-backend/src/repositories/cashflowForecastMcRepository.js
  - apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js
  - apps/node-backend/src/jobs/refreshCashflowForecastMc.js
  - apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx
  - apps/frontend/src/components/dashboard/CashFlowForecastDiagnostics.tsx
  - apps/frontend/src/lib/api/aggregations.ts
  - alembic/versions/0012_cashflow_forecast_accuracy.py
  - alembic/versions/0013_cashflow_forecast_mc.py
  - alembic/versions/0016_cashflow_forecast_mc_rolling.py
---

# Cash Flow Forecast

Vision offers two complementary cash flow forecasting approaches with a full-featured dashboard visualization:

1. **Phase 6 (Planned Projection)** — Forward-projects active, unexecuted planned transactions over a rolling window
2. **Phase 10 (Multi-Method Statistical)** — Uses 7 independent statistical methods to forecast rest-of-month cash flow based on historical patterns and Monte Carlo simulation
3. **Phase C (Frontend Visualization)** — Dashboard widget with 8-method ensemble chart (7 base + inverse-MSE), controls, confidence bands, and diagnostics panel

## Overview (Phase 6 + Phase 10 + Phase C)

Vision offers two complementary forecasting approaches with rich dashboard visualization:

### Phase 6: Planned Projection

Takes all active planned transactions and expands them into future occurrences based on their recurrence pattern (if recurring) or their planned date (if one-time). Groups these by month to show projected monthly cash position.

**Key characteristics:**
- **Forward-looking** — Shows N months ahead (default 3, max 24)
- **Non-convertible** — All amounts stay in their original currency (future FX rates unknown)
- **Real-time** — Computed on-demand; does not require pre-calculation
- **Recurring-aware** — Expands recurring transactions into individual monthly occurrences
- **Endpoint:** `GET /api/aggregations/cashflow-forecast`

### Phase 10 + F: Multi-Method Statistical Forecasting with Ensemble

Forecasts the rest of the current month using 8 statistical methods: 5 point forecasts, 2 Monte Carlo distribution methods, and 1 ensemble (v2) combining point forecasts. Includes walk-forward backtesting to measure accuracy with persistent history for trend analysis.

**Key characteristics:**
- **Historical pattern-based** — Learns from 36+ months of historical transactions (configurable)
- **Multiple methods** — 5 point forecasts (simple/weighted average, EWMA, Holt-Winters, Prophet Lite) + 2 Monte Carlo methods with confidence bands + 1 Ensemble (v2) combining point methods with empirical-Bayes shrinkage and uniform-blend floor
- **Real-time** — Computed on-demand; methods are stateless and deterministic
- **Diagnostic** — Walk-forward backtest shows MAE/RMSE/MAPE per method; Phase D persists monthly accuracy metrics
- **Current month only** — Forecasts remaining days in current month (future months covered by Phase 6 planned projection)
- **Endpoints:** `GET /api/aggregations/cashflow-forecast-methods`, `GET /api/aggregations/cashflow-forecast-accuracy` (Phase D)

### Phase C: Frontend Dashboard Visualization

Dashboard widget (`CashFlowForecastChart`) displays the 8-method forecast (7 base + ensemble) with full interactivity and diagnostics. By default, shows 6 methods: the 5 point-estimate methods plus ensemble inv-MSE. Monte Carlo methods are hidden by default but can be toggled on via pill controls.

**Features:**
- **Multi-method chart** — Tabs to toggle between cumulative balance and daily net views
- **Method toggles** — Per-method pill controls to show/hide individual forecasts on the chart
- **Default visibility** — Displays 5 point methods + Ensemble (v2) by default; Monte Carlo methods hidden by default but toggleable
- **MC confidence bands** — Dashed LineSeries rendering P10/P90 bands for parametric and block bootstrap methods (visible when those methods are toggled on)
- **Planned transaction overlay** — Switch to include pending planned transactions in cumulative view (triggers refetch)
- **Diagnostics panel** — Right-side sheet showing:
  - Backtest accuracy table (MAE/RMSE/MAPE per method, sorted by MAE with rank badge)
  - Per-method MAE sparkline for quick visual comparison
  - Suggested ensemble weights preview (inverse-MSE bar chart, read-only)
- **Self-contained data loading** — Component manages its own useQuery; accepts filters (`excludedCategoryIds`, `excludedRecipientIds`, `currency`) as props
- **Responsive design** — Adapts to mobile/tablet/desktop viewports

**Related Components:**
- `CashFlowForecastChart` — Main multi-method forecast visualization with controls
- `CashFlowForecastDiagnostics` — Diagnostics sheet panel with accuracy metrics and ensemble preview

## Phase 10 & F: Eight Forecasting Methods

The multi-method forecast endpoint returns daily predictions from 8 statistical methods (7 base + 1 ensemble). The frontend chart defaults to showing 6 of these methods: the 5 point-estimate methods (Simple Average, Weighted Average, EWMA, Holt-Winters, Prophet Lite) plus the ensemble method. The 2 Monte Carlo methods are toggled off by default but can be enabled via pill controls.

### Point Forecasts (No Confidence Bounds)

| Method | Type | Description | Strengths | Weaknesses |
|--------|------|-------------|-----------|-----------|
| **Simple Average** | Mean | Per-day-of-month average across history | Robust, no assumptions | Ignores recent trends |
| **Weighted Average** | Mean | Linear recency weights (newer days matter more) | Adapts to trends | Still assumes constant seasonality |
| **EWMA** | Exponential | Exponential smoothing (α=0.15 default) on daily flow | Responsive to change | Single smoothing parameter |
| **Holt-Winters** | Double Exponential | Double exponential smoothing with weekly (M1=7) + monthly (M2=30) seasonality; 3⁴ grid search for optimal params | Captures multi-scale seasonality | Computational cost; may overfit |
| **Prophet Lite** | Parametric | Piecewise-linear trend + Fourier harmonics (K=3 weekly, K=10 yearly) + Belgian holidays (Easter computus) + ridge OLS normal equations (λ=1.0); requires ≥60 days history or returns zeros | Interprets holidays, trends separately | Regularization tuning; overhead |

### Distribution Forecasts (With Confidence Bands)

| Method | Type | Description | Bands | Cost |
|--------|------|-------------|-------|------|
| **Monte Carlo (Parametric)** | Gaussian | Per-(day-of-week, day-of-month) bucket: mean + std → Gaussian sampling. `paths` independent samples. | p10, p25, p50, p75, p90 (configurable) | O(paths × days) |
| **Monte Carlo (Block Bootstrap)** | Resampling | Stationary block bootstrap over detrended residuals (block length L=7, geometric distribution). Preserves temporal structure in residual correlation. | p10, p25, p50, p75, p90 (configurable) | O(paths × days) |

### Ensemble Forecast (Phase F + v2, June 2026)

| Method | Type | Description | Weighting | Cost |
|--------|------|-------------|-----------|------|
| **Ensemble (v2)** | Combination | Weighted average of 5 point-forecast methods. Weights use sample-size-shrunk inverse-MSE (empirical Bayes) blended toward a uniform 5% floor. Falls back to equal weights on first run. Method id: `ensemble_imse`. | Shrunk inverse-MSE + uniform floor (dynamic) | O(methods) |

> [!info] v2 Weighting Rationale (June 2026)
> The original Phase F ensemble weighted purely by inverse-MSE (1/RMSE²). A method whose low RMSE came from a tiny backtest window was over-trusted. v2 addresses this with two adjustments applied in `ensemble.js`:
> 1. **Empirical-Bayes shrinkage**: `shrunkRmse = (n·rmse + K·meanRmse) / (n + K)` where `n = sampleDays` from the accuracy row and `K = 30` days. Methods with fewer sample days are pulled toward the cross-method mean RMSE.
> 2. **Uniform-blend floor (5%)**: Final weight = `(1 - 0.05) × (inverseMSE_share) + 0.05 / m`. No single method can consume the entire weight budget; every eligible method contributes at least `0.05 / m`.
> The method id (`ensemble_imse`) and fallback behavior are unchanged. The human-readable label changed from "Ensemble (inv-MSE)" to "Ensemble (v2)".

### Parameters

**Shared:**
- `history_months` (default 36, max 120): Historical window for training. Longer = more data but less responsiveness to recent shifts.
- `include_planned`: If true, overlays pending planned transactions onto cumulative forecast.
- `include_backtest`: If true, runs walk-forward backtest to compute MAE/RMSE/MAPE diagnostics.

**Monte Carlo:**
- `mc_paths` (default 1000, max 5000): Number of independent simulation paths per method.
- `mc_percentiles` (default [10, 50, 90]): Which percentiles to return in confidence bands.

### Determinism & Reproducibility

Each Monte Carlo method uses a seeded PRNG (`fnv1a_hash(userId | yyyymm | filterHash)`) to ensure:
- Same user, same month, same filters → identical samples across requests
- Enables caching and ensemble combination in Phase D
- `filterHash` includes currency, excluded categories, excluded recipients, and `include_planned` flag

### Decimal Precision & Accumulation (May 2026 Audit)

All cash flow forecast calculations now route through Decimal.js to eliminate IEEE 754 floating-point drift in running balance aggregation:

**Implementation:**
- `cashflowForecast.js`: All date bucketing via APP_TIMEZONE helpers; cumulative net flows accumulated via Decimal `addAll()`
- `calculations/aggregation/cashflowForecast.js`: Running-balance stream maintained as Decimal throughout; `divide()` used for per-day allocation when splitting multi-day transactions
- Frontend `forecastMerge.ts`: Reuses `buildBandMaps()` and `buildSeries()` helpers to avoid redundant accumulation passes

**Benefit:** Forecasts with many categories or long histories no longer accumulate ±0.01 rounding errors. Cumulative balance matches database NUMERIC precision exactly.

## Endpoints

### Phase 6: Planned Projection

**Path:** `GET /api/aggregations/cashflow-forecast`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `months` | integer | 3 | 24 | Number of months to forecast |

**Example:**
```http
GET /api/aggregations/cashflow-forecast?months=6
```

## Response Shape

```json
{
  "data": {
    "forecast": [
      {
        "month": "2026-05",
        "income": 3500.00,
        "expenses": -2150.75,
        "net": 1349.25,
        "items": [
          {
            "id": 42,
            "planned_date": "2026-05-01",
            "currency": "EUR",
            "amount": 3500.00,
            "memo": "Salary",
            "recipient_name": "Employer Inc.",
            "category_name": "INCOME:SALARY",
            "is_recurring": false,
            "recurrence_pattern": null
          },
          {
            "id": 15,
            "planned_date": "2026-05-15",
            "currency": "EUR",
            "amount": -1200.00,
            "memo": "Rent",
            "recipient_name": "Landlord",
            "category_name": "HOUSING:RENT",
            "is_recurring": true,
            "recurrence_pattern": "monthly"
          }
        ]
      },
      {
        "month": "2026-06",
        "income": 3500.00,
        "expenses": -2150.75,
        "net": 1349.25,
        "items": [ /* ... */ ]
      }
    ]
  },
  "meta": {
    "source": "live",
    "computedAt": "2026-04-24T12:34:56.789Z"
  }
}
```

**Field Descriptions:**

| Field | Type | Meaning |
|-------|------|---------|
| `month` | string | `YYYY-MM` format |
| `income` | number | Sum of positive (incoming) amounts |
| `expenses` | number | Sum of negative (outgoing) amounts (returns negative value) |
| `net` | number | `income + expenses` |
| `items` | array | Forecast occurrences in this month |
| `meta.source` | string | Always `"live"` (computed, not from materialized view) |
| `meta.computedAt` | string | ISO 8601 timestamp of computation |

## Item Details

Each item in the forecast represents a single planned occurrence:

```json
{
  "id": 42,                              // Planned transaction ID
  "planned_date": "2026-05-15",         // Date of this occurrence
  "currency": "EUR",                    // Original currency
  "amount": -1200.00,                   // Amount (positive for income, negative for expense)
  "memo": "Rent",                       // User-provided memo
  "recipient_name": "Landlord",         // Payee/payer name (null if no recipient)
  "category_name": "HOUSING:RENT",      // Category (GENERAL:DETAIL format, null if uncategorized)
  "is_recurring": true,                 // Is this from a recurring pattern?
  "recurrence_pattern": "monthly"       // Recurrence interval (null if one-time)
}
```

## Recurring Transaction Expansion

For recurring transactions, the forecast uses the same date-advancement logic as the execute-and-advance endpoint:

**Supported patterns:**
- `daily` — Every day
- `weekly` — Same day of week
- `monthly` — Same day of month (or last day if day > 28)
- `yearly` — Same month and day

**Example: Monthly rent on the 15th**

If planned_date is 2026-05-15 and pattern is `monthly`:
- 2026-05 → occurrence on 15th
- 2026-06 → occurrence on 15th
- 2026-07 → occurrence on 15th
- ... (continues until window end)

**Edge case: Day-of-month overflow**

If planned_date is 2026-01-31 and pattern is `monthly`:
- 2026-01 → 31st
- 2026-02 → 28th (or 29th in leap year; Feb has no 31st)
- 2026-03 → 31st
- ... (algorithm picks the last valid day)

### Phase 10: Multi-Method Statistical Forecast

**Path:** `GET /api/aggregations/cashflow-forecast-methods`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `currency` | string | EUR | — | Target currency (3-letter code) |
| `excluded_category_ids[]` | integer[] | [] | — | Exclude transactions in these categories |
| `excluded_recipient_ids[]` | integer[] | [] | — | Exclude transactions from these recipients |
| `history_months` | integer | 36 | 120 | Historical window for training (in months; typically 30 days per month) |
| `mc_paths` | integer | 1000 | 5000 | Monte Carlo simulation paths per method |
| `mc_percentiles[]` | integer[] | [10,50,90] | — | Percentiles for confidence bands (e.g., `[5,25,75,95]`) |
| `include_planned` | boolean | false | — | Overlay pending planned transactions onto cumulative forecast? |
| `include_backtest` | boolean | true | — | Include walk-forward backtest diagnostics (MAE/RMSE/MAPE)? |
| `include_breakdown` | boolean | false | — | Include per-category breakdown with reconciliation to aggregate (Phase G)? |

**Example:**

```http
GET /api/aggregations/cashflow-forecast-methods?history_months=36&mc_paths=2000&include_backtest=true
```

**Response Structure:**

See [[docs/api/aggregations#multi-method-cash-flow-forecast-phase-10|Aggregations API: Multi-Method Cash Flow Forecast]] for complete response schema and field descriptions. Key sections:

- `month` — Current month in YYYY-MM format
- `currency` — Target currency
- `actual[]` — Realized daily net (past dates only; future dates are null)
- `planned[]` — Pending planned transaction dates (if `include_planned=true`)
- `methods[]` — Array of 7 forecasting methods with `id`, `label`, `daily`, `cumulative`, `bands` (MC only), `error`
- `diagnostics` — Walk-forward backtest results: MAE, RMSE, MAPE per method; per-month breakdown (if `include_backtest=true`)

**Using Monte Carlo Confidence Bands:**

The two Monte Carlo methods return confidence bands in `bands` object:

```json
{
  "id": "monte_carlo_parametric",
  "label": "Monte Carlo (Parametric)",
  "daily": [ /* point estimates */ ],
  "cumulative": [ /* cumulative sum */ ],
  "bands": {
    "p10": [ { "date": "2026-04-25", "value": 30.50 } ],
    "p50": [ { "date": "2026-04-25", "value": 42.80 } ],
    "p90": [ { "date": "2026-04-25", "value": 55.10 } ]
  },
  "error": null
}
```

Bands show the range of outcomes at different confidence levels:
- `p10` = 10th percentile (10% probability of lower outcome)
- `p50` = median (50th percentile; best-guess center)
- `p90` = 90th percentile (10% probability of higher outcome)

Use these to understand forecast uncertainty: wide bands = high uncertainty; narrow bands = high confidence.

**Category Breakdown (Phase G):**

If `include_breakdown=true`, the response includes a `category_breakdown` array with per-category actual, forecast, and cumulative series:

```json
{
  "category_breakdown": [
    {
      "category_id": 5,
      "general": "Groceries",
      "detail": "Supermarket",
      "actual": [
        { "date": "2026-04-01", "net": 45.50, "cumulative": 45.50 },
        { "date": "2026-04-02", "net": -10.00, "cumulative": 35.50 }
      ],
      "forecast": [
        { "date": "2026-04-25", "value": 42.15 },
        { "date": "2026-04-26", "value": 48.30 }
      ],
      "cumulative": [
        { "date": "2026-04-01", "value": 45.50 },
        { "date": "2026-04-25", "value": 1234.65 }
      ]
    }
  ]
}
```

**Reconciliation Logic:**
- Each category receives a simple-average forecast based on its own history
- Per-category forecasts are then scaled so that Σ categories = aggregate simple-average forecast for each future date
- Ensures bottom-up consistency: sum of all category forecasts always equals the aggregate forecast
- Actual and cumulative series reflect true per-category realized amounts and running totals

**Walk-Forward Backtest Diagnostics:**

If `include_backtest=true`, the response includes per-method accuracy metrics:

```json
{
  "diagnostics": {
    "history_months": 36,
    "backtest": [
      {
        "method_id": "simple_avg",
        "label": "Simple Average",
        "mae": 125.45,
        "rmse": 165.30,
        "mape": 8.2,
        "months": 36,
        "per_month": [
          { "month": "2025-12", "mae": 115.20, "rmse": 155.80, "mape": 7.8, "sample_days": 28 }
        ]
      }
    ]
  }
}
```

**Metric definitions:**

| Metric | Unit | Interpretation |
|--------|------|-----------------|
| **MAE** | Currency (EUR/USD/etc.) | Average magnitude of errors. Lower is better. Useful for absolute error bounds. |
| **RMSE** | Currency | Penalizes large errors more heavily than MAE. Lower is better. Sensitive to outliers. |
| **MAPE** | % | Mean Absolute Percentage Error. Useful for comparing across different currency scales. Lower is better. |
| **months** | Count | Number of historical windows in backtest (typically = `history_months - 1`) |
| **sample_days** | Count | Total days used in backtest (sum across all `per_month` entries) |

**Example use case:**

If `simple_avg` has MAPE=8.2% and `ewma` has MAPE=6.5%, then EWMA is historically more accurate on your data. Phase D (ensemble weighting) will use these metrics to automatically weight methods.

## Use Cases

### Phase 6: Planned Projection Use Cases

### 1. Budget Planning

"How much will I spend next quarter?"

```
GET /api/aggregations/cashflow-forecast?months=3
→ Review expenses column for each month
→ Sum total or identify peak expense months
```

### 2. Runway Analysis

"How long can I survive on savings given my recurring expenses?"

```
GET /api/aggregations/cashflow-forecast?months=12
→ Find first month where net < 0
→ Compare cumulative net against savings balance
```

### 3. Cash Shortfall Detection

"Which months will I run out of money?"

```
GET /api/aggregations/cashflow-forecast?months=6
→ Check for negative net months
→ Identify which planned transactions are causing shortfall
```

### 4. Income Stability Check

"Do I have consistent income forecasted?"

```
GET /api/aggregations/cashflow-forecast?months=12
→ Review income column consistency
→ Flag months with missing or reduced income
```

### Phase 10: Multi-Method Statistical Forecast Use Cases

#### 1. Rest-of-Month Cash Position

"What will my cash balance be at month-end?"

```
GET /api/aggregations/cashflow-forecast-methods?include_backtest=false
→ Review methods[] cumulative values for last day of month
→ Multiple methods give range of plausible outcomes
→ Use median (p50) as best-guess; p10/p90 as uncertainty bounds
```

#### 2. Method Comparison & Selection

"Which forecasting method works best on my spending patterns?"

```
GET /api/aggregations/cashflow-forecast-methods?include_backtest=true
→ Review diagnostics.backtest[] MAE/RMSE/MAPE
→ Identify best-performing method(s) for your data
→ Low MAPE indicates robust method; high spread indicates unstable
```

#### 3. Uncertainty Quantification

"How confident are we in the forecast?"

```
GET /api/aggregations/cashflow-forecast-methods?mc_paths=5000
→ Review Monte Carlo confidence bands (p10, p50, p90)
→ Narrow bands = high confidence; wide bands = uncertain month
→ Use p10 for pessimistic planning; p90 for optimistic scenario
```

#### 4. Seasonal & Trend Detection

"Are there patterns in my spending?"

```
GET /api/aggregations/cashflow-forecast-methods
→ Compare Holt-Winters (captures seasonality) vs. EWMA (trend-only)
→ If Holt-Winters MAPE < EWMA MAPE, you have strong seasonality
→ Use Prophet Lite to see piecewise trend changes
```

## Monetary Precision

All amounts are serialized as JSON numbers and are safe to 2 decimal places (cents). Values are computed using Decimal.js on the backend to eliminate IEEE 754 floating-point errors. See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] for details.

## Multi-Currency Considerations

**Important:** The forecast does not convert between currencies. If you have planned transactions in multiple currencies (e.g., EUR salary and USD stock dividends), the forecast will show them separately:

```
2026-05:
  EUR: income +3500, expenses -1200, net +2300
  USD: income +200, expenses 0, net +200
  (not combined into a single "net")
```

Plan for this when reviewing the forecast. Use [[docs/features/exchange-rates|Exchange Rates]] separately to convert to a reporting currency if needed.

## Limitations

### Phase 6 (Planned Projection)

1. **No FX conversion** — Amounts stay in source currency
2. **No tax estimates** — Forecast amounts are gross, before taxes
3. **No interest accrual** — Savings/loans don't earn/accrue interest in forecast
4. **Corporate actions ignored** — Stock splits, dividends not factored into planned transaction forecasts (use portfolio snapshots for that)
5. **Manual executions not predicted** — If you execute a planned transaction early, forecast still shows it at planned date

### Phase 10 (Multi-Method Statistical Forecast)

1. **Current month only** — Forecasts remaining days of current month (not future months; use Phase 6 for that)
2. **Requires historical data** — Methods need ≥60 days of history to be accurate; Prophet Lite returns zeros below threshold
3. **No anomaly detection** — Outlier days treated same as normal; Phase B will add robust estimation
4. **Fixed EWMA α** — Default α=0.15 is tuned for general spending; Phase D ensemble weighting will personalize
5. **Limited holiday handling** — Prophet Lite includes Belgian holidays only; custom holidays not yet supported (Phase B)
6. **Stationary assumption** — Block bootstrap assumes residuals are stationary; structural breaks in spending patterns may reduce accuracy
7. **No intervention modeling** — One-time large transactions (e.g., car purchase, medical event) treated as normal variation; Phase B will add manual adjustment
8. **Determinism requires user ID** — Seeded PRNG uses user ID for reproducibility; shared or multi-tenant scenarios will see identical forecasts without user context

## Best Practices

1. **Keep planned transactions up-to-date** — Delete executed transactions so they don't appear in forecast
2. **Review monthly** — Update forecast periodically as new bills/income become known
3. **Use with budgets** — Compare forecast against budgeted amounts for variance analysis
4. **Handle unusual months** — Mark one-time bonuses or vacation expenses explicitly (they clutter averages)
5. **Combine approaches** — Use Phase 6 for known upcoming events; Phase 10 for remaining uncertainty
6. **Trust metrics** — When choosing a method, prefer highest MAPE or lowest RMSE over gut feel

## Related Features

- [[docs/features/plannedTransactions|Planned Transactions]] — Core planned transaction management
- [[docs/features/aggregations|Aggregations]] — Server-computed stats and metrics
- [[docs/api/aggregations|Aggregations API]] — Technical endpoint reference (includes Phase 10 endpoint schema)
- [[docs/features/exchange-rates|Exchange Rates]] — FX conversion for multi-currency scenarios
- [[docs/reference/data-model#cashflow_forecast_accuracy (migration 0012)|Data Model — cashflow_forecast_accuracy/_mc/_mc_rolling]] — schema reference for the three persistence tables

## Roadmap

**Phase B (Planned):** Robust estimation, anomaly detection, manual intervention modeling

**Phase C (Complete):** Frontend dashboard visualization with 8-method chart (7 base + ensemble), controls, MC bands, and diagnostics panel

**Phase D (Complete):** Postgres persistence of monthly accuracy metrics (MAE/RMSE/MAPE per method); diagnostics panel updated to fetch and display persisted history with sparklines; fallback to in-memory store on DB table missing

**Phase E (Complete):** Nightly materialized Monte Carlo cache + cache-aware endpoint. Precomputes forecasts for all active users daily (via `refreshCashflowForecastMc` nightly job). Daytime requests check 6-hour TTL cache before computing live. Response envelope includes `source: 'cache' | 'live'` indicator.

**Phase F (Complete):** Ensemble method (inverse-MSE weighted combination of point-estimate forecasts). Uses persisted accuracy metrics to weight methods; runs after point methods and falls back to equal weights on first run or when accuracy data unavailable. Included in response as 8th method (`ensemble_imse`).

**Phase G (Complete):** Per-category breakdown with hierarchical reconciliation. Adds `include_breakdown` query param to forecast-methods endpoint; returns structured `category_breakdown` array showing per-category actual, forecast, and cumulative series with automatic scaling to aggregate.

## Architecture Notes

### Phase 6: Planned Projection

**Implementation:** [[apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js]]

Pure calculation module with no I/O; called by aggregations route. Returns structured forecast data suitable for dashboard widgets, charts, and detailed analysis views.

**Repository method:** `plannedTransactionRepository.getForForecast(months)` — Fetches only active, unexecuted planned transactions within the window.

**Computational complexity:** O(N × M) where N = number of planned transactions, M = number of months. For typical forecasts (N < 100, M ≤ 24), negligible.

### Phase 10: Multi-Method Statistical Forecast

**Implementation:** [[apps/node-backend/src/services/calculations/forecast/index.js]]

Modular forecast orchestrator with 7 pluggable methods:
- **Methods:** `simpleAverage.js`, `weightedAverage.js`, `ewma.js`, `holtWinters.js`, `prophetLite.js`, `monteCarloParametric.js`, `monteCarloBlockBootstrap.js`
- **Utilities:** `seasonality.js` (hierarchical bucketization), `prng.js` (seeded RNG), `backtest.js` (walk-forward validation), `accuracyStore.js` (in-memory accuracy tracking), `be.js` (Belgian holidays)
- **Orchestrator:** `index.js` (`computeCashflowForecast()`) — Routes requests, invokes all methods, runs optional backtest, wraps with envelope

**Data flow:**
1. Route handler parses query params (currency, exclusions, history_months, mc_paths, mc_percentiles, include_planned, include_backtest)
2. Orchestrator calls `infoRepository.getCashflowForecastData()` to fetch actual + planned for current month + history
3. All 7 methods run in parallel (5 point forecasts + 2 MC methods)
4. If `include_backtest=true`, walk-forward validation runs: for each historical month, refit all methods and score against actuals
5. Daily forecasts folded into cumulative series; actual-to-date prepended; optional planned overlay applied
6. Response wrapped in aggregation envelope with `source: 'live'` and `computedAt` timestamp

**Computational complexity:**
- Point methods: O(H × D) where H = history_months, D = days_in_month ≈ O(H) 
- MC methods: O(paths × D) per method
- Backtest: O(H × 7 methods × H) ≈ O(H²)
- Typical: history_months=36, mc_paths=1000 → <500ms end-to-end on modern CPU

**Determinism & Caching:**
- Seeded PRNG (`fnv1a_hash(userId | yyyymm | filterHash)`) ensures identical Monte Carlo samples across requests
- Enables Phase D ensemble weighting + Phase F caching without loss of reproducibility
- No external state; methods are pure functions of history + config

**Repository method:** `infoRepository.getCashflowForecastData(historyMonths, excludedCategoryIds, excludedRecipientIds, targetCurrency)` — Fetches realized transactions (actual + history) + pending planned transactions for current month.

**Error handling:** If any method throws, it returns zeros for that method's series with `error: 'forecast_failed'`; other methods unaffected. Frontend can display partial results or skip errored methods.

### Phase D: Accuracy Persistence & Diagnostics Dashboard Update

**New Table:** `cashflow_forecast_accuracy` (created by Alembic migration 0012)
- Columns: id (serial PK), user_id (text, default 'anonymous'), method_id (text), as_of_month (text, YYYY-MM), mae (DOUBLE), rmse (DOUBLE), mape (DOUBLE), sample_days (int), recorded_at (timestamptz)
- Unique constraint on (user_id, method_id, as_of_month)
- Indexes on (user_id, method_id) and (as_of_month)
- Stores monthly backtest results from nightly batch jobs or manual updates

**New Repository:** `cashflowForecastAccuracyRepository` (`apps/node-backend/src/repositories/cashflowForecastAccuracyRepository.js`)
- Methods: `upsert()`, `getHistory()`, `getLatestByMethod()`, `getAllHistory()`
- Idempotent upsert per (user_id, method_id, as_of_month)
- Retrieves full history grouped by method for sparkline construction

**Rewrote accuracyStore:**  `apps/node-backend/src/services/calculations/forecast/accuracyStore.js`
- Now delegates to Postgres via repository
- **Fallback (April 2026):** when table is missing or Postgres is unreachable, reverts to in-memory Map for backward compatibility
  - Triggers on error codes: `42P01` (undefined_table), `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`
  - Enables dev/test environments without a running PostgreSQL instance
  - Fallback is silent; forecast endpoints remain usable
- Enables nightly batch persistence without requiring restart

**New Endpoint:** `GET /api/aggregations/cashflow-forecast-accuracy`
- Query params: `limit_months` (default 24)
- Returns per-method latest accuracy + full time-series history (24 months)
- Grouped by method_id with each entry showing: latest MAE/RMSE/MAPE, as_of_month, plus history array for sparklines
- Useful for trend analysis; sparkline visualization in diagnostics panel

**Updated Frontend Diagnostics Component:**
- Fetches persisted accuracy history via `useQuery(getCashflowForecastAccuracy)` when sheet opens
- staleTime 10 minutes (avoid excessive refetch)
- Prioritizes DB history for longer trend visibility; falls back to current session backtest if unavailable
- Sparkline chart per method shows MAE trend across 24 months

### Phase E: Nightly MC Materialization & Cache-Aware Endpoint

**New Table:** `cashflow_forecast_mc` (created by Alembic migration 0013)
- Columns: id (serial PK), user_id (text, default 'anonymous'), month (text, YYYY-MM), filter_hash (text), mc_paths (int, default 1000), payload (JSONB), computed_at (timestamptz, default NOW())
- Unique constraint on (user_id, month, filter_hash)
- Index on (user_id, month) for nightly job queries
- Stores precomputed forecast payloads: methods, actual, planned, diagnostics

**New Repository:** `cashflowForecastMcRepository` (`apps/node-backend/src/repositories/cashflowForecastMcRepository.js`)
- Methods:
  - `get({ userId, month, filterHash })` — Fetch cached payload and computed_at timestamp
  - `isFresh(computedAt)` — Check if cached data is within 6-hour TTL
  - `upsert({ userId, month, filterHash, mcPaths, payload })` — Idempotent cache write (updates computed_at on conflict)
  - `getActiveUserIds()` — Fetch distinct user IDs from cashflow_forecast_accuracy table; fallback to ['anonymous'] if table is missing; used by nightly job

**New Job:** `refreshCashflowForecastMc` (`apps/node-backend/src/jobs/refreshCashflowForecastMc.js`)
- Runs nightly (every 24 hours, scheduled in main.js via `setInterval`)
- Calls `computeCashflowForecast()` for each active user with `includeBacktest: true, _forceCache: true`
- Writes successful computations to cache table; logs per-user success/failure
- Export: `refreshCashflowForecastMc()` (callable from main.js or tests)

**Cache-Aware Forecast Orchestrator:** Updated `apps/node-backend/src/services/calculations/forecast/index.js`
- New parameter `_forceCache` (default false; internal use by nightly job)
- Before computing: checks DB cache if not _forceCache and using default MC params (1000 paths, [10,50,90] percentiles)
  - Returns cached result if fresh (<6h) AND diagnostics condition met (cached.payload.diagnostics != null || !includeBacktest)
  - Response envelope includes `source: 'cache'` in meta
- After computing: always writes to cache asynchronously (non-blocking) if default MC params
  - Response envelope includes `source: 'live'` in meta
- Fallback: cache read/write errors logged but don't abort computation

**Response Envelope Changes:**
- All forecast responses now include `meta.source: 'cache' | 'live'` to indicate whether result came from materialized cache or was computed fresh
- Example:
  ```json
  {
    "ok": true,
    "data": {
      "data": { /* forecast payload */ },
      "meta": {
        "source": "cache",
        "computedAt": "2026-04-24T06:00:00.000Z"
      }
    },
    "meta": { "requestId": "..." }
  }
  ```

**Performance Impact:**
- Daytime requests with default MC params: O(1) cache lookup + validation (~5ms), vs. O(paths × days) live computation (~300-500ms)
- Nightly job: runs sequentially per user; typical 36-month history + 1000 paths ≈ 300-500ms per user; runs once daily
- Cache TTL 6 hours ensures stale forecasts are refreshed periodically

### Phase F: Ensemble Method (Inverse-MSE Weighting)

**New Method:** `ensemble_imse` — 8th forecasting method that weights point-estimate methods by inverse-MSE (1/RMSE²) of historical accuracy.

**Implementation:** `apps/node-backend/src/services/calculations/forecast/methods/ensemble.js`
- `id = 'ensemble_imse'`, `label = 'Ensemble (inv-MSE)'`
- `computeWeights(accuracyRows, methodIds)` — Derives per-method weights using inverse-MSE normalization; filters out methods with RMSE ≤ 0; returns normalized Map summing to 1; returns empty map when no accuracy data available
- `forecast({ forecastDates, methodOutputs, weights })` — Computes weighted-average daily forecasts across point methods (excludes MC methods and errored methods); falls back to equal weights when weights map is empty
- Not included in `POINT_METHODS` or `MC_METHODS` — excluded from walk-forward backtest to avoid circular dependency on accuracy metrics it consumes

**Orchestrator Integration:** Updated `apps/node-backend/src/services/calculations/forecast/index.js`
- Ensemble runs after all 7 point+MC methods
- `getLatestAccuracyByMethod()` wrapped in try-catch; falls back to `[]` if DB unreachable
- Returns ensemble result as 8th method in `methodOutputs` array
- Frontend receives 8 methods total: 5 point + 2 MC + 1 ensemble

**Characteristics:**
- **Weighted by accuracy** — Methods with lower historical RMSE receive higher weight
- **Dynamic weighting** — Ensemble weights adapt as accuracy metrics are updated by nightly job
- **Fallback to equal weights** — On first run (no accuracy data), treats all methods equally (1/5 weight per point method)
- **Data-driven** — No tuning parameters; weights purely from persisted accuracy history
- **Deterministic** — Same input → same weights (unlike ensemble variants with bagging or stochastic combination)

**Response Shape:**

When requesting `GET /api/aggregations/cashflow-forecast-methods`, the response `methods[]` array now includes the ensemble as 8th entry:

```json
{
  "id": "ensemble_imse",
  "label": "Ensemble (inv-MSE)",
  "daily": [
    { "date": "2026-04-25", "value": 42.15 },
    { "date": "2026-04-26", "value": 39.80 }
  ],
  "cumulative": [ /* ... */ ],
  "bands": null,
  "error": null
}
```

Additionally, the diagnostics section includes ensemble weights:

```json
{
  "diagnostics": {
    "ensemble_weights": {
      "simple_avg": 0.12,
      "weighted_avg": 0.18,
      "ewma": 0.22,
      "holt_winters": 0.28,
      "prophet_lite": 0.20
    }
  }
}
```

### Phase G: Category Breakdown with Reconciliation

**New Module:** `categoryBreakdown.js` — Per-category forecast breakdown computation.

**Public API:**
- `buildCategoryBreakdown({ historyByCategory, currentActualByCategory, future, all, todayDay, referenceDaily })` — Takes per-category history and aggregates reference forecast (simple_avg), returns per-category breakdown with hierarchical reconciliation applied
- `reconcileCategoryForecasts(categoryForecasts, future, refByDate)` — Scales per-category forecasts so Σ = aggregate simple-avg for each future date; ensures bottom-up consistency

**Data flow:**
1. Request includes `include_breakdown=true` query param
2. Orchestrator calls `getCashflowForecastDataByCategory()` to fetch per-category history and actuals
3. `buildCategoryBreakdown()` computes per-category simple-average forecasts
4. `reconcileCategoryForecasts()` scales each category's forecast by factor: `aggregate_reference / sum_of_category_forecasts` per date
5. Returns `category_breakdown` array nested in main response envelope
6. Breakdown never cached; live computation only (always `source: 'live'` when `include_breakdown=true`)

**New Repository Method:** `getCashflowForecastDataByCategory(historyMonths, excludedCategoryIds, excludedRecipientIds, targetCurrency)`
- Returns `{ historyByCategory, currentActualByCategory }`
- Per-row structure: `{ date, category_id, general, detail, net }`
- Effective category resolved via `COALESCE(t.category_id, r.default_category_id, pr.default_category_id)`
- Respects same exclusion filters as aggregate forecast
- Currency converted to target via `batchConvertGroupsWithHistoricalRateFallback()`

**Characteristics:**
- **Bottom-up consistency** — Sum of per-category forecasts always equals aggregate forecast per date
- **Category-aware history** — Learns category-specific patterns from historical actuals
- **Cost-efficient** — Per-category simple-average is O(categories × days); reconciliation is O(categories × future_days)
- **Cache-bypass** — Not cached; always computed fresh when requested (differs from Phase E cache behavior)

### Phase C: Frontend Components

**CashFlowForecastChart** (`apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx`):
- Entry point for dashboard forecast widget
- Props: `excludedCategoryIds`, `excludedRecipientIds`, `currency`
- State:
  - `view` (cumulative | daily-net) via Tabs component
  - `includePlanned` boolean via Switch (triggers refetch)
  - `visibleMethodIds` Set<string> initialized to `DEFAULT_VISIBLE_METHOD_IDS` (5 point methods + ensemble; Monte Carlo methods hidden by default)
  - Per-method visibility toggles via pill buttons
  - Diagnostics sheet open/closed state
- Constants:
  - `ALL_METHOD_IDS` = [simple_avg, weighted_avg, ewma, holt_winters, prophet_lite, ensemble_imse, monte_carlo_parametric, monte_carlo_block_bootstrap]
  - `DEFAULT_VISIBLE_METHOD_IDS` = [simple_avg, weighted_avg, ewma, holt_winters, prophet_lite, ensemble_imse] (excludes Monte Carlo methods)
- Renders:
  - Multi-line/area chart with actual-to-date + visible 8-method daily forecasts (7 base + ensemble)
  - Dashed LineSeries for MC P10/P90 bands (only when MC methods are toggled on)
  - Cumulative sum when view = cumulative
  - Planned transaction dates as vertical markers (if includePlanned = true)
  - Method legend with color swatch and label
- Self-contained `useQuery(getCashflowForecastMethods)` with params derived from props and local state

**CashFlowForecastDiagnostics** (`apps/frontend/src/components/dashboard/CashFlowForecastDiagnostics.tsx`):
- Right-side Sheet panel showing backtest results (Phase C) and persisted accuracy history (Phase D)
- Props: `diagnostics` (from chart parent), `open` boolean, `onOpenChange` callback
- Data loading:
  - Enabled only when sheet is open (lazy)
  - Fetches persisted accuracy history via `useQuery(getCashflowForecastAccuracy)` with staleTime 10 minutes
  - Falls back to current backtest data if table is missing or Postgres is unreachable (error codes: 42P01, ECONNREFUSED, ENOTFOUND, ETIMEDOUT)
- Renders:
  - Accuracy table (MAE/RMSE/MAPE, sorted by MAE ascending) — displays latest DB history per method
  - Rank badge per method (1st, 2nd, 3rd place)
  - Per-method MAE sparkline (visual trend from DB history, 24-month limit)
  - Ensemble weights bar chart (inverse-MSE normalized, read-only preview)
  - Informational note distinguishing backtest (current session) vs. persisted history (nightly updates)

## Phase H: Rolling-Window View

A second view inside `CashFlowForecastChart` that decouples the forecast from
calendar-month boundaries. Where the month view shows rest-of-current-month
only, the rolling view shows a continuous date timeline centred on today.

### User-facing behaviour

- Top-level `Tabs` segmented control on the card: `[Current month | Rolling window]`. Local state, default `month`.
- When `Rolling window` is active, a preset chip row appears: `30 / 60 / 90 / 180` days. Default `90`. Same N applied symmetrically to past actuals and future forecast.
- Chart X axis switches from day-of-month integer to a date scale, with a vertical dashed reference line at today.
- Cumulative balance, daily net, MC P25/P75 confidence band, and planned-transaction overlay all work in both views.
- Diagnostics button now available in rolling mode (lazy-loaded: walk-forward backtest runs only when diagnostics sheet opens, avoiding on-load cost).

### Endpoint

**Path:** `GET /api/aggregations/cashflow-forecast-rolling`

**Query parameters**

| Parameter | Type | Default | Max | Notes |
|-----------|------|---------|-----|-------|
| `days_back` | integer | 90 | 365 | Past actuals window. |
| `days_forward` | integer | 90 | 365 | Forward forecast window. |
| `currency` | string | EUR | — | ISO 4217. |
| `excluded_category_ids[]` | int array | [] | — | |
| `excluded_recipient_ids[]` | int array | [] | — | |
| `include_planned` | boolean | false | — | Adds planned txns to cumulative. |
| `mc_paths` | integer | 500 | 5000 | Rolling-window-specific default (distinct from month view 1000). |
| `mc_percentiles[]` | int array | [25,75] | — | Rolling-window-specific defaults (distinct from month view [10,50,90]). |
| `history_months` | integer | 36 | 120 | Pre-window history fed to methods. |
| `include_backtest` | boolean | false | — | Optional walk-forward backtest diagnostics (lazy-loaded on diagnostics sheet open). |

`days_back + days_forward > 730` returns 400.

> [!info] Rolling Window MC Defaults
> Rolling window mode uses separate MC parameter defaults (500 paths, P25/P75 percentiles) compared to month view (1000 paths, P10/P50/P90). This reflects the rolling window's broader horizon: more paths would be computationally expensive for 180+ day forecasts. The cache gate checks for these rolling-specific defaults; frontend requests automatically use these values.

**Response shape**

```json
{
  "data": {
    "window_start": "2026-01-28",
    "window_end": "2026-07-27",
    "today": "2026-04-28",
    "currency": "EUR",
    "days_back": 90,
    "days_forward": 90,
    "actual": [{ "date": "2026-01-28", "net": 12.34, "cumulative": 12.34 }, ...],
    "methods": [{ "id": "simple_avg", "label": "...", "daily": [...], "cumulative": [...], "bands": null, "error": null }, ...],
    "planned": [{ "date": "2026-05-01", "net": -1200 }, ...],
    "diagnostics": null,
    "history_months": 36,
    "include_planned": false
  },
  "meta": { "source": "live", "computedAt": "..." }
}
```

### Engine reuse

- The 8 method modules in `apps/node-backend/src/services/calculations/forecast/methods/` are date-agnostic — they accept any `forecastDates: string[]`. No method-file changes were needed.
- `runForecastEngine(...)` is the shared orchestration helper extracted from `computeCashflowForecast`. Both the month and rolling entry points feed it different anchor + forecast date arrays.
- Repository helper `getCashflowForecastDataRolling(historyMonths, daysBack, daysForward, ...)` lives in `apps/node-backend/src/repositories/infoRepo.forecast.js`. History SQL ends at `today - daysBack` to avoid overlap with `currentActual`.

### Cumulative anchor

Cumulative is **window-relative**: starts at the first actual `net` at `today - days_back`, not absolute account balance. The chart answers "how does my net position move across the window?", not "what is my actual bank balance?".

### MC seed key

```
seed = fnv1aHash(`${userId}|${todayIso}|${daysBack}|${daysForward}|${filterHash}`)
```

Same-day calls with identical params return identical bands (deterministic). Day-rollover invalidates the seed — bands shift the next day. This is intentional and not cached server-side.

### Caching omitted (v1)

The `cashflow_forecast_mc` table key is `(user_id, month, filter_hash)` — a month string. Overloading it for rolling windows would break that schema. v1 ships without rolling cache; React Query `staleTime: 60_000` on the frontend absorbs interactive churn. If perf budgets are missed, a separate `cashflow_forecast_mc_rolling` table keyed by `(user_id, today, days_back, days_forward, filter_hash)` is the planned escape hatch.

### Diagnostics omitted (v1)

Walk-forward backtest is per-calendar-month: it iterates historical months and measures end-of-month forecast error. Reformulating it for an arbitrary rolling window requires a new harness — out of scope for v1. The diagnostics `Button` is hidden when `mode === 'rolling'`.

### Performance budget

180 forecast days × 8 methods × 1000 MC paths is roughly 5–10× the current-month cost. Holt-Winters grid search is bounded by history length (constant), MC scales linearly with horizon. Target p95 < 1500ms at `days_forward=180`. Frontend asks for `mc_paths=500` so MC cost is halved.

### Frontend wiring

- `apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx` owns `mode` and `rollingDays` state, branches between two `useQuery` calls (one enabled at a time), and renders either `ForecastInner` or `ForecastInnerRolling`.
- `apps/frontend/src/components/dashboard/ForecastInnerRolling.tsx` uses `LineChart` with `xIsDate` and a vertical reference line at `data.today`. X-axis month abbreviations use the app **language** setting (`language === "nl" ? "nl-NL" : "en-US"`), matching the canonical pattern from `NetWorthPage` and `PerformancePage`. The y-axis currency formatter independently uses `numberFormatToLocale(appSettings.numberFormat)`. See [[docs/components/dashboard#ForecastInnerRolling (Phase H)|ForecastInnerRolling component doc]] for the fix rationale.
- `apps/frontend/src/utils/forecastMerge.ts` exports `mergeForViewRolling` that produces date-keyed `MergedDayDate[]` rows (with `t: Date`) instead of dayNum-keyed rows.
- `apps/frontend/src/components/charts/LineChart.tsx` extends `LineReferenceLine` to support an optional `x: Date | number` field for vertical reference lines (backwards-compatible with existing `y` references).

## Phase H v2: URL Persistence

The `mode` and `rollingDays` parameters are persisted to the URL via `useSearchParams` from `react-router-dom`:

- **Query params:** `forecastMode=rolling` (default: `month`), `rollingDays=90` (default: `90`)
- **Navigation example:** `/?forecastMode=rolling&rollingDays=180` opens the dashboard in rolling mode with 180-day window
- **History:** Setters use `{ replace: true }` to avoid building browser history; users can bookmark URL states for quick access to preferred forecast views
- **Implementation:** `CashFlowForecastChart.tsx` extracts params via `useSearchParams().get()` on mount and updates via `setSearchParams(..., { replace: true })` when user toggles mode or rolling days

## Phase H v2: Rolling MC Cache

The rolling forecast endpoint now uses a dedicated materialized cache table:

**New Table:** `cashflow_forecast_mc_rolling` (created by Alembic migration 0016)
- Columns: id (serial PK), user_id (text, default 'anonymous'), today_iso (text, YYYY-MM-DD), days_back (int), days_forward (int), filter_hash (text), mc_paths (int, default 1000), payload (JSONB), computed_at (timestamptz, default NOW())
- Unique constraint on `(user_id, today_iso, days_back, days_forward, filter_hash)` ensures idempotent cache writes
- Index on `(user_id, today_iso)` for cache freshness lookups by user and date

**New Repository:** `cashflowForecastMcRollingRepository` (`apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js`)
- Methods:
  - `get({ userId, todayIso, daysBack, daysForward, filterHash })` — Fetch cached payload and computed_at timestamp
  - `isFresh(computedAt)` — Check if cached data is within 6-hour TTL
  - `upsert({ userId, todayIso, daysBack, daysForward, filterHash, mcPaths, payload })` — Idempotent cache write (updates computed_at on conflict)

**Cache-Aware Rolling Orchestrator:** Updated `computeCashflowForecastRolling()` in `apps/node-backend/src/services/calculations/forecast/index.js`
- Before computing: checks DB cache if using default MC params (1000 paths, [10,50,90] percentiles)
  - Returns cached result if fresh (<6h)
  - Response envelope includes `source: 'cache'` in meta
- After computing: writes to cache asynchronously if default MC params (non-blocking)
  - Response envelope includes `source: 'live'` in meta
- Cache skip: when `includeBacktest=true` (backtest requires fresh computation)
- Fallback: cache read/write errors logged but don't abort computation

## Phase H v2: Rolling Diagnostics (Lazy-Loaded)

The rolling forecast now supports walk-forward backtesting and diagnostics via optional `include_backtest` query param. The backtest is **lazy-loaded**: it runs only when the user opens the diagnostics sheet, avoiding on-load computation cost.

**New Function:** `walkForwardBacktestRolling()` in `apps/node-backend/src/services/calculations/forecast/backtest.js`
- Runs rolling walk-forward backtest across default 8 windows
- Returns `ForecastDiagnostics`-compatible payload with `window_end` mapped to `month` field for UI consistency
- Shares same `ForecastDiagnostics` interface as month-mode backtest for unified diagnostics sheet

### Date Validation (Bug-Hunt Sweep 2026-05-08)

**Issue:** Rolling forecast view builds chart x-axis from actual and forecast dates. Malformed dates (e.g., from a truncated API response or data corruption) were passed to `new Date('Invalid…T00:00:00Z')`, silently producing `Invalid Date` objects and corrupting the chart rendering.

**Fix:** `mergeForViewRolling()` in `apps/frontend/src/utils/forecastMerge.ts` now filters `data.actual` dates with strict ISO format regex `^\d{4}-\d{2}-\d{2}$` before building rows. Invalid dates are silently dropped from the chart data. The filter runs at the merge boundary; invalid dates in the upstream API response are never exposed to the chart component.

**Code:**
```typescript
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const allDates = data.actual.map((p) => p.date).filter((d) => ISO_DATE_RE.test(d));
```

**Route Update:** `GET /api/aggregations/cashflow-forecast-rolling` now accepts `include_backtest` query param
- Default: `false` (omitted, no backtest; main rolling chart query excludes expensive backtest computation)
- When `true`: runs rolling walk-forward backtest and includes `diagnostics` in response payload
- Backtest skipped in main query by design (see **Lazy Diagnostics** below)

**Frontend Lazy Diagnostics:**
- `CashFlowForecastChart.tsx` maintains two separate rolling queries:
  - **Main rolling query:** `getCashflowForecastRolling({ ..., include_backtest: false })` — always runs, feeds the chart
  - **Diagnostics query:** `getCashflowForecastRolling({ ..., include_backtest: true })` — only enabled when `mode === "rolling" && showDiagnostics === true`, with `staleTime: 300_000` (5 minutes)
- Diagnostics sheet reads from `rollingDiagnosticsQuery.data?.diagnostics` when in rolling mode
- When user closes the diagnostics sheet, the expensive backtest query is disabled, avoiding wasted computation
- This pattern mirrors month-mode diagnostics but applies lazy-loading to reduce typical rolling window load cost

**Data Model Update:**
- Frontend type `CashflowForecastRollingData.diagnostics` is `ForecastDiagnostics | null`
- Rolling API response includes optional `diagnostics` field (same structure as month-mode diagnostics) only when `include_backtest=true`
- Main chart response has `diagnostics: null` when using default `include_backtest: false`
