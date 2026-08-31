---
title: Sankey Flow Diagram
type: feature
status: active
date: 2026-04-24
tags: [feature, statistics, visualization, d3, sankey, flow, phase-7, analytics]
description: Interactive Sankey diagram showing income and funding-gap flow through spending categories for a selected year; displays top 12 categories and any savings or funding gap; available as "Flow" tab in Statistics page.
aliases: [flow diagram, sankey, income flow, spending allocation]
related_code:
  - apps/node-backend/src/services/calculations/aggregation/sankey.js
  - apps/node-backend/src/repositories/infoRepositorySankey.js
  - apps/node-backend/src/routes/aggregations.js
  - apps/frontend/src/features/statistics/SankeyChart.tsx
  - apps/frontend/src/features/statistics/SankeyTab.tsx
  - apps/frontend/src/lib/api/aggregations.ts
updated: 2026-08-31
---

# Sankey Flow Diagram (Phase 7)

> [!abstract] Overview
> The Sankey Flow visualization reveals how income is allocated across spending categories and savings. Phase 7 addition to the Statistics page, accessible via a new "Flow" tab.

## Feature Overview

The Sankey diagram shows the flow of money from income to:

- **Top 12 spending categories** (by total)
- **Savings/Unspent** node (net positive amounts not spent)
- **Funding gap** source (spending above income, without attributing it to a
  specific debt or prior-cash source)

This visualization helps answer:

- "Where does my money go?"
- "What percentage goes to groceries vs. transport?"
- "How much am I saving?"

## User Interface

### Flow Tab

Located in the Statistics page (`/statistics`) as the fourth tab:

**Components:**

- **Year Selector**: Dropdown to choose analysis year
- **Sankey Chart**: Interactive d3-sankey rendering with:
  - Nodes: income, an optional funding-gap source, a spending hub, top 12
    categories, and optional savings/unspent
  - Links: balanced weighted flows through the spending hub
  - Hover effects: Highlight related flows
  - Hover labels: Show the node amount

### Visual Design

- **Colors**: Category-based colors matching the rest of the application
- **Link opacity**: Weighted by flow amount
- **Node sizing**: Proportional to total inflow

## Backend: `/api/aggregations/sankey`

### Endpoint

**Path:** `GET /api/aggregations/sankey`

**Query Parameters:**

| Parameter                  | Type      | Default      | Description                         |
| -------------------------- | --------- | ------------ | ----------------------------------- |
| `year`                     | integer   | current year | Year to analyze (YYYY format)       |
| `currency`                 | string    | EUR          | Target currency for conversion      |
| `excluded_category_ids[]`  | integer[] | []           | Categories to exclude from the flow |
| `excluded_recipient_ids[]` | integer[] | []           | Recipients to exclude from the flow |

### Response Structure

```json
{
  "data": {
    "nodes": [
      { "id": "__income__", "label": "__income__", "value": 9550.5 },
      { "id": "__spending__", "label": "__spending__", "value": 6650.5 },
      { "id": "cat:17", "label": "Food: Groceries", "value": 4200.5 },
      { "id": "cat:23", "label": "Travel: Transport", "value": 1850.0 },
      { "id": "cat:31", "label": "Home: Utilities", "value": 600.0 },
      { "id": "__savings__", "label": "__savings__", "value": 2900.0 }
    ],
    "links": [
      {
        "source": "__income__",
        "target": "__spending__",
        "value": 6650.5
      },
      {
        "source": "__spending__",
        "target": "cat:17",
        "value": 4200.5
      },
      {
        "source": "__spending__",
        "target": "cat:23",
        "value": 1850.0
      },
      {
        "source": "__income__",
        "target": "__savings__",
        "value": 2900.0
      }
    ],
    "year": 2026
  },
  "meta": {
    "source": "live",
    "computedAt": "2026-04-24T12:34:56Z"
  }
}
```

**Data Model:**

