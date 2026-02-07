# Info Endpoints Documentation

## Overview

The `/api/info` endpoint group provides statistical information and reporting capabilities for the financial transaction
management system. These endpoints support REST Level 3 (HATEOAS) with full hypermedia controls, enabling API
discoverability and navigation.

## Table of Contents

- [OPTIONS /api/info](#options-apiinfo)
- [GET /api/info](#get-apiinfo)
- [GET /api/info/banks](#get-apiinfobanks)
- [GET /api/info/transaction-count](#get-apiinfotransaction-count)
- [GET /api/info/transaction-summary](#get-apiinfotransaction-summary)
- [GET /api/info/monthly-summary](#get-apiinfomonthly-summary)

---

## OPTIONS /api/info

### Overview

Discover available HTTP methods and sub-endpoints on the info resource. This endpoint implements REST Level 3 (HATEOAS)
by providing hypermedia links for API discoverability.

### Endpoint Details

- **HTTP Method:** `OPTIONS`
- **Path:** `/api/info`
- **Tags:** `info`
- **Authentication:** Not required (development)

### Response

#### Success Response (200 OK)

```json
{
  "methods": [
    {
      "method": "GET",
      "description": "Get overview statistics for the dashboard"
    },
    {
      "method": "OPTIONS",
      "description": "Discover available methods on this endpoint"
    }
  ],
  "links": [
    {
      "rel": "self",
      "href": "http://localhost:3002/api/info",
      "method": "GET",
      "title": "Get overview statistics"
    },
    {
      "rel": "banks",
      "href": "http://localhost:3002/api/info/banks",
      "method": "GET",
      "title": "List all bank accounts"
    },
    {
      "rel": "transaction-count",
      "href": "http://localhost:3002/api/info/transaction-count",
      "method": "GET",
      "title": "Get total transaction count"
    },
    {
      "rel": "transaction-summary",
      "href": "http://localhost:3002/api/info/transaction-summary",
      "method": "GET",
      "title": "Get transaction summary with filters"
    },
    {
      "rel": "monthly-summary",
      "href": "http://localhost:3002/api/info/monthly-summary",
      "method": "GET",
      "title": "Get monthly financial summary (past 30 days)"
    }
  ]
}
```

### Use Cases

#### 1. API Discovery

Discover available info endpoints and their capabilities.

```bash
curl -X OPTIONS http://localhost:3002/api/info
```

#### 2. CORS Preflight

Support CORS preflight requests for browser-based applications.

```bash
curl -X OPTIONS http://localhost:3002/api/info \
  -H "Origin: http://example.com" \
  -H "Access-Control-Request-Method: GET"
```

#### 3. Dynamic Client Navigation

Build dynamic API clients that navigate using hypermedia links.

```javascript
// Fetch OPTIONS to discover endpoints
const response = await fetch('http://localhost:3002/api/info', {
    method: 'OPTIONS'
});
const {links} = await response.json();

// Navigate to monthly-summary endpoint
const monthlySummaryLink = links.find(link => link.rel === 'monthly-summary');
const summaryResponse = await fetch(monthlySummaryLink.href);
```

---

## GET /api/info

### Overview

Get overview statistics for the dashboard, including total transaction count, total amount, and category breakdown.

### Endpoint Details

- **HTTP Method:** `GET`
- **Path:** `/api/info`
- **Tags:** `info`
- **Authentication:** Not required (development)

### Response

#### Success Response (200 OK)

```json
{
  "total_transactions": 1523,
  "total_amount": 45678.90,
  "categories": [
    {
      "name": "GROCERIES:FOOD",
      "count": 234
    },
    {
      "name": "TRANSPORT:PUBLIC",
      "count": 156
    }
  ]
}
```

**Fields:**

| Field                | Type      | Description                            |
|----------------------|-----------|----------------------------------------|
| `total_transactions` | `integer` | Total number of transactions           |
| `total_amount`       | `float`   | Sum of all transaction amounts         |
| `categories`         | `array`   | Category breakdown with name and count |

### Use Cases

#### 1. Dashboard Overview

Display key statistics on the main dashboard.

```bash
curl -X GET http://localhost:3002/api/info
```

---

## GET /api/info/banks

### Overview

Retrieve a list of all unique bank accounts/sources in the database.

### Endpoint Details

- **HTTP Method:** `GET`
- **Path:** `/api/info/banks`
- **Tags:** `info`
- **Authentication:** Not required (development)

### Response

#### Success Response (200 OK)

```json
{
  "banks": [
    "Chase Checking",
    "Revolut",
    "Barclays Savings"
  ]
}
```

### Use Cases

#### 1. Filter Options

Populate bank filter dropdowns in the UI.

```bash
curl -X GET http://localhost:3002/api/info/banks
```

---

## GET /api/info/transaction-count

### Overview

Get the total count of all transactions in the database. Optimised for performance and designed for dashboard metrics.

### Endpoint Details

- **HTTP Method:** `GET`
- **Path:** `/api/info/transaction-count`
- **Tags:** `info`
- **Authentication:** Not required (development)

### Response

#### Success Response (200 OK)

```json
{
  "total_transactions": 1523
}
```

**Fields:**

| Field                | Type      | Description                                  | Constraints |
|----------------------|-----------|----------------------------------------------|-------------|
| `total_transactions` | `integer` | Total number of transactions in the database | >= 0        |

### Use Cases

#### 1. System Health Monitoring

Monitor transaction count over time.

```bash
curl -X GET http://localhost:3002/api/info/transaction-count
```

---

## GET /api/info/transaction-summary

### Overview

Get transaction summary with optional filters for bank account, start date, and end date.

### Endpoint Details

- **HTTP Method:** `GET`
- **Path:** `/api/info/transaction-summary`
- **Tags:** `info`
- **Authentication:** Not required (development)

### Query Parameters

| Parameter      | Type     | Required | Description                         | Format       |
|----------------|----------|----------|-------------------------------------|--------------|
| `bank_account` | `string` | No       | Filter by specific bank account     | Plain text   |
| `start_date`   | `string` | No       | Filter transactions from this date  | `YYYY-MM-DD` |
| `end_date`     | `string` | No       | Filter transactions until this date | `YYYY-MM-DD` |

### Response

#### Success Response (200 OK)

```json
{
  "total_count": 156,
  "total_amount": 3456.78,
  "average": 22.15,
  "min": -450.00,
  "max": 2500.00
}
```

### Error Responses

#### 400 Bad Request

Invalid date format provided.

```json
{
  "detail": "Invalid start_date format"
}
```

### Use Cases

#### 1. Date Range Analysis

Analyse transactions for a specific period.

```bash
curl -X GET "http://localhost:3002/api/info/transaction-summary?start_date=2026-01-01&end_date=2026-01-31"
```

#### 2. Bank-Specific Summary

Get summary for a specific bank account.

```bash
curl -X GET "http://localhost:3002/api/info/transaction-summary?bank_account=Chase%20Checking"
```

---

## GET /api/info/monthly-summary

### Overview

Get financial summary for the past 6 months (180 days), including total spending (negative amounts), total income (
positive
amounts), net amount, and transaction count. This endpoint provides a quick overview of financial health over a 6-month
period.

### Endpoint Details

- **HTTP Method:** `GET`
- **Path:** `/api/info/monthly-summary`
- **Tags:** `info`
- **Authentication:** Not required (development)
- **Added:** Version 1.1.0
- **Modified:** Version 1.2.0 - Changed from 30 days to 180 days (6 months)

### Response

#### Success Response (200 OK)

```json
{
  "months": [
    {
      "month": 9,
      "year": 2025,
      "period_start": "2025-09-01",
      "period_end": "2025-09-30",
      "total_spending": -2800.50,
      "total_income": 4500.00,
      "net_amount": 1699.50,
      "transaction_count": 78
    },
    {
      "month": 10,
      "year": 2025,
      "period_start": "2025-10-01",
      "period_end": "2025-10-31",
      "total_spending": -3200.25,
      "total_income": 4800.00,
      "net_amount": 1599.75,
      "transaction_count": 82
    },
    {
      "month": 11,
      "year": 2025,
      "period_start": "2025-11-01",
      "period_end": "2025-11-30",
      "total_spending": -3100.00,
      "total_income": 4500.00,
      "net_amount": 1400.00,
      "transaction_count": 75
    },
    {
      "month": 12,
      "year": 2025,
      "period_start": "2025-12-01",
      "period_end": "2025-12-31",
      "total_spending": -3800.00,
      "total_income": 5200.00,
      "net_amount": 1400.00,
      "transaction_count": 92
    },
    {
      "month": 1,
      "year": 2026,
      "period_start": "2026-01-01",
      "period_end": "2026-01-31",
      "total_spending": -2950.00,
      "total_income": 4600.00,
      "net_amount": 1650.00,
      "transaction_count": 81
    },
    {
      "month": 2,
      "year": 2026,
      "period_start": "2026-02-01",
      "period_end": "2026-02-07",
      "total_spending": -600.00,
      "total_income": 600.00,
      "net_amount": 0.00,
      "transaction_count": 79
    }
  ],
  "summary": {
    "total_spending": -18450.75,
    "total_income": 28200.00,
    "net_amount": 9749.25,
    "transaction_count": 487,
    "period_start": "2025-09-01",
    "period_end": "2026-02-07"
  },
  "links": [
    {
      "rel": "self",
      "href": "http://localhost:3002/api/info/monthly-summary",
      "method": "GET",
      "title": "Get monthly financial summary"
    },
    {
      "rel": "parent",
      "href": "http://localhost:3002/api/info",
      "method": "GET",
      "title": "View all info endpoints"
    },
    {
      "rel": "transactions",
      "href": "http://localhost:3002/api/transactions",
      "method": "GET",
      "title": "View all transactions"
    }
  ]
}
```

**Fields:**

| Field     | Type     | Description                                   | Constraints |
|-----------|----------|-----------------------------------------------|-------------|
| `months`  | `array`  | Array of 6 monthly financial data objects     | Required    |
| `summary` | `object` | Overall summary for the entire 6-month period | Required    |
| `links`   | `array`  | HATEOAS links for navigation                  | Required    |

**Month Object Fields:**

| Field               | Type      | Description                                        | Constraints |
|---------------------|-----------|----------------------------------------------------|-------------|
| `month`             | `integer` | Month number (1-12)                                | 1-12        |
| `year`              | `integer` | Year                                               | >= 2000     |
| `period_start`      | `date`    | Start date of the month (ISO 8601)                 | Required    |
| `period_end`        | `date`    | End date of the month (ISO 8601)                   | Required    |
| `total_spending`    | `float`   | Sum of all negative transaction amounts (spending) | <= 0        |
| `total_income`      | `float`   | Sum of all positive transaction amounts (income)   | >= 0        |
| `net_amount`        | `float`   | Net amount (income + spending) for the month       | Any         |
| `transaction_count` | `integer` | Total number of transactions in the month          | >= 0        |

**Summary Object Fields:**

| Field               | Type      | Description                                      | Constraints |
|---------------------|-----------|--------------------------------------------------|-------------|
| `total_spending`    | `float`   | Total spending across all 6 months               | <= 0        |
| `total_income`      | `float`   | Total income across all 6 months                 | >= 0        |
| `net_amount`        | `float`   | Net amount across all 6 months                   | Any         |
| `transaction_count` | `integer` | Total number of transactions across all 6 months | >= 0        |
| `period_start`      | `date`    | Start date of the 6-month period (ISO 8601)      | Required    |
| `period_end`        | `date`    | End date of the 6-month period (ISO 8601)        | Required    |

### Calculation Logic

The endpoint calculates data for each of the last 6 calendar months:

- **Months Covered:** The last 6 complete or partial calendar months
- **Current Month:** Includes data up to today's date
- **Past Months:** Includes complete calendar months

Transactions are categorised as:

- **Spending:** Transactions with `amount < 0`
- **Income:** Transactions with `amount > 0` (includes `amount = 0` as neutral)

### Use Cases

#### 1. 6-Month Financial Trend Analysis

Display month-by-month spending vs income to visualize trends.

```bash
curl -X GET http://localhost:3002/api/info/monthly-summary
```

**Response:**

```json
{
  "months": [
    {
      "month": 9,
      "year": 2025,
      "period_start": "2025-09-01",
      "period_end": "2025-09-30",
      "total_spending": -2800.50,
      "total_income": 4500.00,
      "net_amount": 1699.50,
      "transaction_count": 78
    },
    ...
  ],
  "summary": {
    "total_spending": -18450.75,
    "total_income": 28200.00,
    "net_amount": 9749.25,
    "transaction_count": 487,
    "period_start": "2025-09-01",
    "period_end": "2026-02-07"
  }
}
```

**UI Display:**

```
6-Month Financial Trend
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sep 2025:  Income: £4,500.00 | Spending: £2,800.50 | Net: £1,699.50
Oct 2025:  Income: £4,800.00 | Spending: £3,200.25 | Net: £1,599.75
Nov 2025:  Income: £4,500.00 | Spending: £3,100.00 | Net: £1,400.00
Dec 2025:  Income: £5,200.00 | Spending: £3,800.00 | Net: £1,400.00
Jan 2026:  Income: £4,600.00 | Spending: £2,950.00 | Net: £1,650.00
Feb 2026:  Income: £600.00   | Spending: £600.00   | Net: £0.00

Overall (6 months):
Income:      £28,200.00  ↗
Spending:    £18,450.75  ↘
Net:         £9,749.25   ✓
Transactions: 487
```

#### 2. Financial Health Indicator with Trend Detection

Determine if spending is increasing or decreasing month over month.

```javascript
const response = await fetch('http://localhost:3002/api/info/monthly-summary');
const data = await response.json();

// Check overall 6-month health
if (data.summary.net_amount < 0) {
    console.log('Warning: You spent more than you earned over the past 6 months!');
} else {
    console.log(`You saved £${data.summary.net_amount.toFixed(2)} over 6 months.`);
}

// Analyze trend - compare last month to previous month
const currentMonth = data.months[data.months.length - 1];
const previousMonth = data.months[data.months.length - 2];

if (currentMonth.total_spending < previousMonth.total_spending) {
    console.log('Good news: Your spending decreased this month!');
}
```

#### 3. Chart/Visualization Data

Generate data for trend charts and graphs.

```javascript
const response = await fetch('http://localhost:3002/api/info/monthly-summary');
const data = await response.json();

// Extract data for chart
const chartData = data.months.map(month => ({
    label: `${month.year}-${String(month.month).padStart(2, '0')}`,
    income: month.total_income,
    spending: Math.abs(month.total_spending),
    net: month.net_amount
}));

// Use with Chart.js, D3.js, or any visualization library
console.log(chartData);
```

#### 4. Budget Tracking

Compare actual spending against monthly budget for each month.

```bash
curl -X GET http://localhost:3002/api/info/monthly-summary | jq '.months[] | {
  month: .month,
  year: .year,
  budget: 3000,
  actual_spending: (.total_spending * -1),
  remaining: (3000 + .total_spending),
  percentage_used: (((.total_spending * -1) / 3000) * 100)
}'
```

#### 5. Navigation via HATEOAS

Use hypermedia links to navigate to related resources.

```javascript
const response = await fetch('http://localhost:3002/api/info/monthly-summary');
const data = await response.json();

// Navigate to transactions to see details
const transactionsLink = data.links.find(link => link.rel === 'transactions');
const transactions = await fetch(transactionsLink.href);
```

#### 6. Trend Analysis API Client

Build a chart showing monthly trends over time.

```python
import requests
from datetime import datetime


def get_monthly_trend():
    """Get 6-month trend data for visualization"""
    response = requests.get('http://localhost:3002/api/info/monthly-summary')
    data = response.json()

    # Extract monthly data for plotting
    months = data['months']

    for month in months:
        month_name = datetime(month['year'], month['month'], 1).strftime('%B %Y')
        print(f"{month_name}")
        print(f"  Income:   £{month['total_income']:.2f}")
        print(f"  Spending: £{abs(month['total_spending']):.2f}")
        print(f"  Net:      £{month['net_amount']:.2f}")
        print()

    return months


# Use the data for visualization
trend_data = get_monthly_trend()
```

### Error Responses

#### 500 Internal Server Error

Database error or unexpected failure.

```json
{
  "detail": "Error retrieving monthly financial summary"
}
```

### Performance Considerations

- The endpoint queries transactions within a 30-day window
- Performance is optimised with date range filters
- Typical response time: < 100ms for databases with < 100,000 transactions
- Consider caching for high-traffic applications

### Best Practices

1. **Caching:** Cache the response for 1-5 minutes to reduce database load
2. **Polling:** Don't poll this endpoint too frequently; once per page load is sufficient
3. **Error Handling:** Always handle 500 errors gracefully
4. **Date Display:** Format dates according to user locale
5. **Currency:** Format amounts with appropriate currency symbols and precision

### Related Endpoints

- **GET /api/info/transaction-summary** - More detailed summary with custom date ranges
- **GET /api/transactions** - View individual transactions
- **GET /api/info** - Overall statistics including all-time totals

### OpenAPI Schema Reference

The endpoint uses the `MonthlyFinancialSummaryResponse` schema:

```yaml
MonthlyFinancialSummaryResponse:
  type: object
  required:
    - months
    - summary
    - links
  properties:
    months:
      type: array
      description: Array of 6 monthly financial data objects
      items:
        $ref: '#/components/schemas/MonthData'
    summary:
      $ref: '#/components/schemas/SixMonthSummary'
    links:
      type: array
      items:
        $ref: '#/components/schemas/Link'
      description: Available actions (HATEOAS links)

MonthData:
  type: object
  required:
    - month
    - year
    - period_start
    - period_end
    - total_spending
    - total_income
    - net_amount
    - transaction_count
  properties:
    month:
      type: integer
      minimum: 1
      maximum: 12
      description: Month number (1-12)
    year:
      type: integer
      minimum: 2000
      description: Year
    period_start:
      type: string
      format: date
      description: Start date of the month (ISO 8601)
    period_end:
      type: string
      format: date
      description: End date of the month (ISO 8601)
    total_spending:
      type: number
      format: float
      maximum: 0.0
      description: Total spending (negative amounts) for the month
    total_income:
      type: number
      format: float
      minimum: 0.0
      description: Total income (positive amounts) for the month
    net_amount:
      type: number
      format: float
      description: Net amount (income + spending) for the month
    transaction_count:
      type: integer
      minimum: 0
      description: Total number of transactions in the month

SixMonthSummary:
  type: object
  required:
    - total_spending
    - total_income
    - net_amount
    - transaction_count
    - period_start
    - period_end
  properties:
    total_spending:
      type: number
      format: float
      maximum: 0.0
      description: Total spending across all 6 months
    total_income:
      type: number
      format: float
      minimum: 0.0
      description: Total income across all 6 months
    net_amount:
      type: number
      format: float
      description: Net amount across all 6 months
    transaction_count:
      type: integer
      minimum: 0
      description: Total number of transactions in the period
    links:
      type: array
      items:
        $ref: '#/components/schemas/Link'
      description: Available actions (HATEOAS links)
```

---

## Common Error Responses

All info endpoints may return the following error responses:

### 500 Internal Server Error

Database error or unexpected system failure.

```json
{
  "detail": "Error retrieving [resource]"
}
```

**Troubleshooting:**

- Check database connectivity
- Verify database schema is initialised
- Check application logs for detailed error messages

---

## Testing

### Unit Tests

All info endpoints have comprehensive unit test coverage located in `tests/test_info.py`:

- `TestInfoOptionsEndpoint` - OPTIONS endpoint tests
- `TestStatisticsEndpoint` - Statistics endpoint tests
- `TestBanksEndpoint` - Banks endpoint tests
- `TestTransactionCountEndpoint` - Transaction count tests
- `TestTransactionSummaryEndpoint` - Transaction summary tests
- `TestMonthlyFinancialSummaryEndpoint` - Monthly summary tests

Run tests with:

```bash
pytest tests/test_info.py -v
```

### Integration Tests

Test the complete flow from OPTIONS discovery to data retrieval:

```bash
# Discover endpoints
curl -X OPTIONS http://localhost:3002/api/info

# Get monthly summary
curl -X GET http://localhost:3002/api/info/monthly-summary

# Get detailed transaction summary
curl -X GET "http://localhost:3002/api/info/transaction-summary?start_date=2026-01-01&end_date=2026-01-31"
```

---

## Security Considerations

### Current Implementation (Development)

- No authentication required
- All endpoints are publicly accessible
- Suitable for development/testing only

### Production Recommendations

1. **Authentication:** Implement JWT or OAuth 2.0 authentication
2. **Authorisation:** Restrict access to user's own data
3. **Rate Limiting:** Implement rate limiting to prevent abuse
4. **Input Validation:** All date inputs are validated
5. **SQL Injection:** Protected via SQLAlchemy ORM and parameterised queries

---

## HATEOAS Compliance

All info endpoints follow REST Level 3 (HATEOAS) principles:

1. **Discoverability:** OPTIONS endpoint reveals available methods and links
2. **Self-Description:** Responses include links to related resources
3. **Navigation:** Clients can navigate the API using hypermedia controls
4. **Dynamic Actions:** Available actions are determined by server state

### Link Relations

Standard link relations used:

- `self` - Current resource
- `parent` - Parent resource in hierarchy
- `banks` - Bank accounts list
- `transaction-count` - Transaction count endpoint
- `transaction-summary` - Transaction summary endpoint
- `monthly-summary` - Monthly financial summary endpoint
- `transactions` - Transactions collection

---

## Changelog

### Version 1.1.0 (2026-02-07)

- **Added:** `OPTIONS /api/info` endpoint for API discovery
- **Added:** `GET /api/info/monthly-summary` endpoint for past 30 days financial summary
- **Enhanced:** Full HATEOAS compliance with hypermedia links
- **Enhanced:** Comprehensive documentation and test coverage

### Version 1.0.0 (2026-01-29)

- Initial release with basic info endpoints
- Statistics, banks, transaction count, and transaction summary endpoints

---

## Support

For issues, questions, or feature requests:

1. Check the API documentation: `/docs` (Swagger UI)
2. Review test cases: `tests/test_info.py`
3. Check application logs for detailed error messages

---

## Related Documentation

- [REST Level 3 Implementation Guide](REST_LEVEL3_IMPLEMENTATION_SUMMARY.md)
- [HATEOAS Quick Reference](LEVEL3_QUICK_REFERENCE.md)
- [OpenAPI Documentation](OPENAPI_DOCUMENTATION.md)
- [Transaction Count Endpoint](INFO_TRANSACTION_COUNT_ENDPOINT.md)

