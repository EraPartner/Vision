---
title: Integrations Documentation Index
type: integrations-index
status: active
date: 2026-03-31
tags: [integrations, index, external-services]
description: Documentation for external service integrations including bank adapters, price providers, and currency conversion
aliases: [integrations, external services, third-party]
---

# Integrations Documentation

> [!abstract] Overview
> External services and integrations in Vision. This covers all third-party APIs, bank adapters, and data providers.

## External Services

```dataview
TABLE WITHOUT FILE title AS "Integration", description AS "Description", date AS "Updated"
FROM "docs/integrations"
WHERE type = "integration"
SORT title ASC
```

## Categories

### Banking
- [[docs/integrations/bank-adapters\|Bank Adapters]] - Bank API integrations (Belfius, Revolut, KBC, SABB, Wise, Vision)

### Market Data
- [[docs/integrations/price-providers\|Price Providers]] - Stock/crypto/metals price feeds (Binance, Yahoo Finance, Kinesis, Custom JSON)

### Currency
- [[docs/integrations/currency-conversion\|Currency Conversion]] - Exchange rate services (ECB, open.er-api)

### Government Data
> [!info] Belgian Inflation
> Belgian inflation data is sourced from **Statbel** (primary) and **Eurostat HICP** (fallback). Documented in [[docs/features/portfolio\|Portfolio]] and [[docs/api/info\|Info API]].

## Related Documentation

- [[docs/features/import\|Import Feature]] - How bank adapters are used
- [[docs/features/portfolio\|Portfolio Feature]] - How price providers are used
- [[docs/performance/caching-strategies\|Caching Strategies]] - How external data is cached
