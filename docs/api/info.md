---
title: Info & Analytics API
type: api
status: active
date: 2025-03-18
tags: [api, analytics, statistics, dashboard]
description: API endpoints for statistics, analytics, and dashboard data
related_code: ["apps/node-backend/src/routes/info.js", "apps/node-backend/src/repositories/infoRepository.js"]
---

# Info & Analytics API

Comprehensive analytics and statistics endpoints for dashboards and financial insights.

## Base URL

```
/api/info
```

## Endpoints

### GET /api/info

Get general statistics about the workspace.

**Response:** `200 OK`

```json
{
  "total_transactions": 1250,
  "total_recipients": 45,
  "total_categories": 28,
  "total_investments": 15,
  "categories": [...]
}
```

---

### GET /api/info/banks

List all bank accounts in the workspace.

**Response:** `200 OK`

```json
{
  "banks": [
    { "id": 1, "name": "Main Account", "balance": 5000.00 }
  ]
}
```

---

### GET /api/info/supported-adapters

List all supported bank adapters.

**Response:** `200 OK`

```json
{
  "adapters": [
    { "key": "kbc", "name": "KBC", "adapter_class": "KBCAdapter" },
    { "key": "belfius", "name": "Belfius", "adapter_class": "BelfiusAdapter" },
    { "key": "revolut", "name": "Revolut", "adapter_class": "RevolutAdapter" },
    { "key": "vision", "name": "Vision", "adapter_class": "VisionAdapter" },
    { "key": "sabb", "name": "SABB", "adapter_class": "SABBAdapter" },
    { "key": "wise", "name": "Wise", "adapter_class": "WiseAdapter" }
  ],
  "total_count": 6
}
```

---

### GET /api/info/transaction-count

Get total number of transactions.

**Response:** `200 OK`

```json
{
  "total_transactions": 1250
}
```

---

### GET /api/info/transaction-summary

Get transaction summary with optional filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `bank_account` | string | Filter by bank account |
| `start_date` | date | Start date (YYYY-MM-DD) |
| `end_date` | date | End date (YYYY-MM-DD) |

**Response:** `200 OK`

```json
{
  "total_count": 150,
  "total_income": 5000.00,
  "total_expenses": -3200.00,
  "net": 1800.00
}
```

---

### GET /api/info/monthly-summary

Get monthly financial summary for the last 12 months.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `excluded_category_ids` | number[] | Categories to exclude |

**Response:** `200 OK`

```json
{
  "months": [
    {
      "month": "2025-03",
      "income": 5000.00,
      "expenses": -3200.00,
      "net": 1800.00
    }
  ],
  "summary": {
    "avg_income": 4800.00,
    "avg_expenses": -3100.00,
    "avg_net": 1700.00
  }
}
```

---

### GET /api/info/planned-expenses-next-month

Get planned expenses for next month.

**Response:** `200 OK`

```json
{
  "total": 1200.00,
  "items": [
    {
      "id": 1,
      "recipient": "Rent",
      "amount": 1000.00,
      "planned_date": "2025-04-01"
    }
  ]
}
```

---

### GET /api/info/average-vs-current-spending

Compare current month spending to historical average.

**Response:** `200 OK`

```json
{
  "current_month": "2025-03",
  "current_spending": 2500.00,
  "average_spending": 2800.00,
  "difference": -300.00,
  "percent_change": -10.7
}
```

---

### GET /api/info/cashflow-comparison

Compare cashflow between periods.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `excluded_category_ids` | number[] | Categories to exclude |
| `excluded_recipient_ids` | number[] | Recipients to exclude |

**Response:** `200 OK`

```json
{
  "current_period": {
    "income": 5000.00,
    "expenses": -3200.00,
    "net": 1800.00
  },
  "previous_period": {
    "income": 4500.00,
    "expenses": -2800.00,
    "net": 1700.00
  }
}
```

---

### GET /api/info/category-breakdown

Get spending breakdown by category.

**Response:** `200 OK`

```json
{
  "categories": [
    {
      "id": 1,
      "name": "FOOD:GROCERIES",
      "total": -450.00,
      "count": 15
    }
  ]
}
```

---

### GET /api/info/bank-balances

Get current and historical balances per bank account.

**Response:** `200 OK`

```json
{
  "accounts": [
    {
      "bank_account": "Main Account",
      "balance": 5000.00,
      "first_transaction": "2024-01-15",
      "last_transaction": "2025-03-18",
      "transaction_count": 450
    }
  ]
}
```

---

### GET /api/info/recurring-patterns

Detect recurring transaction patterns.

**Response:** `200 OK`

```json
{
  "patterns": [
    {
      "recipient_id": 1,
      "recipient_name": "Netflix",
      "amount": -15.99,
      "frequency": "monthly",
      "last_date": "2025-03-01"
    }
  ],
  "total": 1
}
```

---

### GET /api/info/net-worth

Get net worth combining bank balances + portfolio value.

**Response:** `200 OK`

```json
{
  "total_assets": 150000.00,
  "total_liabilities": 0,
  "bank_balance": 25000.00,
  "investment_value": 125000.00,
  "net_worth": 150000.00
}
```

---

### GET /api/info/recipient-insights

Get spending insights per recipient/merchant.

**Response:** `200 OK`

```json
{
  "recipients": [
    {
      "id": 1,
      "name": "Supermarket",
      "total_spent": -1200.00,
      "transaction_count": 25,
      "avg_transaction": -48.00,
      "last_transaction": "2025-03-15"
    }
  ]
}
```

---

### GET /api/info/exchange-rates

Get cached exchange rates from database.

**Response:** `200 OK`

```json
{
  "total_rates": 30,
  "rates": [
    { "currency": "USD", "rate_to_eur": 0.92, "rate_date": "2025-03-18" }
  ],
  "fallback_rates": { "USD": 0.917, "GBP": 1.176 }
}
```

---

### POST /api/info/exchange-rates/refresh

Force refresh exchange rates from ECB API.

**Response:** `200 OK`

```json
{
  "message": "Exchange rates refreshed from ECB"
}
```

---

### POST /api/info/refresh-views

Manually refresh materialized views.

**Response:** `200 OK`

```json
{
  "message": "Materialized views refreshed",
  "duration_ms": 150
}
```

---

## Use Cases

- **Dashboard**: Display key metrics on home screen
- **Reports**: Generate monthly/quarterly reports
- **Trends**: Analyze spending patterns over time
- **Budgeting**: Compare actual vs. expected spending

---

## Performance

These endpoints are optimized using:
- [[docs/performance/materialized-views]] - Pre-computed aggregations
- [[docs/performance/caching-strategies]] - Cached exchange rates

---

## See Also

- [[docs/api/index]] - API Index
- [[docs/features/transactions]] - Transactions Feature
- [[docs/performance/materialized-views]] - Materialized Views
