---
title: Market Lookup Feature
type: feature
status: active
date: 2026-06-05
updated: 2026-08-27
tags: [feature, market, lookup, stocks, search, frontend, research, security-detail, url-state]
description: Market Lookup (/research/market) is the consolidated security-detail surface for the Research workspace. It provides symbol search, a live price chart, a tabbed Details card (Fundamentals / Analyst / News via the multi-provider research aggregator), a Trading info card, and a Map-provider dialog. It is the deep-link target from the Markets Overview heat-map, ResearchHomePage search/watchlist tiles, and the /research/symbol/:symbol redirect. Aug 2026: the Details card's active tab is mirrored to `?tab=` via useTabParam.
aliases: [stock lookup, market search, security search, ticker search, market lookup]
related_code:
  - apps/frontend/src/pages/research/MarketLookupPage.tsx
  - apps/frontend/src/App.tsx
  - apps/frontend/src/features/portfolio/AddToWatchlistDialog.tsx
  - apps/node-backend/src/routes/marketLookup.js
---

The live quote header presents absolute and percentage movement through the shared `DeltaPill`.
Its label uses the app number-format locale, an explicit sign for non-zero changes, and an unsigned
neutral zero, matching Research Home, Watchlist, and comparison results.

# Market Lookup Feature

## Overview

Market Lookup (`/research/market`) is the **single security-detail surface** in the Research workspace. It replaced the retired `ResearchSymbolPage`: the route `/research/symbol/:symbol` now renders a redirect component (`RedirectSymbolToMarket` in `App.tsx`) that forwards to `/research/market?symbol=<symbol>`, preserving any `?investmentId=` query param.

Users reach Market Lookup by:

- Searching for a symbol on the Market Lookup page itself (`?symbol=` query param is pre-filled on arrival).
- Clicking a heat-map tile on `MarketOverviewPage` (`/research/markets`) — tiles deep-link to `/research/market?symbol=<symbol>`.
- Clicking a search result or watchlist tile on `ResearchHomePage` — `goToSymbol` navigates to `/research/market?symbol=<symbol>`.
- Following a legacy `/research/symbol/:symbol` URL (redirected automatically).
- Opening a holding's detail from the portfolio (double-click investment name) — passes `?investmentId=` alongside `?symbol=`.

## Architecture

### Frontend Page

Located at `[[apps/frontend/src/pages/research/MarketLookupPage.tsx]]`.

The page has two rendering paths:

**Yahoo / free-symbol path** (default — `isProviderAsset` is false):

