---
title: Integration - Belgian Inflation Service
type: integration
status: active
date: 2026-04-02
tags: [integration, belgian-inflation, statbel, eurostat, government-data]
description: Belgian inflation data sourcing from Statbel and Eurostat HICP
aliases: [belgian inflation, statbel, eurostat, hicp, inflation service]
related_code: ["apps/node-backend/src/services/belgianInflationService.js", "apps/node-backend/src/routes/info.js"]
---

# Integration: Belgian Inflation Service

## Overview

The Belgian Inflation Service sources monthly inflation data from Belgian and European statistical offices to enable inflation-adjusted portfolio return calculations.

---

## Data Sources

### Primary: Statbel

- **URL**: Belgian statistics office API
- **Data**: Monthly Belgian inflation rates
- **Frequency**: Monthly updates
- **Format**: JSON/CSV

### Fallback: Eurostat HICP

- **URL**: Eurostat API
- **Data**: Harmonised Index of Consumer Prices
- **Scope**: EU-wide, filtered for Belgium
- **Used when**: Statbel is unavailable

---

## Architecture

### Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  In-Memory   │────▶│  PostgreSQL  │────▶│   Statbel    │
│   Cache      │     │   (persisted)│     │   (remote)   │
│   (24h TTL)  │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
       │                     │                     │
       │                     │                     ▼
       │                     │              ┌──────────────┐
       │                     │              │  Eurostat    │
       │                     │              │  HICP (FB)   │
       │                     │              └──────────────┘
       ▼                     ▼
┌──────────────────────────────────────────┐
│        /api/info/inflation-rates         │
└──────────────────────────────────────────┘
```

### Fallback Chain

1. **In-memory cache** (24h TTL)
2. **PostgreSQL persisted rows** (`belgian_inflation_rates`)
3. **Remote Statbel fetch**
4. **Remote Eurostat HICP fallback**
5. **Persisted DB data** (if both remote sources fail)

---

## Startup Behavior

- Backend warms inflation cache at startup
- Refresh occurs together with exchange-rate refresh cadence (every 12 hours)
- Non-blocking — API starts accepting requests while inflation data loads

---

## API Integration

| Endpoint | Description |
|----------|-------------|
| `GET /api/info/inflation-rates` | Get monthly inflation rates |
| `GET /api/info/inflation-rates?db_only=true` | Get from DB only (no remote fetch) |
| `POST /api/info/inflation-rates/refresh` | Trigger refresh from remote sources |

---

## Data Model

```sql
CREATE TABLE belgian_inflation_rates (
  id SERIAL PRIMARY KEY,
  month_date DATE NOT NULL UNIQUE,
  monthly_rate NUMERIC(10,8) NOT NULL,
  source VARCHAR(50) DEFAULT 'statbel',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
```

---

## Usage

### Portfolio Performance

Inflation rates are used to compute:
- **Real returns**: Nominal return adjusted for inflation
- **Inflation-adjusted values**: Portfolio value in constant euros
- **Cumulative inflation**: Running total from investment start date

### Calculation

```
real_return = (1 + nominal_return) / (1 + cumulative_inflation) - 1
```

Monthly compounding:
```
cumulative_inflation = Π(1 + monthly_rate_i) - 1
```

---

## Related

- [[docs/features/belgian-tax]] — Belgian tax feature
- [[docs/features/portfolio#belgian-inflation-data-flow]] — Inflation in portfolio
- [[docs/adr/002-database-schema#belgian-inflation-rates]] — Database schema
