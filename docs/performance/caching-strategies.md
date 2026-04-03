---
title: Caching Strategies
type: performance
status: active
date: 2026-04-02
tags: [performance, caching, optimization]
description: In-memory caching implementation for exchange rates and price feeds
aliases: [caching, cache layers, in-memory cache, ttl, cache invalidation]
related_code: ["apps/node-backend/src/services/currencyConversionService.js", "apps/node-backend/src/services/priceProviderService.js"]
---

# Caching Strategies

Vision implements multi-layer caching to minimize external API calls and improve response times.

## Cache Layers

### 1. Exchange Rate Cache

**Service:** `currencyConversionService.js`  
**TTL:** 24 hours  
**Storage:** In-memory

```javascript
// Cache structure
{
  rates: {
    USD: 1.08,
    GBP: 0.86,
    // ...
  },
  timestamp: 1709300000000
}
```

**Features:**
- Falls back to database rates if API fails
- Falls back to hardcoded rates if all sources unavailable
- Pre-warmed on application startup

---

### 2. Price Provider Cache

**Service:** `priceProviderService.js`  
**TTL:** 5 minutes  
**Storage:** In-memory (Map) + PostgreSQL historical cache (`asset_price_history`)

```javascript
// Cache key format
"binance:BTCUSDT"      // Binance
"yahoo:AAPL"           // Yahoo Finance
"kinesis:42"           // Kinesis (investment-scoped)
"custom:123"           // Custom provider
```

**Features:**
- Per-symbol caching
- Automatic expiration
- Stale-while-revalidate pattern
- Provider-consistent keying for investment-scoped providers (`custom`, `kinesis`) across lookup/set paths
- Kinesis trendline sanitization runs before latest/history cache writes to prevent isolated one-point needles from polluting short-lived memory cache or persisted history ([[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/tests/priceProviderService.test.js]])
- DB-backed historical quote persistence for `yahoo`/`custom` provider history
- Read-through history fetch (`DB -> provider -> DB upsert`)
- Startup background backfill for held market-priced assets
- Startup immediate/deferred split: Kinesis investments with valid persisted `current_price` are served from stored DB value first, while external Kinesis refresh runs in background after boot

---

### 3. Materialized View Cache

**Repository:** `infoRepository.js`  
**Storage:** In-memory (Map)

Caches materialized view availability checks to avoid repeated database queries.

```javascript
const mvCache = new Map();
// Cleared after refresh operations
```

---

### 4. Net Worth Route Cache

**Route:** `GET /api/info/net-worth`  
**TTL:** 5 minutes  
**Storage:** In-memory (Map), keyed by target currency

**Features:**
- Per-currency response caching for repeated dashboard refreshes
- In-flight request deduplication (same-currency concurrent requests share one repository promise)
- **Pre-warmed on backend startup** via `warmInfoCaches()` so the first request is instant
- Route-level throttling (`30 req / 60s`) to protect expensive compute path

Code links: [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/repositories/infoRepository.js]]

---

### 6. Portfolio Performance Snapshots

**Service:** `portfolioPerformanceSnapshotService.js`  
**Storage:** PostgreSQL (`portfolio_performance_snapshots` table)

**Features:**
- Daily snapshots computed and stored for portfolio performance charts
- Per-currency storage (EUR, USD, etc.) for multi-currency support
- `ON CONFLICT` upsert pattern for idempotent recomputation
- Batch insert (500 rows/batch) for efficient bulk writes
- Includes per-class breakdowns: stocks/ETFs, crypto, metals (both value and invested capital)
- Inflation-adjusted values using Belgian monthly inflation rates
- Spike sanitization: isolated one-day anomalies replaced with geometric interpolation
- Frontend reads from persisted DB table instead of computing on-demand

Code links: [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]], [[alembic/versions/0023_portfolio_performance_snapshots.py]], [[alembic/versions/0024_per_class_invested_columns.py]]

---

### 7. HTTP Cache Headers

Static assets use long-lived caching:

```javascript
// Hashed assets (JS/CSS)
res.setHeader('Cache-Control', 'public, max-age=31536000');

// SPA fallback (index.html)
res.setHeader('Cache-Control', 'no-cache');
```

---

## Cache Invalidation

### Manual Invalidation

```javascript
// Clear exchange rate cache
import { clearMemoryCache } from './services/currencyConversionService.js';
clearMemoryCache();

// Clear materialized view cache
import { clearMvCache } from './repositories/infoRepository.js';
clearMvCache();
```

### Automatic Invalidation

- Exchange rates: 24-hour TTL
- Price feeds: 5-minute TTL
- Materialized views: After data changes
- Net worth route cache: 60-second per-currency TTL
- Portfolio performance snapshots: Recomputed on-demand, stored in DB

---

## Best Practices

1. **Use appropriate TTLs** - Balance freshness vs. performance
2. **Implement fallbacks** - Always have a backup when cache misses
3. **Pre-warm on startup** - Fetch critical data before first request
4. **Monitor cache hit rates** - Track effectiveness

---

## Performance Comparison

| Operation | Without Cache | With Cache |
|-----------|--------------|------------|
| Exchange rate conversion | ~500ms | ~5ms |
| Stock price lookup | ~800ms | ~10ms |
| Crypto price lookup | ~400ms | ~8ms |

---

## Production Considerations

For production deployments:

1. **Redis caching** - Replace in-memory with distributed Redis cache
2. **Cache warming** - Schedule periodic pre-warming
3. **Monitoring** - Track hit/miss ratios
4. **Eviction policies** - LRU for memory-bounded caches

---

## See Also

- [[docs/performance/index]] - Performance Documentation Index
- [[docs/performance/materialized-views]] - Materialized Views
- [[docs/integrations/price-providers]] - Price Providers
