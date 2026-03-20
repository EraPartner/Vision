---
title: Currency Conversion
type: integration
status: active
date: 2025-03-18
tags: [integration, currency, exchange-rates]
description: Multi-currency support with automatic conversion to EUR using ECB and supplementary exchange rates
related_code: ["apps/node-backend/src/services/currencyConversionService.js"]
---

# Currency Conversion

Vision provides multi-currency support with automatic conversion to EUR using official exchange rates.

## Overview

The currency conversion service handles all currency-related operations, including:
- Fetching live exchange rates
- Converting transaction amounts to EUR
- Handling currencies not covered by ECB

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

### Cache Management

```javascript
// Cache TTL: 24 hours
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
```

### Batch Conversion

Convert multiple rows at once:

```javascript
import { convertRowsToEur } from './services/currencyConversionService.js';

const converted = await convertRowsToEur(transactions, 'currency', 'amount');
```

---

## Configuration

No configuration required - service auto-initializes on startup.

**Optional environment variables:**
- None currently required

---

## Error Handling

- **API failures**: Falls back to database, then hardcoded rates
- **Invalid currencies**: Returns 1:1 EUR conversion
- **Stale data**: Uses hardcoded fallback if all sources fail

---

## Use Cases

1. **Multi-currency transactions** - Track spending in original currency
2. **EUR reporting** - Normalize all amounts to EUR for analysis
3. **Investment tracking** - Convert foreign investments to home currency
4. **Tax reporting** - Required for EUR-based tax calculations

---

## See Also

- [[docs/performance/caching-strategies]] - Caching implementation
- [[docs/api/settings]] - Settings API
- [[docs/integrations/index]] - Integrations Index
