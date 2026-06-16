---
title: Shared Components Reference
type: component
status: active
date: 2026-04-26
updated: 2026-06-16
last_modified: 2026-06-16
tags: [component, shared, utility, frontend, reference, phase-13, phase-c, phase-d, multi-select, export-filters, bug-hunt-2026-05-05, bug-hunt-2026-05-06, dateutils, utc-safe-dates, date-formatting, debounce, accessibility, aria-label, useCallback, aria-grid, keyboard-operability, a11y, performance, memoization, selection-toggle, upcoming-payments-hook, june-2026, symbol-search, research, ui-consistency]
description: Reference documentation for shared utility components used across the application. May 2026 adds UTC-safe date parsing, ARIA grid semantics on VirtualDataTable, the onActivateKeyDown keyboard helper, and the columnKeySignature selection-toggle reprocessing fix. June 2026 V11: UpcomingPaymentsNotification refactored onto shared useUpcomingPlannedPayments hook; stands down on dashboard when suggestions widget is visible. June 2026 V12: SymbolSearchBox and SymbolSearchResultItem added — canonical chrome and result row for all research symbol pickers.
aliases: [shared components, utility components, common components]
related_code:
  - apps/frontend/src/components/shared/VirtualDataTable.tsx
  - apps/frontend/src/components/shared/DataTable.tsx
  - apps/frontend/src/components/shared/ColumnFilter.tsx
  - apps/frontend/src/components/shared/dateUtils.ts
  - apps/frontend/src/components/shared/ErrorBoundary.tsx
  - apps/frontend/src/components/shared/CategoryCombobox.tsx
  - apps/frontend/src/components/shared/CategoryMultiCombobox.tsx
  - apps/frontend/src/components/shared/BankAccountMultiCombobox.tsx
  - apps/frontend/src/components/shared/RecipientCombobox.tsx
  - apps/frontend/src/components/shared/ExclusionToggle.tsx
  - apps/frontend/src/components/shared/WidgetVisibilityDialog.tsx
  - apps/frontend/src/components/shared/RemoteNewsImage.tsx
  - apps/frontend/src/components/shared/SymbolSearchBox.tsx
  - apps/frontend/src/components/shared/SymbolSearchResultItem.tsx
  - apps/frontend/src/components/notifications/UpdateNotification.tsx
  - apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx
  - apps/frontend/src/utils/a11y.ts
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
- **Stable source row mapping**: Filter/sort/search pipelines preserve row identity through `sourceIndex` mapping so row actions/edit handlers target original source rows
- **Inline editing**: Double-click to edit editable columns (Enter to save, Escape to cancel)
- **Dynamic edit column width**: Action column expands to 88px when in editing mode (default 40px) to prevent button overlap while editing
- **Column resizing**: Drag column borders to resize
- **Infinite scroll**: `onLoadMore` callback for pagination
- **Deferred rendering**: Uses `useDeferredValue` to avoid blocking during search
- **Edit cancellation** — `cancelEditing` wrapped in `useCallback` with proper dependency tracking (Phase C fix) to prevent memory leaks during unmount
- **ARIA grid semantics** (2026-05-29) — full screen-reader table structure; see section below
- **Keyboard row activation** (2026-05-29) — rows are focusable and Enter/Space-operable when `onRowDoubleClick` is set

### Performance: Selection-Toggle Reprocessing Fix (2026-05-29)

