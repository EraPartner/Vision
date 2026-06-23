---
title: Provider Health Tracking
type: feature
status: active
date: 2026-04-24
updated: 2026-06-16
last_modified: 2026-06-16
tags: [feature, admin, provider-health, observability, research-providers, twelve-data, finnhub, fmp, alpha-vantage]
description: Passive health tracking and active probing for all price, FX, inflation, and research data providers
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
> Passive health tracking for all 11 data providers (7 price/FX/inflation + 4 research). Every fetch records success/failure into the `provider_health` table. An active "Check now" probe is available per-provider via the Admin UI.

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
| `twelve_data` | Twelve Data | research |
| `finnhub` | Finnhub | research |
| `fmp` | FMP | research |
| `alpha_vantage` | Alpha Vantage | research |

> The four `research` providers (ADR-079) are recorded by the research aggregator's
> success/error calls. Their probe exercises each provider's **primary capability**:
> Twelve Data, Finnhub, and Alpha Vantage probe via `quote('AAPL')`; **FMP probes via
> `fundamentals('AAPL')`** because FMP is the primary provider for fundamentals (only
> 4th in the quote chain), so a quote probe would never expose the failure mode that
> actually matters. An unconfigured or invalid key surfaces as a failing probe
> (`<VAR> not configured`). A probe consumes one real API call against the provider's
> quota. Yahoo is shared with the price stack and stays under `price`.

## Data Model

Table: `provider_health`

| Column | Type | Description |
|--------|------|-------------|
| `provider` | text PK | Provider key (e.g. `binance`) |
| `kind` | text | `price` \| `fx` \| `inflation` \| `research` |
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
| Twelve Data | `twelveDataAdapter.quote('AAPL')` |
| Finnhub | `finnhubAdapter.quote('AAPL')` |
| FMP | `fmpAdapter.fundamentals('AAPL')` — probes primary capability (fundamentals), not quote |
| Alpha Vantage | `alphaVantageAdapter.quote('AAPL')` |

> [!info] FMP probe rationale (2026-06-16)
> FMP is the primary provider for `fundamentals` in the capability map but only 4th
> for `quote`. Probing via `quote` would report healthy even while real fundamentals
> fetches fail (the root cause of `consecutive_failures` climbing with
> `last_error = "fmp: no fundamentals"`). The FMP probe was changed to call
> `fundamentals('AAPL')` so the health row accurately reflects FMP's actual role.
> FMP errors thrown from `fundamentals()` now include the underlying HTTP status
> (e.g. `"fmp: no fundamentals (HTTP 403)"`), making the admin health row
> self-diagnosing when the legacy `/api/v3` endpoint was active.

The probe updates the `provider_health` row (calls `recordSuccess` or `recordError`) and returns `{ ok, provider, error? }`.

## Admin UI

Located at `/admin/providers` (visible only with admin mode enabled).

### Table Columns

| Column | Description |
|--------|-------------|
| Provider | Status icon + name |
| Kind | Type badge (`price` / `fx` / `inflation` / `research`) |
| Last Success | Formatted timestamp or "Never" |
| Failures | Consecutive failures badge |
| Last Error | Truncated error, expandable on click (only shown when `consecutive_failures > 0`) |
| — | "Check Now" button triggers active probe |

### Status Colors

| consecutive_failures | Icon | Badge color |
|----------------------|------|-------------|
| 0 | ✓ green | green |
| 1–2 | △ amber | amber |
| 3+ | ✗ red | red |

### Error Display Behavior

- The "Last Error" column and expanded error row only render when `consecutive_failures > 0`
- This prevents stale DB error messages from appearing for providers that have recovered (failures=0)
- Stale errors are preserved in the database but hidden from the UI until failures resume

## API Endpoints

- `GET /api/admin/providers/health` — List all 11 providers with health data
- `POST /api/admin/providers/:provider/probe` — Probe one provider on demand

See [[docs/api/admin|Admin API]] for full request/response contracts.

## Related

- [[docs/adr/034-admin-environment|ADR-034: Admin Environment]] — Architecture decision
- [[docs/features/admin-observability|Admin Observability Dashboard]] — Parent feature
- [[docs/api/admin|Admin API]] — Endpoint contracts
