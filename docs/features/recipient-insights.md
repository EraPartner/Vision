---
title: Recipient Insights Feature
type: feature
status: active
date: 2026-04-09
tags: [feature, recipients, analytics, insights, frontend, merchant]
description: Merchant/recipient spending analytics with KPI cards, month-over-month change alerts, and detailed spending tables
aliases: [merchant insights, spending insights, recipient analytics]
related_code:
  - apps/frontend/src/pages/RecipientInsightsPage.tsx
  - apps/frontend/src/components/statistics/RecipientInsightsTab.tsx
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/repositories/infoRepository.js
---

# Recipient Insights Feature

## Overview

The Recipient Insights page provides detailed spending analytics focused on merchants/recipients. It surfaces the top spending recipients, month-over-month spending changes, and a comprehensive detail table with pagination. It is accessible both as a standalone page and embedded within the Statistics page's Recipients tab.

## Architecture

### Data Source

Insights are computed by the backend via `infoRepository.getRecipientInsights(currency)` and returned as a single payload:

```typescript
interface RecipientInsightsResponse {
  topMerchants: Array<{
    recipientId: number;
    name: string;
    totalSpend: number;
    transactionCount: number;
    avgAmount: number;
    firstSeen: string;
    lastSeen: string;
  }>;
  monthOverMonth: Array<{
    recipientId: number;
    name: string;
    currentSpend: number;
    previousSpend: number;
    changePercent: number;
  }>;
}
```

### Frontend Page

Located at `[[apps/frontend/src/pages/RecipientInsightsPage.tsx]]`, the page consists of:

1. **KPI Cards** (3 cards):
   - Top recipient name and total spend
   - Top 10 total spend and transaction count
   - Average transaction amount across top 10

2. **Top 10 Bar Chart**: Horizontal bar chart of the top 10 recipients by spend, with color-coded bars.

3. **Month-over-Month Alerts**: Visual alerts showing recipients with significant spending changes:
   - **Increases**: Red-bordered cards with `TrendingUp` icon
   - **Decreases**: Blue-bordered cards with `TrendingDown` icon
   - Shows previous → current spend amounts

4. **Detail Table**: VirtualDataTable with columns:
   - Rank, Name, Total Spend, Transaction Count, Avg Amount, First Seen, Last Seen
   - Supports pagination with "load more" pattern

## Exclusion Support

The page respects the global exclusion settings:

```typescript
const exclusionsApply = settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'statistics';
const excludedRecipientIds = new Set(exclusionsApply ? settings.excludedRecipientIds : []);
```

When exclusions apply, filtered-out recipients are removed from both `topMerchants` and `monthOverMonth` arrays. A badge shows the count of excluded recipients.

## Pagination Strategy

The page uses a client-side "load more" pattern rather than true pagination:

```typescript
const [displayCount, setDisplayCount] = useState(pageSize);
const displayedMerchants = filteredData?.topMerchants.slice(0, displayCount) ?? [];
const hasMore = displayCount < totalMerchants;
```

- Initial display: `appSettings.defaultPageSize` recipients
- Load more: Increments by `pageSize` until all are shown
- Reset: Resets to `pageSize` when `totalMerchants` or `pageSize` changes

## Embedded Usage

The `RecipientInsightsTab` component (`[[apps/frontend/src/components/statistics/RecipientInsightsTab.tsx]]`) allows embedding the insights within the Statistics page. It accepts the top recipients chart as a prop, enabling the Statistics page to control the chart rendering while the insights tab handles MoM alerts and the detail table.

## Query Configuration

```typescript
useQuery({
  queryKey: ["recipient-insights", targetCurrency],
  queryFn: () => apiClient.getRecipientInsights({ currency: targetCurrency }),
  staleTime: 60000,
})
```

- **Query key**: `["recipient-insights", targetCurrency]`
- **Stale time**: 60 seconds
- **Currency-aware**: Results are normalized to the target currency

## Backend Implementation

> [!info] Phase G Migration (April 2026)
> The legacy `/api/info/recipient-insights` endpoint was removed. This feature now uses `GET /api/aggregations/recipient-insights` via [[docs/api/aggregations|Aggregations API]].

The endpoint `GET /api/aggregations/recipient-insights` in `[[apps/node-backend/src/routes/aggregations.js]]` delegates to `infoRepository.getRecipientInsights(currency)`, which performs SQL aggregations to compute:

1. **Top merchants**: SUM of expenses grouped by recipient, ordered by total spend descending
2. **Month-over-month changes**: Compares current month vs previous month spending per recipient

**Response envelope (Phase 2):** All aggregation endpoints return a [[docs/adr/026-unified-api-response-envelope|unified envelope]] with:
- Outer `ok` and `meta.requestId` transport layer
- Inner `data.data` containing the aggregation result
- Inner `data.meta.source` indicating `'mv'` (materialized view) or `'live'` (computed with exclusions)

**Frontend usage (Phase G):** `apiClient.getRecipientInsights(params)` now proxies to the aggregations endpoint and unwraps the envelope transparently, maintaining backward-compatible signatures.

Implementation notes:
- Recipient repository `getById` now uses lateral/pre-aggregated joins (matching list-query enrichment strategy) instead of correlated subqueries, preserving response fields while improving scalability characteristics.
- Recipient repository `update` now returns enriched recipient fields via a single CTE update-and-select query (instead of update + follow-up read), preserving payload semantics while reducing one round-trip.

Code links: [[apps/node-backend/src/routes/aggregations.js]], [[apps/node-backend/src/repositories/infoRepositoryRecipients.js]], [[apps/node-backend/src/repositories/recipientRepository.js]]

## Related Features

- [[docs/features/statistics|Statistics]] — RecipientInsightsTab is embedded in the Statistics page
- [[docs/features/transactions|Recipients]] — Recipient management and merging
- [[docs/features/splits|Splits & Owes]] — Recipient-based debt tracking