1. **Quote header** — symbol, name, live price + change, currency; actions: Add to watchlist (`Star` icon → `AddToWatchlistDialog`) and Add to portfolio (`AddInvestmentFromMarketDialog`).
2. **Map provider button** (`Link2` icon, `t('research.mapping.button')`) in the header actions area — opens `ResearchMappingDialog` for ISIN-anchored cross-provider symbol mapping. `?investmentId=` is forwarded so the dialog can pre-seed the held investment's provider as already confirmed.
3. **Price chart + volume bars** — historical candlestick/line chart from Yahoo via `GET /api/market/quote` with `detail=basic` (switched from `quoteSummary` to halve outbound Yahoo calls).
4. **Tabbed Details card** (`t('research.details')`) with three lazy-loaded tabs:
   - **Fundamentals** (default) — `ResearchFundamentalsTab`: graded 0–100 health panel (`ResearchScorecard`) + grouped fundamentals fields, sourced from `GET /api/research/scorecard`.
   - **Analyst** — `ResearchAnalystTab`: consensus ratings + target price + recent analyst actions, sourced from `GET /api/research/analyst`.
   - **News** — `ResearchNewsTab`: recent news articles, sourced from `GET /api/research/news`.
   - **URL-synced (Aug 2026)**: the active tab (`fundamentals` | `analyst` | `news`) is mirrored to `?tab=` via [[docs/components/hooks#usetabparam-aug-2026|useTabParam]], so a shared `/research/market?symbol=…&tab=analyst` link reopens the same tab the sender was reading. Writes use `{ replace: true }`.
5. **Trading info card** — open / high / low / prev-close / volume / avg-volume + 52-week range; responsive 2–3 column grid.

**Provider-asset path** (`isProviderAsset` is true — non-Yahoo holdings: Kinesis, Binance, custom JSON):

- The tabbed Details card and Map-provider button are hidden (these assets have no data in the research aggregator).
- **Price Chart** is served from the holding's own stored history via `GET /api/investments/:id/price-history` (range mapped to `from_ms`), including Kinesis USD→EUR historical-rate conversion. Points carry price only; high/low collapse to close, no volume bars.
- A minimal price/change header is synthesised from those points.
- Fundamentals, analyst, and news sections are not shown.

### Backend Endpoints

Located at `[[apps/node-backend/src/routes/marketLookup.js]]`:

#### GET /api/market/quote

Fetches a live quote for one or more symbols. Called with `detail=basic` on Market Lookup (price-only fields; skips the `quoteSummary` fetch to halve Yahoo calls). Also used by `ResearchHomePage` (market snapshot strip + watchlist tiles) and `MarketOverviewPage` (heat-map tiles).

#### GET /api/market-lookup/search

Searches for securities matching a query string.

**Query parameters:**

- `q` — Search query (required)
- `type` — Filter by security type (optional)

**Response:**

```json
{
  "results": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "exchange": "NASDAQ",
      "type": "stock"
    }
  ],
  "total": 1
}
```

#### GET /api/market-lookup/symbol/:symbol

Gets detailed information for a specific symbol (used internally; the frontend now reads quote via `/api/market/quote`).

The tabbed Details card sources its data from the research aggregator endpoints (`/api/research/scorecard`, `/api/research/analyst`, `/api/research/news`) — documented in [[docs/api/research|Research API]].

### Integration with Price Providers

The market-lookup routes use Yahoo Finance as their primary provider (keyless, unmetered). For non-Yahoo portfolio holdings the page falls back to the holding's own stored price history (see provider-asset path above).

- **Yahoo Finance**: Primary source for stock/ETF quote, chart, and search.
- **Binance**: For cryptocurrency symbols (portfolio holdings only — free symbol search goes through Yahoo).
- **Kinesis**: For metals holdings (stored price history path).

> **Upstream resilience (`validateResult: false`):** every market-route Yahoo call — search, quote, quoteSummary, chart, and news — passes `{ validateResult: false }` to yahoo-finance2. The library validates each upstream payload against its own schema and _throws_ on any mismatch; Yahoo's responses drift (new `quoteType`s, non-Yahoo search entries missing `name`/`permalink`, null chart `meta`) and vary by IP/geo, so otherwise-fine requests intermittently 502. We read only a small subset of well-known fields, so the routes opt out of the throw and degrade to whatever data came back. Note: yahoo-finance2 v3.14.1 is behind latest; bumping it may reduce (but won't eliminate) these drifts.

### Quote Header Actions (Yahoo symbols)

When viewing a **Yahoo symbol**, the quote header exposes action buttons:

- **Add to portfolio** — opens `AddInvestmentFromMarketDialog` pre-filled with the symbol and provider.
- **Add to watchlist** (Star icon, `addWatchlist.title`) — opens `[[apps/frontend/src/features/portfolio/AddToWatchlistDialog.tsx|AddToWatchlistDialog]]` with a `prefill` object seeded from the current quote (`symbol`, `name`, `type`, `currency`, `price`). The dialog skips its internal search step and is one confirm away from adding the item. See [[docs/features/watchlist|Watchlist]] for full prefill details.
- **Map provider** (`Link2` icon, `research.mapping.button`) — opens `ResearchMappingDialog`. If the page was opened from a holding (`?investmentId=`), the dialog pre-seeds that holding's configured provider as already confirmed.

> [!info]
> The "Add to watchlist" and "Map provider" buttons are shown only for Yahoo symbols (`!isProviderAsset`). Provider-priced assets (Kinesis, Binance, custom JSON) use the alternate price-history path and do not expose these actions.

### Adding to Portfolio

When a user selects a security from search results:

1. The `AddInvestmentFromMarketDialog` component opens.
2. Pre-fills the investment form with symbol, name, and provider.
3. User confirms or modifies details.
4. Creates the investment via `POST /api/investments`.

## Deep-linking and Routing

| Incoming URL                                   | Resolution                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `/research/market?symbol=AAPL`                 | Market Lookup page; search pre-filled with `AAPL`                             |
| `/research/market?symbol=AAPL&investmentId=42` | Market Lookup; holding #42's provider pre-seeded in Map-provider dialog       |
| `/research/market?symbol=AAPL&tab=analyst`     | Market Lookup; Details card opens on the Analyst tab                          |
| `/research/symbol/AAPL`                        | `RedirectSymbolToMarket` in `App.tsx` → 301 to `/research/market?symbol=AAPL` |
| `/research/symbol/AAPL?investmentId=42`        | Same redirect; `investmentId` preserved                                       |

## isActiveRoute Fix (AppSidebar)

`isActiveRoute` in `AppSidebar.tsx` was made boundary-aware: `pathname === itemUrl || pathname.startsWith(itemUrl + "/")`. This prevents `/research/market` from spuriously highlighting the `/research/markets` (Markets Overview) sidebar entry — one path is a string prefix of the other.

## Related Features

- [[docs/features/research|Research Feature]] — overall Research workspace (Pillars A–D), aggregator, quota governor
- [[docs/features/portfolio|Portfolio]] — Investment management
- [[docs/features/watchlist|Watchlist]] — Watchlist surface; tiles deep-link to Market Lookup
- [[docs/integrations/price-providers|Price Providers]] — Market data sources
- [[docs/api/research|Research API]] — aggregator endpoints (scorecard, analyst, news) consumed by the tabbed Details card