Remediates audit finding [[docs/reference/codebase-audit-2026-05#performance.4|performance.4]].

`processedRows` and the column-width re-seed effect previously depended on the `columns` array reference. `TransactionsTable` rebuilds the `columns` array on every checkbox toggle (new `Set` identity → new column array identity), causing `processedRows` to re-map and re-filter the entire loaded dataset on each selection change.

**Fix applied in `VirtualDataTable.tsx`:**

- A `columnsRef` (`useRef`) is kept current on every render, giving the body of `processedRows` and the width-seed effect access to the live column definitions without needing the array in their deps.
- A `columnKeySignature` string (`columns.map(c => c.key).join(",")`) replaces the `columns` array as the dependency. `columnKeySignature` is value-stable across selection toggles (column keys do not change when selection state changes), so neither `processedRows` nor the width-seed effect is invalidated by checkbox ticks.

```tsx
// Stable string dep — value-equal across selection toggles
const columnKeySignature = columns.map((c) => c.key).join(",");
const columnsRef = useRef(columns);
columnsRef.current = columns; // keep live reference current

// processedRows and the width-seed effect now depend on columnKeySignature
// and read columnsRef.current instead of listing `columns` directly.
```

### ARIA Grid Semantics (2026-05-29)

Resolves audit finding [[docs/reference/codebase-audit-2026-05#ux.1|ux.1]]. The `div`-based layout now carries a complete ARIA table role tree:

| Element | Role / Attribute | Notes |
|---|---|---|
| `CardContent` outer container | `role="table"` + `aria-rowcount` + `aria-colcount` | Row count = processed (filtered/sorted) rows; col count includes optional edit column |
| Header scroll wrapper | `role="rowgroup"` | Groups the single header row |
| Header row `div` | `role="row"` | |
| Each header cell | `role="columnheader"` + `aria-sort` | `aria-sort` reflects current sort: `"ascending"`, `"descending"`, or `"none"` |
| Body scroll wrapper | `role="rowgroup"` | Groups all body rows |
| Virtualizer sizing `div` | `role="presentation"` | Suppresses the layout-only container from the accessibility tree |
| Each body row | `role="row"` + `aria-rowindex` | `aria-rowindex` = virtual row index + 2 (1-based, +1 for header row) |
| Each body cell | `role="cell"` | |

### Keyboard Row Activation (2026-05-29)

Resolves audit finding [[docs/reference/codebase-audit-2026-05#ux.2|ux.2]] for VirtualDataTable rows. When `onRowDoubleClick` is provided:

- Rows receive `tabIndex={0}` — they enter the tab order.
- `onKeyDown` fires `onRowDoubleClick(row, sourceIndex)` on **Enter** or **Space** (same handler as double-click), giving keyboard users the same activation path as mouse users.
- Rows display a `focus-visible` ring for sighted keyboard users.

> [!info] The `onActivateKeyDown` helper in `[[apps/frontend/src/utils/a11y.ts]]` is used for similar keyboard activation on non-table interactive surfaces (CategoriesPage, OwesPage, WatchlistPage, StocksPage, CryptoPage). VirtualDataTable uses an inline handler with the same semantics.

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

Date formatting and parsing utilities with UTC-safe handling. All date-only strings (YYYY-MM-DD) parse as **local midnight**, not UTC midnight, to avoid off-by-one-day display issues for users east of UTC.

| Function | Purpose |
|----------|---------|
| `formatDate(date, pattern, locale?)` | Generic date formatter supporting patterns like `"yyyy-MM-dd"`, `"dd/MM/yyyy"`, `"MMM yyyy"`, etc. |
| `formatDateWithAppSettings(date, dateFormat)` | Formats a Date using the app's configured date format setting |
| `formatDateTimeStringWithAppSettings(dateStr, dateFormat, locale?)` | Formats an ISO datetime string with app date format + time |
| `parseLocalDateFromYmd(ymd)` | Parses YYYY-MM-DD to a **local** Date object (not UTC) — critical for avoiding calendar display errors |
| `parseISO(dateString)` | Parses ISO date strings; date-only strings (YYYY-MM-DD) become local midnight |
| `toYmd(date)` | Formats Date as YYYY-MM-DD (inverse of `parseLocalDateFromYmd`) |
| `differenceInDays(dateLeft, dateRight)` | Computes days between two dates |
| `formatDistanceToNow(date, options?)` | Returns relative time string (e.g., "2 hours ago") using `Intl.RelativeTimeFormat` |
| `appDateFormatToDateFnsPattern(appFormat)` | Converts app date format settings (e.g., "DD/MM/YYYY") to pattern strings |
| `formatMonthYearWithAppSettings(date, appDateFormat, locale?)` | Formats date as month/year respecting app format |
| `formatMonthLabelWithLocale(date, locale?, width?)` | Formats month name with locale (short/long) |
| `formatDateStringWithAppSettings(dateStr?, appDateFormat)` | Safely parses and formats ISO date strings |
| `formatDateTimeWithAppSettings(date, appDateFormat, locale?)` | Formats Date as "YYYY-MM-DD HH:mm" with app format |
| `weekStartsOnFromSetting(startOfWeek?)` | Returns 0 (Sunday) or 1 (Monday) for calendar week-start config |

### UTC-Safe Date Handling (2026-05-05)

**Problem:** Parsing date-only strings (YYYY-MM-DD) with `new Date()` creates UTC midnight, which appears as previous day for users in UTC+ timezones.

**Solution:** `parseISO()` and `parseLocalDateFromYmd()` detect date-only strings and create **local** midnight instead:
```typescript
// WRONG (UTC midnight)
new Date("2026-05-05")  // → 2026-05-04 for user in UTC+2

// CORRECT (local midnight via constructor)
const [y, m, d] = "2026-05-05".split('-').map(Number)
new Date(y, m - 1, d)  // → 2026-05-05 local midnight for all timezones
```

**Impact:** Recharts Date x-axis, transaction date displays, and all calendar pickers now show correct dates regardless of user timezone.

## DataTable

**Path:** `[[apps/frontend/src/components/shared/DataTable.tsx]]`

Non-virtualized shared table used on pages where full virtualization is not required.

Key behaviors:
- Uses the same source-row identity strategy as `VirtualDataTable` via `sourceIndex`, so filtered/sorted rows still map safely to original row handlers.
- Uses shared `ColumnFilter` instead of local duplicated filter implementations.
- Cleans up debounced search timers on unmount and safely syncs controlled `searchValue` updates.

## ColumnFilter

**Path:** `[[apps/frontend/src/components/shared/ColumnFilter.tsx]]`

Reusable column-filter popover component extracted from previous inline/duplicated implementations.

Responsibilities:
- Renders selectable unique values for a column.
- Applies/clears column filter state consistently across table variants.
- Centralizes filter UI behavior used by both `DataTable` and `VirtualDataTable`.

## ErrorBoundary

**Path:** `[[apps/frontend/src/components/shared/ErrorBoundary.tsx]]`

React Error Boundary component that catches rendering errors and displays a fallback UI instead of crashing the entire app.

## CategoryCombobox

**Path:** `[[apps/frontend/src/components/shared/CategoryCombobox.tsx]]`

Single-select combobox for selecting a category with `GENERAL: DETAIL` format display. Used in transaction forms, filters, and settings.

### Props

```typescript
interface CategoryComboboxProps {
  value: number | null;
  onChange: (categoryId: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}
```

## CategoryMultiCombobox

**Path:** `[[apps/frontend/src/components/shared/CategoryMultiCombobox.tsx]]` (Phase 13)

Multi-select category picker using Popover + Command (shadcn-ui). Allows selection of multiple categories for export filtering.

### Features

- **Multi-select**: Select multiple categories; selected items sort to top of list
- **Display**: Shows "{n} categories" when multiple selected, "All categories" when none selected
- **Clear button**: Clears all selections
- **i18n**: Uses `combobox.categoryMulti.*` keys

### Props

```typescript
interface CategoryMultiComboboxProps {
  value: number[];
  onChange: (categoryIds: number[]) => void;
  placeholder?: string;
  disabled?: boolean;
}
```

## BankAccountMultiCombobox

**Path:** `[[apps/frontend/src/components/shared/BankAccountMultiCombobox.tsx]]` (Phase 13)

Multi-select bank account picker for export filtering. Fetches distinct IBANs from `/api/info/banks` endpoint using `useBankAccounts` hook.

### Features

- **Multi-select**: Select multiple bank accounts (real IBANs, not adapter keys)
- **Display**: Shows "{n} accounts" when multiple selected, "All accounts" when none selected
- **Clear button**: Clears all selections
- **Data source**: Real bank account IBANs from API (differs from deprecated `getBanks()` which returned adapter keys)
- **i18n**: Uses `combobox.bankAccount.*` keys

### Props

```typescript
interface BankAccountMultiComboboxProps {
  value: string[];
  onChange: (ibans: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}
```

### Dependencies

Uses `useBankAccounts` hook (Phase 13) which wraps `apiClient.getDistinctBankAccounts()` with 2-min staleTime cache.

## RecipientCombobox

**Path:** `[[apps/frontend/src/components/shared/RecipientCombobox.tsx]]`

Combobox for selecting recipients with search. Used in transaction forms and filters.

### Features

- **Debounced search** — 300ms debounce on input to prevent per-keystroke API fetches (Phase C fix)
- **Async search** — Fetches matching recipients from `/api/recipients` endpoint via `useRecipients` hook
- **Fuzzy matching** — Backend performs fuzzy string matching on recipient name/alias
- **Display** — Shows recipient name or "(none)" fallback

### Props

```typescript
interface RecipientComboboxProps {
  value: number | null;
  onChange: (recipientId: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}
```

### Implementation Detail (Phase C)

The 300ms debounce prevents API overload on rapid typing:

```typescript
// Before (bad): Every keystroke triggers API call
onSearchChange={(query) => {
  refetch({ filter: query });  // ❌ per-keystroke
}}

// After (good): 300ms debounce
const debouncedSearch = useDebounce(searchQuery, 300);
useEffect(() => {
  refetch({ filter: debouncedSearch });
}, [debouncedSearch, refetch]);
```

This reduces network traffic and backend load significantly in a typical typing scenario.

## ExclusionToggle

**Path:** `[[apps/frontend/src/components/shared/ExclusionToggle.tsx]]`

Toggle button for per-graph exclusion control in the Statistics page. Shows whether exclusions are active for a specific chart.

## WidgetVisibilityDialog

**Path:** `[[apps/frontend/src/components/shared/WidgetVisibilityDialog.tsx]]`

Dialog for toggling widget visibility on pages that support configurable layouts (Statistics, Portfolio Tax).

## onActivateKeyDown (a11y utility)

**Path:** `[[apps/frontend/src/utils/a11y.ts]]`

A small keyboard-activation helper that makes previously mouse-only surfaces operable by keyboard users. Resolves audit finding [[docs/reference/codebase-audit-2026-05#ux.2|ux.2]] across non-table interactive elements.

```typescript
import { onActivateKeyDown } from "@/utils/a11y";

// Non-interactive div or Card that had only onClick/onDoubleClick:
<div
  role="button"
  tabIndex={0}
  onClick={handleOpen}
  onKeyDown={onActivateKeyDown(handleOpen)}
>
  ...
</div>

// Native button that previously had only onDoubleClick:
<button
  type="button"
  onKeyDown={onActivateKeyDown(() => openMarketLookup(symbol))}
>
  ...
</button>
```

`onActivateKeyDown(handler)` returns an `onKeyDown` callback that:
- Fires `handler` on **Enter** or **Space**.
- Calls `e.preventDefault()` to suppress page scrolling on Space.
- **Ignores events that bubbled from a nested focusable child** (`e.target !== e.currentTarget`) — prevents double-firing when the user operates an inner control.

### Usage in the codebase

| Surface | Pattern | Notes |
|---|---|---|
| `CategoriesPage` rows | `role="button"` + `tabIndex` + `onKeyDown` | Opens category detail on Enter/Space |
| `OwesPage` debtor cards | `role="button"` + `tabIndex` + `onKeyDown` | Selects recipient on Enter/Space |
| `WatchlistPage` holding cards | `role="button"` + `tabIndex` + `onKeyDown` | Opens detail dialog on Enter/Space |
| `StocksPage` name buttons | Native `<button>` + `onKeyDown` | Opens market lookup on Enter/Space |
| `CryptoPage` name buttons | Native `<button>` + `onKeyDown` | Opens market lookup on Enter/Space |
| `InvestmentDetailDialog` title button | Native `<button>` + `onKeyDown` | Opens market lookup on Enter/Space |

> [!tip] Pair `role="button"` + `tabIndex={0}` + `onActivateKeyDown` only on elements that cannot be refactored to a real `<button>`. When the element is already a native button, omit `role` and `tabIndex` — just add `onKeyDown`.

## RemoteNewsImage

**Path:** `[[apps/frontend/src/components/shared/RemoteNewsImage.tsx]]`

Image component for loading remote news thumbnails with fallback handling. Used in the portfolio news feed.

## SymbolSearchBox

**Path:** `[[apps/frontend/src/components/shared/SymbolSearchBox.tsx]]`

Canonical ticker/company search box chrome shared across every symbol picker in the Research section. Introduced in a June 2026 UI-consistency pass that brought `MarketLookupPage`, `ResearchComparePage`, and `ChartBuilderPage` in line with `ResearchHomePage`'s reference look.

**Responsibility split:** `SymbolSearchBox` owns only the visual chrome (tall glass input, leading `Search` icon, optional trailing loading spinner, `glass-elevated` floating dropdown). Each page retains its own query logic and passes result rows as `children`. Rows inside the dropdown should use `SymbolSearchResultItem`.

### Props

```typescript
interface SymbolSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Whether the results dropdown should be shown. */
  open: boolean;
  /** Result rows plus any empty / unavailable / no-results states. */
  children: ReactNode;
  autoFocus?: boolean;
  /** Shows a spinner on the trailing edge of the input while fetching. */
  loading?: boolean;
  /** Defaults to `placeholder` when omitted. */
  ariaLabel?: string;
  /** Layout/width class for the outer wrapper (e.g. `max-w-2xl`). */
  className?: string;
}
```

### Visual spec

- Outer wrapper: `relative` + caller-supplied `className` (all four research pickers use `max-w-2xl`).
- Input: `h-14 pl-12 text-base glass-regular` with a `Search` icon pinned `left-4 top-1/2`.
- Loading spinner: `h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent`, pinned `right-4 top-1/2`; only rendered when `loading` is `true`.
- Dropdown: `Card` with `glass-elevated border border-border shadow-lg z-50`, opening `top-full mt-2`; `CardContent` has `p-1` padding.

### Pages using SymbolSearchBox

| Page | Notes |
|---|---|
| `ResearchHomePage` | No `loading` prop; autoFocus; was the reference implementation |
| `MarketLookupPage` | `loading` prop passed (shows spinner during fetch) |
| `ResearchComparePage` | `loading` prop passed; result rows use `leadingIcon={<Plus />}` on `SymbolSearchResultItem` |
| `ChartBuilderPage` | `loading` prop passed; result rows use `leadingIcon={<Plus />}` on `SymbolSearchResultItem` |

> [!info] `AddToWatchlistDialog` was deliberately **not** migrated to `SymbolSearchBox`. It renders results as an inline scrollable list inside a modal (with a `Label`), which is a different UX context from the floating-dropdown pattern.

## SymbolSearchResultItem

**Path:** `[[apps/frontend/src/components/shared/SymbolSearchResultItem.tsx]]`

Canonical company/ticker search-result row, shared across every symbol picker (Research home, Market Lookup, Compare, Chart Builder, Add-to-Watchlist). Ensures consistent row layout: monospaced ticker, company name, asset-type badge, and exchange label.

### Props

```typescript
interface SymbolSearchResultItemProps {
  item: SymbolSearchResult;           // { symbol, name, type, exchange }
  onSelect: (item: SymbolSearchResult) => void;
  /** Optional leading affordance for add-to-list pickers (e.g. a Plus icon). */
  leadingIcon?: ReactNode;
  className?: string;
}
```

The exported `SymbolSearchResult` interface (`{ symbol, name, type, exchange }`) is the shared shape across both `searchResearch` and `searchMarket` API responses.

- **Navigate-style pickers** (Research home, Market Lookup): omit `leadingIcon`.
- **Add-style pickers** (Compare, Chart Builder): pass `leadingIcon={<Plus className="..." />}`.
- `AddToWatchlistDialog` also uses this component for its inline scrollable results list.

## Notification Components

### UpdateNotification

**Path:** `[[apps/frontend/src/components/notifications/UpdateNotification.tsx]]`

Displays app update notifications in the Electron desktop app. Checks for new versions via the `electronUpdater` API.

### UpcomingPaymentsNotification

**Path:** `[[apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx]]`

Shows notifications for upcoming planned/recurring payments.

#### V11 Refactor (June 2026)

`UpcomingPaymentsNotification` was refactored onto the shared `useUpcomingPlannedPayments` hook:

- Data fetch and dismissed-ID state moved to `hooks/useUpcomingPlannedPayments.ts` (shared with `SuggestionCard`).
- **Dashboard stand-down**: On the `/` route, the component returns `null` while `useWidgetVisibility('dashboard', []).isVisible('suggestions')` is `true` (the suggestion card is visible). Hiding the widget brings the banner back.
- **macOS dock badge**: Set to non-dismissed upcoming count; cleared on unmount. Logic unchanged.
- Dismissal store is now module-level (shared), so dismissing from `SuggestionCard` is immediately reflected here and vice versa.

### Accessibility (Phase C)

- **aria-label** attributes added to dismiss and dismiss-all buttons for screen reader accessibility (Phase C fix)
- Dismiss button label: `aria-label={t('upcoming.dismissAll')}` for "Dismiss all" action
- Individual item dismiss uses consistent accessibility labeling pattern

## Usage Across Pages

| Component | Used In |
|-----------|---------|
| VirtualDataTable | Transactions, Recipients, Owes, Net Worth, Portfolio Tax |
| DataTable | Shared non-virtualized list/table views |
| ColumnFilter | DataTable + VirtualDataTable column filtering |
| dateUtils | Every page (date formatting) |
| CategoryCombobox | Transaction forms, filters, category assignment |
| CategoryMultiCombobox | Export filters (Phase 13) |
| BankAccountMultiCombobox | Export filters (Phase 13) |
| RecipientCombobox | Transaction forms, filters |
| ExclusionToggle | Statistics page (per-graph toggles) |
| WidgetVisibilityDialog | Statistics, Portfolio Tax |
| ErrorBoundary | App root (wraps entire application) |
| onActivateKeyDown | CategoriesPage, OwesPage, WatchlistPage, StocksPage, CryptoPage, InvestmentDetailDialog |
| SymbolSearchBox | ResearchHomePage, MarketLookupPage, ResearchComparePage, ChartBuilderPage |
| SymbolSearchResultItem | ResearchHomePage, MarketLookupPage, ResearchComparePage, ChartBuilderPage, AddToWatchlistDialog |
