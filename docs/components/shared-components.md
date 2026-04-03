---
title: Shared Components Reference
type: component
status: active
date: 2026-04-02
tags: [component, shared, utility, frontend, reference]
description: Reference documentation for shared utility components used across the application
aliases: [shared components, utility components, common components]
related_code:
  - apps/frontend/src/components/shared/VirtualDataTable.tsx
  - apps/frontend/src/components/shared/dateUtils.ts
  - apps/frontend/src/components/shared/ErrorBoundary.tsx
  - apps/frontend/src/components/shared/CategoryCombobox.tsx
  - apps/frontend/src/components/shared/RecipientCombobox.tsx
  - apps/frontend/src/components/shared/ExclusionToggle.tsx
  - apps/frontend/src/components/shared/WidgetVisibilityDialog.tsx
  - apps/frontend/src/components/shared/RemoteNewsImage.tsx
  - apps/frontend/src/components/notifications/UpdateNotification.tsx
  - apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx
---

# Shared Components Reference

## VirtualDataTable

**Path:** `[[apps/frontend/src/components/shared/VirtualDataTable.tsx]]` (701 lines)

The most complex shared component — a high-performance virtualized data table used across Transactions, Recipients, Owes, Net Worth, and more.

### Features

- **Virtual scrolling**: Uses `@tanstack/react-virtual` to render only visible rows
- **Client-side search**: Full-text search across all columns with debounced input
- **Server-side search**: Optional `onSearchChange` callback for database-level search
- **Column sorting**: Client-side or server-side (via `onSortChange`)
- **Column filtering**: Per-column popover filters with unique value selection
- **Inline editing**: Double-click to edit editable columns (Enter to save, Escape to cancel)
- **Column resizing**: Drag column borders to resize
- **Infinite scroll**: `onLoadMore` callback for pagination
- **Deferred rendering**: Uses `useDeferredValue` to avoid blocking during search

### Props Interface

```typescript
interface VirtualDataTableProps<T> {
  title: string;
  subtitle?: string;
  columns: Column<T>[];
  data: T[];
  emptyMessage?: React.ReactNode;
  actions?: React.ReactNode;
  onRowUpdate?: (index: number, updatedRow: T) => void;
  onRowDoubleClick?: (row: T, index: number) => void;
  totalItems?: number;
  isFetchingMore?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onSearchChange?: (query: string) => void;
  searchValue?: string;
  onSortChange?: (key: string | null, dir: SortDirection) => void;
  sortKeyProp?: string | null;
  sortDirProp?: SortDirection;
  maxHeight?: number;       // Default: 600
  rowHeight?: number;       // Default: 44
  cancelEditingRef?: MutableRefObject<(() => void) | null>;
  onEditingChange?: (editing: boolean) => void;
}
```

### Column Definition

```typescript
interface Column<T> {
  key: string;
  header: string;
  editable?: boolean;
  type?: "text" | "number" | "date";
  render?: (row: T, isEditing: boolean, index?: number) => React.ReactNode;
  className?: string;
  minWidth?: number;
  defaultWidth?: number;
  sortable?: boolean;     // Default: true
  filterable?: boolean;   // Default: true
}
```

### Usage Patterns

**Basic usage:**
```tsx
<VirtualDataTable
  title="Transactions"
  columns={columns}
  data={transactions}
  maxHeight={520}
/>
```

**With server-side search and sort:**
```tsx
<VirtualDataTable
  title="Recipients"
  columns={columns}
  data={recipients}
  onSearchChange={(q) => setSearchQuery(q)}
  onSortChange={(key, dir) => handleSort(key, dir)}
  sortKeyProp={sortKey}
  sortDirProp={sortDir}
  totalItems={total}
  onLoadMore={loadMore}
  hasMore={hasMore}
/>
```

## dateUtils

**Path:** `[[apps/frontend/src/components/shared/dateUtils.ts]]`

Date formatting utilities that respect app settings:

| Function | Purpose |
|----------|---------|
| `formatDateWithAppSettings(date, dateFormat)` | Formats a Date using the app's date format setting |
| `formatDateTimeStringWithAppSettings(dateStr, dateFormat, locale)` | Formats an ISO datetime string |
| `parseLocalDateFromYmd(ymd)` | Parses YYYY-MM-DD to a local Date object |

## ErrorBoundary

**Path:** `[[apps/frontend/src/components/shared/ErrorBoundary.tsx]]`

React Error Boundary component that catches rendering errors and displays a fallback UI instead of crashing the entire app.

## CategoryCombobox

**Path:** `[[apps/frontend/src/components/shared/CategoryCombobox.tsx]]`

Combobox for selecting categories with `GENERAL: DETAIL` format display. Used in transaction forms, filters, and settings.

## RecipientCombobox

**Path:** `[[apps/frontend/src/components/shared/RecipientCombobox.tsx]]`

Combobox for selecting recipients with search. Used in transaction forms and filters.

## ExclusionToggle

**Path:** `[[apps/frontend/src/components/shared/ExclusionToggle.tsx]]`

Toggle button for per-graph exclusion control in the Statistics page. Shows whether exclusions are active for a specific chart.

## WidgetVisibilityDialog

**Path:** `[[apps/frontend/src/components/shared/WidgetVisibilityDialog.tsx]]`

Dialog for toggling widget visibility on pages that support configurable layouts (Statistics, Portfolio Tax).

## RemoteNewsImage

**Path:** `[[apps/frontend/src/components/shared/RemoteNewsImage.tsx]]`

Image component for loading remote news thumbnails with fallback handling. Used in the portfolio news feed.

## Notification Components

### UpdateNotification

**Path:** `[[apps/frontend/src/components/notifications/UpdateNotification.tsx]]`

Displays app update notifications in the Electron desktop app. Checks for new versions via the `electronUpdater` API.

### UpcomingPaymentsNotification

**Path:** `[[apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx]]`

Shows notifications for upcoming planned/recurring payments.

## Usage Across Pages

| Component | Used In |
|-----------|---------|
| VirtualDataTable | Transactions, Recipients, Owes, Net Worth, Portfolio Tax |
| dateUtils | Every page (date formatting) |
| CategoryCombobox | Transaction forms, filters, category assignment |
| RecipientCombobox | Transaction forms, filters |
| ExclusionToggle | Statistics page (per-graph toggles) |
| WidgetVisibilityDialog | Statistics, Portfolio Tax |
| ErrorBoundary | App root (wraps entire application) |