| Field             | Type   | Description                                                                                                                                                                                      |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nodes`           | array  | Income, spending hub, top 12 categories, optional "Other", savings, and funding-gap nodes.                                                                                                       |
| `nodes[n].id`     | string | Stable identity. Reserved nodes use `"__income__"`, `"__spending__"`, `"__funding_gap__"`, `"__uncategorised__"`, `"__other__"`, and `"__savings__"`; real categories use `"cat:{category_id}"`. |
| `nodes[n].label`  | string | Category display name for real categories. Reserved nodes carry their protocol ID and are localized by the frontend.                                                                             |
| `nodes[n].value`  | number | Total amount for this node (in target currency)                                                                                                                                                  |
| `links`           | array  | Balanced income/funding-gap to spending, spending to category, and income to savings flows.                                                                                                      |
| `links[n].source` | string | Source node ID: income/funding-gap into spending, spending into categories, or income into savings.                                                                                              |
| `links[n].target` | string | Target node ID such as `"__spending__"`, `"cat:17"`, or `"__savings__"`.                                                                                                                         |
| `links[n].value`  | number | Amount flowing (in target currency)                                                                                                                                                              |
| `year`            | number | Year analyzed (YYYY format)                                                                                                                                                                      |

### Backend Implementation

**Location:** `apps/node-backend/src/services/calculations/aggregation/sankey.js`

**Algorithm:**

1. `infoRepositorySankey` aggregates the selected year by effective category
   ID, display label, currency, and sign. It applies the canonical category and
   primary-recipient exclusions and the shared include-transfers setting.
2. Convert each currency aggregate with the current latest-rate conversion
   policy, then sum income and spending without using display labels as keys.
3. Sort spending categories by total, retain the top 12, and merge the rest
   under the reserved `__other__` identity. NULL effective categories use
   `__uncategorised__`; a real category with the same display name remains a
   separate `cat:{id}` node.
4. Balance the graph through a spending hub. Income funds
   `min(income, spending)`; `__funding_gap__` funds any excess spending; the hub
   sends the actual totals to categories. Surplus income flows to savings.
   This exposes an overspent year without falsely inflating the income node or
   claiming which account, debt, or prior cash funded the gap.
5. Reconcile nodes and links in integer cents before serialization. This makes
   every internal node exactly flow-conserving even when several four-decimal
   source totals round in different directions.
6. Deep-clone data before layout because d3-sankey mutates nodes and links.

## Frontend: SankeyChart Component

**Location:** `apps/frontend/src/features/statistics/SankeyChart.tsx`

**Props:**

```typescript
interface SankeyChartProps {
  readonly data: SankeyFlowData;
  readonly height?: number;
}
```

**Implementation:**

- Uses `d3-sankey` for layout calculation
- SVG rendering with:
  - `<path>` elements for curved links (via `sankeyLinkHorizontal`)
  - `<rect>` elements for nodes
  - Text labels for node names with smart positioning (left/right based on node position)
  - Hover highlights via state-based opacity transitions
  - Value tooltips on node hover

**Important Implementation Details:**

1. **Deep cloning**: Deep-clones data before layout because d3-sankey mutates nodes and links in-place:

   ```typescript
   const clonedNodes = data.nodes.map((n) => ({ ...n }));
   const clonedLinks = data.links.map((l) => ({ ...l }));
   ```

2. **String ID Resolution**: d3-sankey's `nodeId` accessor builds a string-keyed internal map. **Must pass string IDs directly** (not integer indices) so d3-sankey can resolve link source/target via the nodeId function:

   ```typescript
   const sankeyGen = sankey<NodeExtra, LinkExtra>().nodeId((d) => d.id); // d3-sankey uses this to resolve nodes
   ```

   Passing integer indices causes a "missing: 0" error that is silently caught, leaving `graph = null` and rendering a blank chart.

3. **Hover interactions**: Uses React state (`hoveredNodeId`, `hoveredLinkIndex`) to track hover state and adjust opacity accordingly.

4. **Localization**: Reserved protocol IDs are mapped to English or Dutch
   translation keys before layout. User category labels pass through unchanged.

5. **Color mapping**: Real categories hash their display label to match sibling
   charts; reserved nodes hash their stable protocol ID, so switching locale
   does not change those colors.

## Frontend: SankeyTab Component

**Location:** `apps/frontend/src/features/statistics/SankeyTab.tsx`

**Props:**

```typescript
interface SankeyTabProps {
  graphExclusions: Record<string, boolean>;
  onToggleExclusion: (key: string) => void;
  exclusionsApply: boolean;
}
```

**Features:**

- Year selector dropdown
- **ExclusionToggle button**: Shows/hides category and recipient exclusion filters (consistent with MonthlyChart, CashflowComparison, and other statistics charts)
- Fetch SankeyFlowData via `apiClient.getSankeyFlow()`, conditionally including excluded IDs in query key and API call based on `exclusionsApply && isFiltered`
- Render SankeyChart
- Error/loading states

**Exclusion Logic:**

The component passes excluded category/recipient IDs to the API only when:

- `exclusionsApply === true` (user has enabled exclusions globally in settings)
- AND `isFiltered === true` (the exclusions array is non-empty)

This prevents unnecessary API filtering on unfiltered datasets.

## Related Features

- [[docs/features/statistics|Statistics Feature]] — Host page
- [[docs/features/cash-flow-forecast|Cash Flow Forecast]] — Related aggregation

## API Integration

Frontend API client method in `apps/frontend/src/lib/api/aggregations.ts`:

```typescript
export async function getSankeyFlow(params: {
  year: number;
  currency?: string;
  excluded_category_ids?: number[];
  excluded_recipient_ids?: number[];
}): Promise<AggregationEnvelope<SankeyFlowData>> {
  // Calls GET /api/aggregations/sankey?year=2026&currency=EUR&excluded_category_ids[]=5&excluded_category_ids[]=10
  // Uses buildExclusionQuery + apiRequest pattern for correct array serialization
}
```

## Related

- [[docs/api/aggregations|Aggregations API]]
- [[docs/features/statistics|Statistics Feature]]
