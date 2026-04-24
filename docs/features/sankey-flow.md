---
title: Sankey Flow Diagram
type: feature
status: active
date: 2026-04-24
tags: [feature, statistics, visualization, d3, sankey, flow, phase-7, analytics]
description: Interactive Sankey diagram showing income flow through spending categories for a selected year; displays top 12 categories and "Savings/Unspent" node; available as "Flow" tab in Statistics page.
aliases: [flow diagram, sankey, income flow, spending allocation]
related_code:
  - apps/node-backend/src/services/calculations/aggregation/sankey.js
  - apps/node-backend/src/routes/aggregations.js
  - apps/frontend/src/components/statistics/SankeyChart.tsx
  - apps/frontend/src/components/statistics/SankeyTab.tsx
  - apps/frontend/src/lib/api/aggregations.ts
---

# Sankey Flow Diagram (Phase 7)

> [!abstract] Overview
> The Sankey Flow visualization reveals how income is allocated across spending categories and savings. Phase 7 addition to the Statistics page, accessible via a new "Flow" tab.

## Feature Overview

The Sankey diagram shows the flow of money from income to:
- **Top 12 spending categories** (by total)
- **Savings/Unspent** node (net positive amounts not spent)

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
  - Nodes: Income source (single), top 12 categories, Savings/Unspent
  - Links: Weighted flows from income to categories
  - Hover effects: Highlight related flows
  - Tooltips: Show amount and percentage

### Visual Design

- **Colors**: Category-based colors matching the rest of the application
- **Link opacity**: Weighted by flow amount
- **Node sizing**: Proportional to total inflow

## Backend: `/api/aggregations/sankey`

### Endpoint

**Path:** `GET /api/aggregations/sankey`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `year` | integer | current year | Year to analyze (YYYY format) |
| `currency` | string | EUR | Target currency for conversion |
| `excluded_category_ids[]` | integer[] | [] | Categories to exclude from the flow |
| `excluded_recipient_ids[]` | integer[] | [] | Recipients to exclude from the flow |

### Response Structure

```json
{
  "data": {
    "nodes": [
      { "id": "__income__", "label": "Income", "value": 9550.50 },
      { "id": "cat:Groceries", "label": "Groceries", "value": 4200.50 },
      { "id": "cat:Transport", "label": "Transport", "value": 1850.00 },
      { "id": "cat:Utilities", "label": "Utilities", "value": 600.00 },
      { "id": "__savings__", "label": "Savings / Unspent", "value": 2900.00 }
    ],
    "links": [
      {
        "source": "__income__",
        "target": "cat:Groceries",
        "value": 4200.50
      },
      {
        "source": "__income__",
        "target": "cat:Transport",
        "value": 1850.00
      },
      {
        "source": "__income__",
        "target": "cat:Utilities",
        "value": 600.00
      },
      {
        "source": "__income__",
        "target": "__savings__",
        "value": 2900.00
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

| Field | Type | Description |
|-------|------|-------------|
| `nodes` | array | All nodes in the diagram (Income, top 12 categories, "Other", Savings) |
| `nodes[n].id` | string | Unique node identifier as string. Income: `"__income__"`, Savings: `"__savings__"`, Categories: `"cat:{category_name}"`. **Must be string** for d3-sankey link resolution. |
| `nodes[n].label` | string | Display name for node (e.g., "Income", "Groceries", "Savings / Unspent") |
| `nodes[n].value` | number | Total amount for this node (in target currency) |
| `links` | array | Flows from Income to categories/savings |
| `links[n].source` | string | Source node ID (always `"__income__"`) |
| `links[n].target` | string | Target node ID (e.g., `"cat:Groceries"` or `"__savings__"`) |
| `links[n].value` | number | Amount flowing (in target currency) |
| `year` | number | Year analyzed (YYYY format) |

### Backend Implementation

**Location:** `apps/node-backend/src/services/calculations/aggregation/sankey.js`

**Algorithm:**

1. Query all transactions for the specified year, filtered to income and spending
2. Apply exclusion filters (if provided):
   - If `excluded_category_ids[]` is non-empty, exclude transactions from those categories via `WHERE COALESCE(t.category_id, r.default_category_id) != ALL($N)`
   - If `excluded_recipient_ids[]` is non-empty, exclude transactions from those recipients via `WHERE t.recipient_id != ALL($N)`
3. Sum spending by category (group by category_id)
4. Sort categories by total descending, keep top 12
5. Calculate savings as: `total_income - total_spending`
6. Build node array: `[Income, ...topCategories, Savings]`
7. Build link array: one link per category + one for savings
8. Deep-clone data before mutation (d3-sankey mutates nodes/links in-place)

## Frontend: SankeyChart Component

**Location:** `apps/frontend/src/components/statistics/SankeyChart.tsx`

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
   const sankeyGen = sankey<NodeExtra, LinkExtra>()
     .nodeId((d) => d.id)  // d3-sankey uses this to resolve nodes
   ```
   Passing integer indices causes a "missing: 0" error that is silently caught, leaving `graph = null` and rendering a blank chart.

3. **Hover interactions**: Uses React state (`hoveredNodeId`, `hoveredLinkIndex`) to track hover state and adjust opacity accordingly.

4. **Color mapping**: Category-based coloring via `nodeColorMap` that maps node IDs to hex colors from a 14-color palette.

## Frontend: SankeyTab Component

**Location:** `apps/frontend/src/components/statistics/SankeyTab.tsx`

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
