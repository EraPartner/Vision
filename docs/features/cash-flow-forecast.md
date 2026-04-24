---
title: Cash Flow Forecast
type: feature
status: active
date: 2026-04-24
tags: [feature, cash-flow, forecast, planning, aggregations, phase-6, planned-transactions]
aliases: [cashflow-forecast, forward-projections, cash-flow-planning, income-expense-forecast, budget-projection]
description: Project income and expenses forward based on active, unexecuted planned transactions
related_code:
  - apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js
  - apps/node-backend/src/routes/aggregations.js
  - apps/node-backend/src/repositories/plannedTransactionRepository.js
---

# Cash Flow Forecast

Vision's cash flow forecast projects your future monthly cash position by expanding active, unexecuted planned transactions over a rolling forecast window. Use this to plan for upcoming bills, subscriptions, and recurring expenses.

## Overview

The cash flow forecast takes all active planned transactions and expands them into future occurrences based on their recurrence pattern (if recurring) or their planned date (if one-time). It then groups these occurrences by month, summing income and expenses to show your projected monthly cash position.

**Key characteristics:**
- **Forward-looking** — Shows N months ahead (default 3, max 24)
- **Non-convertible** — All amounts stay in their original currency (future FX rates unknown)
- **Real-time** — Computed on-demand; does not require pre-calculation
- **Recurring-aware** — Expands recurring transactions into individual monthly occurrences

## Conceptual Model

```
Forecast Window: today → today + N months

For each active, unexecuted planned transaction:
  If not recurring:
    Include once at planned_date (if within window)
  If recurring:
    Expand forward using recurrence_pattern until window end
    (e.g., "monthly on the 15th" → 15th of each month)

Group expanded occurrences by month:
  income   = sum of positive amounts
  expenses = sum of negative amounts (negative value)
  net      = income + expenses

Return monthly buckets with items detail.
```

## Endpoint

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

## Use Cases

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

1. **No FX conversion** — Amounts stay in source currency
2. **No tax estimates** — Forecast amounts are gross, before taxes
3. **No interest accrual** — Savings/loans don't earn/accrue interest in forecast
4. **Corporate actions ignored** — Stock splits, dividends not factored into planned transaction forecasts (use portfolio snapshots for that)
5. **Manual executions not predicted** — If you execute a planned transaction early, forecast still shows it at planned date

## Best Practices

1. **Keep planned transactions up-to-date** — Delete executed transactions so they don't appear in forecast
2. **Review monthly** — Update forecast periodically as new bills/income become known
3. **Use with budgets** — Compare forecast against budgeted amounts for variance analysis
4. **Handle unusual months** — Mark one-time bonuses or vacation expenses explicitly (they clutter averages)

## Related Features

- [[docs/features/plannedTransactions|Planned Transactions]] — Core planned transaction management
- [[docs/features/aggregations|Aggregations]] — Server-computed stats and metrics
- [[docs/api/aggregations|Aggregations API]] — Technical endpoint reference
- [[docs/features/exchange-rates|Exchange Rates]] — FX conversion for multi-currency scenarios

## Architecture Notes

**Implementation:** [[apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js]]

Pure calculation module with no I/O; called by aggregations route. Returns structured forecast data suitable for dashboard widgets, charts, and detailed analysis views.

**Repository method:** `plannedTransactionRepository.getForForecast(months)` — Fetches only active, unexecuted planned transactions within the window.

**Computational complexity:** O(N × M) where N = number of planned transactions, M = number of months. For typical forecasts (N < 100, M ≤ 24), negligible.
