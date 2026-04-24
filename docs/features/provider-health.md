---
title: Provider Health Tracking
type: feature
status: active
date: 2026-04-24
tags: [feature, admin, provider-health, observability]
description: Passive health tracking and active probing for all price, FX, and inflation data providers
aliases: [provider health, data source health, provider monitoring]
related_code:
  - apps/node-backend/src/services/providerHealth/providerHealthService.js
  - apps/node-backend/src/services/providerHealth/providerHealthRepo.js
  - apps/node-backend/src/routes/admin.js
  - apps/frontend/src/pages/admin/ProviderHealthPage.tsx
  - apps/frontend/src/lib/api/admin.ts
---

# Provider Health Tracking

> [!abstract] Overview
> Passive health tracking for all 7 data providers. Every fetch records success/failure into the `provider_health` table. An active "Check now" probe is available per-provider via the Admin UI.

## Providers Tracked

| Key | Label | Kind |
|-----|-------|------|
| `binance` | Binance | price |
| `yahoo` | Yahoo Finance | price |
| `kinesis` | Kinesis Gold | price |
| `ecb` | ECB | fx |
| `open.er-api` | Open Exchange Rates | fx |
| `statbel` | Statbel | inflation |
| `eurostat` | Eurostat | inflation |

## Data Model

Table: `provider_health`

| Column | Type | Description |
|--------|------|-------------|
| `provider` | text PK | Provider key (e.g. `binance`) |
| `kind` | text | `price` \| `fx` \| `inflation` |
| `label` | text | Human-readable display name |
| `last_success_at` | timestamptz | Most recent successful fetch |
| `last_error_at` | timestamptz | Most recent error timestamp |
| `last_error` | text | Error message from last failure |
| `consecutive_failures` | int | Reset to 0 on any success |
| `updated_at` | timestamptz | Row last-modified timestamp |

Created via migration `0010_add_provider_health.py`.

## Passive Tracking

`recordSuccess(provider)` and `recordError(provider, err)` are called from existing service files:

- `priceProviderService.js` — Binance, Yahoo, Kinesis
- `currencyConversionService.js` — ECB, open.er-api
- `belgianInflationService.js` — Statbel, Eurostat

On success: resets `consecutive_failures` to 0, updates `last_success_at`.  
On error: increments `consecutive_failures`, records `last_error` and `last_error_at`.

## Active Probing

`POST /api/admin/providers/:provider/probe` triggers a lightweight read-only fetch for the given provider:

| Provider | Probe action |
|----------|-------------|
| Binance | Fetch BTCUSDT ticker |
| Yahoo | Fetch AAPL quote |
| Kinesis | Fetch latest gold price |
| ECB | Fetch EUR/USD rate |
| open.er-api | Fetch EUR/USD rate |
| Statbel | Fetch latest CPI index |
| Eurostat | Fetch latest HICP |

The probe updates the `provider_health` row (calls `recordSuccess` or `recordError`) and returns `{ ok, provider, error? }`.

## Admin UI

Located at `/admin/providers` (visible only with admin mode enabled).

### Table Columns

| Column | Description |
|--------|-------------|
| Provider | Status icon + name |
| Kind | Type badge (`price` / `fx` / `inflation`) |
| Last Success | Formatted timestamp or "Never" |
| Failures | Consecutive failures badge |
| Last Error | Truncated error, expandable on click |
| — | "Check Now" button triggers active probe |

### Status Colors

| consecutive_failures | Icon | Badge color |
|----------------------|------|-------------|
| 0 | ✓ green | green |
| 1–2 | △ amber | amber |
| 3+ | ✗ red | red |

## API Endpoints

- `GET /api/admin/providers/health` — List all 7 providers with health data
- `POST /api/admin/providers/:provider/probe` — Probe one provider on demand

See [[docs/api/admin|Admin API]] for full request/response contracts.

## Related

- [[docs/adr/034-admin-environment|ADR-034: Admin Environment]] — Architecture decision
- [[docs/features/admin-observability|Admin Observability Dashboard]] — Parent feature
- [[docs/api/admin|Admin API]] — Endpoint contracts
