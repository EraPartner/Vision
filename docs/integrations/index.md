---
title: Integrations Documentation Index
type: integrations-index
status: active
date: 2026-03-31
updated: 2026-05-12
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
- [[docs/integrations/bank-adapters\|Bank Adapters]] - Bank API integrations (Belfius, Revolut, ING, KBC, BNP Paribas Fortis, SABB, Wise, Vision)

### Market Data
- [[docs/integrations/price-providers\|Price Providers]] - Stock/crypto/metals price feeds (Binance, Yahoo Finance, Kinesis, Custom JSON)

### Currency
- [[docs/integrations/currency-conversion\|Currency Conversion]] - Exchange rate services (ECB, open.er-api)

### Government Data
- [[docs/integrations/belgian-inflation\|Belgian Inflation]] - Statbel/Eurostat HICP inflation data sourcing

### Financial Services
- [[docs/integrations/kinesis-price-provider\|Kinesis Price Provider]] - Metals and commodity price feeds
- [[docs/integrations/loan-repayment-service\|Loan Repayment Service]] - Amortization calculations for planned loans

### AI & LLM
- [[docs/integrations/ollama\|Ollama Integration]] - Local LLM for natural-language queries with tool-calling

## Related Documentation

- [[docs/features/import\|Import Feature]] - How bank adapters are used
- [[docs/features/portfolio\|Portfolio Feature]] - How price providers are used
- [[docs/performance/caching-strategies\|Caching Strategies]] - How external data is cached
