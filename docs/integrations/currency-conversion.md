---
title: Currency Conversion
type: integration
status: active
date: 2026-04-17
tags: [integration, currency, exchange-rates, phase-0]
description: Multi-currency support with automatic conversion to target currencies using ECB and supplementary exchange rates, including date-aware historical conversion. Phase 0 consolidation under way.
related_code: ["apps/node-backend/src/services/calculations/currency.js", "apps/node-backend/src/services/currencyConversionService.js"]
---

# Currency Conversion

Vision provides multi-currency support with conversion to EUR or another requested target currency using official exchange rates.

## Overview

The currency conversion service handles all currency-related operations, including:
- Fetching live exchange rates
- Converting transaction amounts to a requested target currency
- Handling currencies not covered by ECB
- Preserving historical exchange-rate rows while updating the latest per currency
- Date-aware historical lookup for portfolio conversion (exact date, otherwise nearest stored date)

## Data Sources

### Primary: ECB (European Central Bank)

- **URL**: `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`
- **Update frequency**: Daily (~16:00 CET)
- **Currencies**: ~30 major currencies

### Supplementary: Open Exchange Rates API

- **URL**: `https://open.er-api.com/v6/latest/EUR`
- **Coverage**: ~150 currencies
- **Use case**: Currencies not covered by ECB (AED, SAR, KWD, etc.)

**Priority**: ECB rates always take precedence over supplementary source

---

## Fallback Strategy

The service implements a multi-layer fallback:

1. **In-memory cache** - 24-hour TTL
2. **Database rates** - Stored in `exchange_rates` table
3. **Hardcoded constants** - Last resort fallback

For date-aware conversion requests, the service also opportunistically queries ECB's 90-day historical feed for exact-date matches before falling back to nearest stored database rates.

```
┌─────────────────────────────────────┐
│         Request                      │
└─────────────────┬───────────────────┘
                  │
          ┌───────▼────────┐
          │ Memory Cache   │
          │ (24h TTL)      │
          └───────┬─────────┘
                  │ miss
          ┌───────▼────────┐
          │  Database      │
          └───────┬─────────┘
                  │ miss
          ┌───────▼────────┐
          │ Hardcoded      │
          │ Fallback       │
          └────────────────┘
```

---

## Supported Currencies

### ECB Currencies (Primary)

| Code | Currency |
|------|----------|
| EUR | Euro |
| USD | US Dollar |
| GBP | British Pound |
| CHF | Swiss Franc |
| JPY | Japanese Yen |
| SEK | Swedish Krona |
| NOK | Norwegian Krone |
| DKK | Danish Krone |
| PLN | Polish Zloty |
| CZK | Czech Koruna |
| HUF | Hungarian Forint |
| RON | Romanian Leu |
| TRY | Turkish Lira |
| AUD | Australian Dollar |
| CAD | Canadian Dollar |
| CNY | Chinese Yuan |
| INR | Indian Rupee |
| BRL | Brazilian Real |

### Supplementary Currencies

| Code | Currency |
|------|----------|
| AED | UAE Dirham |
| SAR | Saudi Riyal |
| KWD | Kuwaiti Dinar |
| QAR | Qatari Riyal |
| BHD | Bahraini Dinar |
| OMR | Omani Rial |
| PKR | Pakistani Rupee |
| EGP | Egyptian Pound |
| NGN | Nigerian Naira |
| MAD | Moroccan Dirham |
| KES | Kenyan Shilling |

---

## API Usage

### Get Exchange Rates

```
GET /api/info/exchange-rates
```

Response:
```json
{
  "source": "ecb",
  "timestamp": "2025-03-18T12:00:00Z",
  "rates": {
    "EUR": 1.0,
    "USD": 0.917,
    "GBP": 1.176
  }
}
```

### Force Refresh

```
POST /api/info/exchange-rates/refresh
```

---

## Performance

- **Cache hit**: < 5ms
- **Cache miss + DB**: ~50ms
- **API fetch**: ~500ms

---

## Implementation Details

### Canonical Import Path (Phase 0+)

**New code should import from here:**

```javascript
import {
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
} from './services/calculations/currency.js';
```

This is a re-export façade from the live implementation at `services/currencyConversionService.js`. The service is not deprecated; it's the **active implementation** for all currency conversion operations.

**Direct import (also supported):**
```javascript
import { convertToEur } from './services/currencyConversionService.js';
```

### Cache Management

```javascript
// Cache TTL: 24 hours
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
```

**Implementation Note:** In-memory cache (24h TTL) is the current caching strategy. Postgres-backed `exchange_rate_cache` table was planned for Phase 0 consolidation but is not yet implemented; in-memory rates remain standard.

### Batch Conversion

Convert multiple rows at once:

```javascript
import { convertRowsToEur } from './services/calculations/currency.js';

const converted = await convertRowsToEur(transactions, 'USD');
```

Date-aware conversion can be enabled for row sets that contain a date column:

```javascript
const converted = await convertRowsToEur(rows, 'USD', {
  useHistoricalRatesByDate: true,
  dateField: 'day'
});
```

### Sparse Historical Backfill (Portfolio)

- `backfillPortfolioHistoricalRates()` backfills only missing `(portfolio_transactions.currency, portfolio_transactions.date)` pairs (excluding EUR)
- Existing historical rows are preserved
- Backfill favors exact-date ECB data when available, then falls back to nearest local rate

Generic amount conversion:

```javascript
import { convertToCurrency } from './services/calculations/currency.js';

const amountInSar = await convertToCurrency(125, 'USD', 'SAR');
```

---

## Configuration

No configuration required - service auto-initializes on startup.

Startup triggers a background sparse historical backfill for portfolio transaction dates.

**Optional environment variables:**
- None currently required

---

## Error Handling

- **API failures**: Falls back to database, then hardcoded rates
- **Invalid source currencies**: Returns 1:1 passthrough amount
- **Invalid target currencies**: Falls back to EUR conversion behavior
- **Stale data**: Uses hardcoded fallback if all sources fail

---

## Use Cases

1. **Multi-currency transactions** - Track spending in original currency
2. **Target-currency reporting** - Normalize all amounts to the selected currency for analysis
3. **Investment tracking** - Convert foreign investments to home currency
4. **Tax reporting** - Required for EUR-based tax calculations

---

> [!info] Locked contracts (Phase 8)
> Currency round-trip correctness is pinned by [[apps/node-backend/tests/property/currencyRoundTrip.property.test.js]]. Bounded random amount + rate pairs must satisfy `convert(convert(x, A→B), B→A) ≈ x` within cent tolerance, and cross-rate composition `A→B→C` must equal the direct `A→C` conversion within the same tolerance. See [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] and [[apps/node-backend/tests/golden/INVENTORY|Calculation Inventory]].

## See Also

- [[docs/reference/data-model#ExchangeRateCache]] - Database schema
- [[docs/performance/caching-strategies]] - Caching implementation
- [[docs/api/settings]] - Settings API
- [[docs/integrations/index]] - Integrations Index
- [[docs/reference/code-patterns#Filter Builder Pattern]] - Related Phase 0 patterns

Code links: [[apps/node-backend/src/services/calculations/currency.js|Canonical import (Phase 0+)]], [[apps/node-backend/src/services/currencyConversionService.js|Legacy implementation]], [[apps/node-backend/src/main.js]]
