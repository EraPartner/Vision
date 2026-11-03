---
title: Integration - Belgian Inflation Service
type: integration
status: active
date: 2026-11-03
tags: [integration, belgian-inflation, statbel, eurostat, government-data]
description: Belgian inflation data sourcing from Statbel and Eurostat HICP
aliases: [belgian inflation, statbel, eurostat, hicp, inflation service]
related_code: ["apps/node-backend/src/services/belgianInflationService.ts", "apps/node-backend/src/routes/info.ts"]
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
│  In-Memory   │────▶│    SQLite    │────▶│   Statbel    │
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
2. **Persisted SQLite rows** (`belgian_inflation_rates`)
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

The SQLite baseline (`db/migrations/0001_baseline.sql`) defines the table as follows. A unique
index, `belgian_inflation_rates_month_date_key`, keeps one row per month.

```sql
CREATE TABLE belgian_inflation_rates (
  id INTEGER CONSTRAINT belgian_inflation_rates_pkey PRIMARY KEY AUTOINCREMENT,
  month_date DATE_TEXT NOT NULL
    CONSTRAINT belgian_inflation_rates_month_date__vtype CHECK (vision_date_ok(month_date)),
  monthly_rate DECIMAL_TEXT(10,8) NOT NULL
    CONSTRAINT belgian_inflation_rates_monthly_rate__vtype CHECK (vision_numeric_ok(monthly_rate, 10, 8)),
  source TEXT NOT NULL DEFAULT 'statbel'
    CONSTRAINT belgian_inflation_rates_source__vtype CHECK (length(source) <= 50),
  fetched_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT belgian_inflation_rates_fetched_at__vtype CHECK (vision_ts_ok(fetched_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT belgian_inflation_rates_updated_at__vtype CHECK (vision_ts_ok(updated_at))
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
