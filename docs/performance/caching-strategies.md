---
title: Caching Strategies
type: performance
status: active
date: 2025-03-18
tags: [performance, caching, optimization]
description: In-memory caching implementation for exchange rates and price feeds
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
**Storage:** In-memory (Map)

```javascript
// Cache key format
"coingecko:bitcoin"    // CoinGecko
"yahoo:AAPL"           // Yahoo Finance
"kraken:BTC"           // Kraken
"custom:123"           // Custom provider
```

**Features:**
- Per-symbol caching
- Automatic expiration
- Stale-while-revalidate pattern

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

### 4. HTTP Cache Headers

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
