---
title: Shared Components Reference
type: component
status: active
date: 2026-04-26
updated: 2026-08-31
last_modified: 2026-08-27
tags: [component, shared, utility, frontend, reference, phase-13, phase-c, phase-d, multi-select, export-filters, bug-hunt-2026-05-05, bug-hunt-2026-05-06, dateutils, utc-safe-dates, date-formatting, debounce, accessibility, aria-label, useCallback, aria-grid, keyboard-operability, a11y, performance, memoization, selection-toggle, upcoming-payments-hook, june-2026, symbol-search, research, ui-consistency, glass-consistency, popover-glass-thick, trend-hue, gain-loss, design-system, card-sheen, corner-orb, adr-105]
description: Reference documentation for shared utility components used across the application. May 2026 adds UTC-safe date parsing, ARIA grid semantics on VirtualDataTable, the onActivateKeyDown keyboard helper, and the columnKeySignature selection-toggle reprocessing fix. June 2026 V11: UpcomingPaymentsNotification refactored onto shared useUpcomingPlannedPayments hook; its visible reminder is dashboard-only while AppLayout keeps native badge synchronization mounted on all routes. 2026-06-24: SuggestionCard dashboard widget removed; UpcomingPaymentsNotification is now the sole upcoming-payments notification surface. June 2026 V12: SymbolSearchBox and SymbolSearchResultItem added — canonical chrome and result row for all research symbol pickers. June 2026 (glass consistency): SymbolSearchBox dropdown material changed from glass-elevated to glass-thick to match the rest of the floating-overlay system. 2026-06-24 (gain/loss consistency pass): TrendHue added — single shared overlay component for the faint diagonal card hue on all summary/stat cards. 2026-08-27: StateBlock unifies empty, page-error, and crash-fallback anatomy; CardSheen has a named feature tier for the Performance total-value card's 10rem sheen. 2026-08-25: VirtualDataTable visible rows gained a memo boundary so server-search input updates do not rebuild unchanged row subtrees; StatCard moved into shared ownership for its dashboard, portfolio, research, and statistics consumers. 2026-08-26: SymbolSearchBox gained ARIA listbox semantics and input-owned keyboard navigation; RecipientCombobox now resolves the selected label independently of its filtered search page; VirtualDataTable column resizing gained pointer and keyboard operation.
aliases: [shared components, utility components, common components]
related_code:
  - apps/frontend/src/components/shared/VirtualDataTable.tsx
  - apps/frontend/src/components/shared/ColumnFilter.tsx
  - apps/frontend/src/lib/dateUtils.ts
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
  - apps/frontend/src/components/shared/TrendHue.tsx
  - apps/frontend/src/components/shared/CardSheen.tsx
  - apps/frontend/src/components/notifications/UpdateNotification.tsx
  - apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx
  - apps/frontend/src/utils/a11y.ts
---

# Shared Components Reference

`MultiCombobox` and its bank-account/category wrappers forward `id`, `aria-label`, and `aria-labelledby` to the rendered trigger. This lets a normal `<Label htmlFor>` name the real combobox button. `SegmentedButtons`, `ChartPeriodSelector`, and `ResearchRangeSelector` expose the same group-naming contract.

`PageShell` owns page-level vertical rhythm. It defaults to 24px (`space-y-6`); only Dashboard uses the explicit `rhythm="airy"` 32px variant. Route entrance motion remains owned by `PageTransition`, so PageShell adds no animation.

## VirtualDataTable

**Path:** `[[apps/frontend/src/components/shared/VirtualDataTable.tsx]]`

The most complex shared component — a high-performance virtualized data table used across Transactions, Recipients, Owes, Net Worth, and more.

### Features

- **Optional table heading**: `title` is optional. When a page already owns the semantic heading,
  the table can render an action-only header without emitting an empty or duplicate heading.

- **Virtual scrolling**: Uses `@tanstack/react-virtual` to render only visible rows
- **Client-side search**: Full-text search across all columns with debounced input
- **Server-side search**: Optional `onSearchChange` callback for database-level search
- **Column sorting**: Client-side or server-side (via `onSortChange`)
- **Column filtering**: Per-column popover filters with unique value selection; each active-filter
  chip exposes a localized clear-button name that includes the column label
- **Stable source row mapping**: Filter/sort/search pipelines preserve row identity through `sourceIndex` mapping so row actions/edit handlers target original source rows
- **Inline editing**: Double-click to edit editable columns (Enter to save, Escape to cancel)
- **Dynamic edit column width**: Action column expands to 88px when in editing mode (default 40px) to prevent button overlap while editing
- **Column resizing**: Drag column-border separators with a mouse, pen, or touch pointer; focus a separator and use Left/Right Arrow for 10-pixel steps. Widths never cross the column's minimum.
- **Infinite scroll**: `onLoadMore` callback for pagination
- **History-aware scroll restoration**: remembers the body scroll offset per browser history entry and table identity. Returning with Back restores the prior offset; infinite tables request more pages until that offset is reachable. The in-memory least-recently-used cache is capped at 64 entries. Consumers with reused or translated titles can provide `scrollRestorationKey` for a stable identity.
- **Deferred rendering**: Uses `useDeferredValue` to avoid blocking during search
- **Memoized visible rows**: Server-search keystrokes leave unchanged row and context-menu subtrees mounted without rerendering
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

### Performance: Server-Search Row Memoization (2026-08-25)

Completes the remaining visible-row scope of the `VirtualDataTable` search-keystroke finding in `TODO.md`.

- In server-search mode, the existing `localSearchDep` guard keeps the full `processedRows` pipeline stable while the user types.
- `MemoizedVirtualizedTableRow` adds the missing row-level boundary. A search-input state update no longer rebuilds unchanged visible cells, Radix context menus, or tag subtrees.
- Editing state, edit values, column widths, row data, column render closures, virtual position, and row-action handlers remain explicit props. Changes to any of those still rerender the affected visible rows.
- The focused component test uses a column render counter to prove that a server-search keystroke does not rerender unchanged rows. Existing editing, keyboard, context-menu, and search tests protect interaction behavior.

### ARIA Grid Semantics (2026-05-29)

Resolves audit finding [[docs/reference/codebase-audit-2026-05#ux.1|ux.1]]. The `div`-based layout now carries a complete ARIA table role tree:

| Element                       | Role / Attribute                                                    | Notes                                                                                 |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CardContent` outer container | `role="table"` + `aria-rowcount` + `aria-colcount`                  | Row count = processed (filtered/sorted) rows; col count includes optional edit column |
| Header scroll wrapper         | `role="rowgroup"`                                                   | Groups the single header row                                                          |
| Header row `div`              | `role="row"`                                                        |                                                                                       |
| Each header cell              | `role="columnheader"` + `aria-sort`                                 | `aria-sort` reflects current sort: `"ascending"`, `"descending"`, or `"none"`         |
| Each resize handle            | `role="separator"` + `aria-orientation="vertical"` + value metadata | Focusable; pointer drag and Left/Right Arrow update the same clamped width state      |
| Body scroll wrapper           | `role="rowgroup"`                                                   | Groups all body rows                                                                  |
| Virtualizer sizing `div`      | `role="presentation"`                                               | Suppresses the layout-only container from the accessibility tree                      |
| Each body row                 | `role="row"` + `aria-rowindex`                                      | `aria-rowindex` = virtual row index + 2 (1-based, +1 for header row)                  |
| Each body cell                | `role="cell"`                                                       |                                                                                       |

### Keyboard Row Activation (2026-05-29)

Resolves audit finding [[docs/reference/codebase-audit-2026-05#ux.2|ux.2]] for VirtualDataTable rows. When `onRowDoubleClick` is provided:

- The first visible interactive row receives `tabIndex={0}` and its siblings receive `tabIndex={-1}`. Arrow keys move that single tab stop between rows, so the table enters the page tab order once.
- `onKeyDown` fires `onRowDoubleClick(row, sourceIndex)` on **Enter** or **Space** (same handler as double-click), giving keyboard users the same activation path as mouse users.
- Rows display a `focus-visible` ring for sighted keyboard users.
- Row action controls that are hover-revealed for fine pointers remain visible on coarse pointers.
  Repeated icon actions and filter controls use the shared 40px `icon-touch-target` hit area.

> [!info] The `onActivateKeyDown` helper in `[[apps/frontend/src/utils/a11y.ts]]` remains for in-page selection surfaces on Owes and Watchlist. Cross-page entity navigation uses real links. VirtualDataTable uses an inline handler only when a consumer intentionally supplies an in-page row activation callback.

### Props Interface

```typescript
interface VirtualDataTableProps<T> {
  title?: string;
  subtitle?: string;
  columns: Column<T>[];
  data: T[];
  emptyMessage?: React.ReactNode;
  actions?: React.ReactNode;
  onRowUpdate?: (index: number, updatedRow: T) => void;
  onRowDoubleClick?: (row: T, index: number) => void;
  serverMode?: {
    search?: { onChange: (query: string) => void; value?: string };
    sort?: {
      onChange: (key: string | null, dir: SortDirection) => void;
      key?: string | null;
      dir?: SortDirection;
    };
    pagination?: {
      totalItems?: number;
      isFetchingMore?: boolean;
      onLoadMore?: () => void;
      hasMore?: boolean;
    };
  };
  maxHeight?: number; // Default: 600
  rowHeight?: number; // Default: 44
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
  wrap?: "truncate" | "anywhere"; // Default: truncate
  cellTitle?: (row: T) => string | undefined;
  minWidth?: number;
  defaultWidth?: number;
  sortable?: boolean; // Default: true
  filterable?: boolean; // Default: true
}
```

Body cells keep the fixed virtual row height honest by truncating prose to one line. Default-rendered
primitive values expose their full text through `title`; custom renderers own their own disclosure or
may provide `cellTitle`. Use `wrap: "anywhere"` only for raw identifiers that genuinely need emergency
breaking, not recipient, category, or investment names.

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
  columns={columns}
  data={recipients}
  actions={recipientActions}
  serverMode={{
    search: { onChange: setSearchQuery, value: searchQuery },
    sort: { onChange: handleSort, key: sortKey, dir: sortDir },
    pagination: { totalItems: total, onLoadMore: loadMore, hasMore },
  }}
/>
```

## Shared date utilities

**Path:** `[[apps/frontend/src/lib/dateUtils.ts]]`

These are pure library helpers used by shared components and pages; they no
longer live in the component tree. Date-only strings (YYYY-MM-DD) parse as
**local midnight**, not UTC midnight, to avoid off-by-one-day display issues
for users east of UTC.

| Function                                                            | Purpose                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CHART_DATE_PATTERNS`                                               | Canonical chart roles: day tick, month tick, detailed tooltip, month label, and year tick                             |
| `formatDate(date, pattern, locale?)`                                | Generic date formatter supporting patterns like `"yyyy-MM-dd"`, `"dd/MM/yyyy"`, `"MMM yyyy"`, etc.                    |
| `formatDateWithAppSettings(date, dateFormat)`                       | Formats a Date using one of the five supported app date formats; unknown values recover to the default numeric format |
| `formatDateTimeStringWithAppSettings(dateStr, dateFormat, locale?)` | Formats an ISO datetime string with app date format + time                                                            |
| `parseLocalDateFromYmd(ymd)`                                        | Parses YYYY-MM-DD to a **local** Date object (not UTC) — critical for avoiding calendar display errors                |
| `parseISO(dateString)`                                              | Parses ISO date strings; date-only strings (YYYY-MM-DD) become local midnight                                         |
| `toYmd(date)`                                                       | Formats Date as YYYY-MM-DD (inverse of `parseLocalDateFromYmd`)                                                       |
| `differenceInDays(dateLeft, dateRight)`                             | Computes days between two dates                                                                                       |
| `formatDistanceToNow(date, options?)`                               | Returns relative time string (e.g., "2 hours ago") using `Intl.RelativeTimeFormat`                                    |
| `appDateFormatToDateFnsPattern(appFormat)`                          | Converts app date format settings (e.g., "DD/MM/YYYY") to pattern strings                                             |
| `parseAppDateInput(input, appDateFormat)`                           | Strictly parses typed input in any supported app format, rejects rollover/mismatch, and returns local midnight        |
| `formatMonthYearWithAppSettings(date, appDateFormat, locale?)`      | Formats date as month/year respecting app format                                                                      |
| `formatMonthLabelWithLocale(date, locale?, width?)`                 | Formats month name with locale (short/long)                                                                           |
| `formatDateStringWithAppSettings(dateStr?, appDateFormat)`          | Safely parses and formats ISO date strings                                                                            |
| `formatDateTimeWithAppSettings(date, appDateFormat, locale?)`       | Formats Date as "YYYY-MM-DD HH:mm" with app format                                                                    |
| `weekStartsOnFromSetting(startOfWeek?)`                             | Returns 0 (Sunday) or 1 (Monday) for calendar week-start config                                                       |

### UTC-Safe Date Handling (2026-05-05)

**Problem:** Parsing date-only strings (YYYY-MM-DD) with `new Date()` creates UTC midnight, which appears as previous day for users in UTC+ timezones.

**Solution:** `parseISO()` and `parseLocalDateFromYmd()` detect date-only strings and create **local** midnight instead:

```typescript
// WRONG (UTC midnight)
new Date("2026-05-05"); // → 2026-05-04 for user in UTC+2

// CORRECT (local midnight via constructor)
const [y, m, d] = "2026-05-05".split("-").map(Number);
new Date(y, m - 1, d); // → 2026-05-05 local midnight for all timezones
```

**Impact:** Recharts Date x-axis, transaction date displays, and all calendar pickers now show correct dates regardless of user timezone.

## DatePicker

**Path:** `[[apps/frontend/src/components/shared/DatePicker.tsx]]`

The shared date control supports both pointer and keyboard-heavy workflows:

- The trigger retains its `id` and field-error ARIA contract for associated form labels.
- The popover includes a labelled text input using the configured app date format. Enter or blur accepts only an exact, valid format match and never submits an enclosing form.
- Month and year dropdowns cover 100 years of history and 20 future years, expanding further when an existing selected value lies outside that range.
- Calendar selection and the optional Clear action synchronize the typed draft and clear any format error.
- Month and weekday names follow the app language; the first weekday follows the app setting.
- `portalContainer` keeps the popover inside a dialog's focus-trap ownership when needed.

## Shared text primitives

`components/ui/label.tsx` and `components/ui/alert.tsx` use `leading-tight` for wrap-capable labels and alert titles. This keeps multi-line Dutch copy legible at enlarged browser zoom while preserving the compact text role.

## ColumnFilter

**Path:** `[[apps/frontend/src/components/shared/ColumnFilter.tsx]]`

Reusable column-filter popover component extracted from previous inline/duplicated implementations.

Responsibilities:

- Renders selectable unique values for a column.
- Applies/clears column filter state consistently across table variants.
- Centralizes filter UI behavior used by `VirtualDataTable`.

## ErrorBoundary

**Path:** `[[apps/frontend/src/components/shared/ErrorBoundary.tsx]]`

React Error Boundary component that catches rendering errors and displays a fallback UI instead of crashing the entire app.

## CategoryCombobox

**Path:** `[[apps/frontend/src/components/shared/CategoryCombobox.tsx]]`

Single-select combobox for selecting a category with `GENERAL: DETAIL` format display. It requests the backend's unpaginated active-category list and filters it in the Command palette, so categories beyond an arbitrary first page remain selectable. Used in transaction forms, filters, and settings.

### Props

```typescript
interface CategoryComboboxProps {
  id?: string;
  "aria-label"?: string;
  value?: number | null;
  onSelect: (categoryId: number | null, categoryName: string | null) => void;
  disabled?: boolean;
  className?: string;
  portalContainer?: HTMLElement | null;
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
- **Substring matching** — Backend performs case-insensitive name/alias matching
- **Display** — Shows recipient name or "(none)" fallback
- **Stable selected label** — Fetches the selected recipient by id, so filtering, first-page limits, and a closed popover cannot replace a valid selection with the placeholder; closing also clears the previous search query

### Props

```typescript
interface RecipientComboboxProps {
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  value?: number | null;
  onSelect: (recipientId: number | null, recipientName: string | null) => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  portalContainer?: HTMLElement | null;
}
```

The standard and deferred variants forward field-error ARIA attributes to the actual trigger button. This lets dialog validation associate a `FieldError` with the combobox and focus the trigger by id after a blocked submit. `active` defaults to the existing include-inactive behavior; creation forms can opt into active-only search.

### Implementation Detail (Phase C)

The `SEARCH_DEBOUNCE_MS` (300ms) constant debounce prevents API overload on rapid typing:

```typescript
import { useDebounce, SEARCH_DEBOUNCE_MS } from '@/hooks/useDebounce';

// Before (bad): Every keystroke triggers API call
onSearchChange={(query) => {
  refetch({ filter: query });  // ❌ per-keystroke
}}

// After (good): shared SEARCH_DEBOUNCE_MS constant (300ms)
const debouncedSearch = useDebounce(searchQuery, SEARCH_DEBOUNCE_MS);
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

| Surface                        | Pattern                                    | Notes                                                                  |
| ------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `CategoriesPage` detail names  | `TextLink` with a transactions href        | Opens the category-filtered transaction list with native link behavior |
| `OwesPage` debtor cards        | `role="button"` + `tabIndex` + `onKeyDown` | Selects recipient on Enter/Space                                       |
| `WatchlistPage` holding names  | `TextLink` plus explicit chart button      | Name opens market lookup; button opens the in-page chart dialog        |
| `StocksPage` holding names     | `TextLink`                                 | Opens market lookup with native link behavior                          |
| `CryptoPage` holding names     | `TextLink`                                 | Opens market lookup with native link behavior                          |
| `InvestmentDetailDialog` title | `TextLink`                                 | Opens market lookup with native link behavior                          |

> [!tip] Pair `role="button"` + `tabIndex={0}` + `onActivateKeyDown` only on elements that cannot be refactored to a real `<button>`. When the element is already a native button, omit `role` and `tabIndex` — just add `onKeyDown`.

## RemoteNewsImage

**Path:** `[[apps/frontend/src/components/shared/RemoteNewsImage.tsx]]`

Image component for loading remote news thumbnails with fallback handling. Used in the portfolio news feed.

## SymbolSearchBox

**Path:** `[[apps/frontend/src/components/shared/SymbolSearchBox.tsx]]`

Canonical ticker/company search box chrome shared across every symbol picker in the Research section. Introduced in a June 2026 UI-consistency pass that brought `MarketLookupPage`, `ResearchComparePage`, and `ChartBuilderPage` in line with `ResearchHomePage`'s reference look.

**Responsibility split:** `SymbolSearchBox` owns the visual chrome and interaction semantics: the input/listbox ARIA relationship, active-option state, and keyboard navigation. Each page retains its own query logic and passes result rows as `children`. Rows inside the dropdown should use `SymbolSearchResultItem`; that row gains `role="option"` only when rendered inside a `SymbolSearchBox`, so its inline use in `AddToWatchlistDialog` remains a normal button.

### Props

```typescript
interface SymbolSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Whether the results dropdown should be shown. */
  open: boolean;
  /** Dismisses the caller-controlled dropdown without selecting a result. */
  onDismiss: () => void;
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
- Dropdown: `Card` with `glass-thick border border-border shadow-lg z-50`, opening `top-full mt-2`; `CardContent` has `p-1` padding.

### Keyboard and assistive-technology contract

- The input exposes `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`, and `aria-activedescendant`.
- The dropdown content is the controlled `role="listbox"`; `SymbolSearchResultItem` rows inside it are stable-id `role="option"` elements.
- Arrow Up/Down wraps through results and gives the active row a visible highlight; Enter activates it while focus stays on the input. Escape calls the required dismissal handler. Typing clears the active option, while Home/End retain their native text-caret behavior. Popup options are removed from the Tab sequence, so Tab leaves the combobox for the next control.

### Pages using SymbolSearchBox

| Page                  | Notes                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `ResearchHomePage`    | No `loading` prop; autoFocus; was the reference implementation                              |
| `MarketLookupPage`    | `loading` prop passed (shows spinner during fetch)                                          |
| `ResearchComparePage` | `loading` prop passed; result rows use `leadingIcon={<Plus />}` on `SymbolSearchResultItem` |
| `ChartBuilderPage`    | `loading` prop passed; result rows use `leadingIcon={<Plus />}` on `SymbolSearchResultItem` |

> [!info] `AddToWatchlistDialog` was deliberately **not** migrated to `SymbolSearchBox`. It renders results as an inline scrollable list inside a modal (with a `Label`), which is a different UX context from the floating-dropdown pattern.

## SymbolSearchResultItem

**Path:** `[[apps/frontend/src/components/shared/SymbolSearchResultItem.tsx]]`

Canonical company/ticker search-result row, shared across every symbol picker (Research home, Market Lookup, Compare, Chart Builder, Add-to-Watchlist). Ensures consistent row layout: monospaced ticker, company name, asset-type badge, and exchange label.

### Props

```typescript
interface SymbolSearchResultItemProps {
  item: SymbolSearchResult; // { symbol, name, type, exchange }
  onSelect?: (item: SymbolSearchResult) => void;
  to?: string; // navigation-mode results render a real router link
  /** Optional leading affordance for add-to-list pickers (e.g. a Plus icon). */
  leadingIcon?: ReactNode;
  className?: string;
}
```

The exported `SymbolSearchResult` interface (`{ symbol, name, type, exchange }`) is the shared shape across both `searchResearch` and `searchMarket` API responses.

- **Navigate-style pickers** (Research home, Market Lookup): pass `to`; the option is an href-backed link and still participates in the combobox active-option/Enter behavior.
- **Add-style pickers** (Compare, Chart Builder): pass `leadingIcon={<Plus className="..." />}`.
- `AddToWatchlistDialog` also uses this component for its inline scrollable results list.

## Money

**Path:** `[[apps/frontend/src/components/shared/Money.tsx]]`

`Money` is the canonical inline monetary-value renderer. It uses `Intl.NumberFormat.formatToParts` with the app locale and decimal preference, then applies the shared raised-currency and de-emphasized-fraction typography. Pass the raw signed value with `signed` when a delta needs an explicit plus sign; do not wrap `Math.abs()` or prepend a manual sign. Pass the source currency for native-price columns and the display currency after conversion. Rebalance planning deliberately passes `fractionDigits={0}`.

Direct page values on account balances and ledgers, portfolio holdings and detail cards, net-worth breakdown rows, and portfolio-tax breakdowns use `Money`. Text interpolated into a translated sentence, chart tick/tooltip callbacks, and numeric input hints continue to use string formatters because those APIs require strings.

## TouchDisclosure and CompactValueDisclosure

**Path:** `[[apps/frontend/src/components/shared/TouchDisclosure.tsx]]`

Use `TouchDisclosure` when essential information would otherwise exist only in a native `title` or hover tooltip. Its Popover trigger is a real button that works with touch, mouse, and keyboard, exposes the disclosure text as an accessible name, and expands to the shared 40 px target on coarse pointers. Keep it as a sibling of links and other controls; do not nest it inside an anchor or button.

`CompactValueDisclosure` is the financial-value specialization. Pass the displayed compact value and the full formatted value only when compaction occurred. Without `fullValue` it renders passive text; with it, the exact amount is available through the disclosure and assistive technology. `StatCard`, dashboard balances, and statistics headline and total cells use this component.

## TrendHue

**Path:** `[[apps/frontend/src/components/shared/TrendHue.tsx]]`

Single shared overlay component that renders the faint diagonal gain/loss/neutral card tint on summary and stat cards. Introduced in the 2026-06-24 gain/loss colour-consistency pass to eliminate divergent per-page inline gradient divs.

`TrendHue` is the single source of truth for the "trend hue" wash pattern: a `bg-gradient-to-br from-{gain|loss|primary}/10 to-.../5` tint rendered as an `absolute inset-0 pointer-events-none rounded-[inherit]` overlay child. Placing the tint in a child (not on the card background) is required so it survives the `backdrop-filter` cascade — see [[docs/reference/code-patterns#gradient-icon-tile-pattern-phase-9--june-2026|Gradient Icon Tile Pattern]].

### Props

```typescript
interface TrendHueProps {
  /** "gain" tints the card with the --gain token; "loss" with --loss; "neutral" uses --primary. */
  tone: "gain" | "loss" | "neutral";
}
```

### Visual spec

| `tone`    | Gradient classes               |
| --------- | ------------------------------ |
| `gain`    | `from-gain/10 to-gain/5`       |
| `loss`    | `from-loss/10 to-loss/5`       |
| `neutral` | `from-primary/10 to-primary/5` |

The colours are toggle-reactive: they resolve from `--gain` and `--loss` tokens (classic gold/red by default; Okabe-Ito green/orange when `colorblindGainLoss` is on — see [[docs/features/appearance#gain--loss-colors--accessibility-setting-2026-06-24|Appearance — Gain & Loss Colors]]).

### Consumers

| Component                                                               | `tone` logic                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `StatCard` (dashboard)                                                  | Derived from the existing `trend` prop: `"income"/"up"` → `gain`; `"expense"/"down"` → `loss`; `"neutral"` → `neutral` |
| `TotalValueCard` (portfolio overview)                                   | `isGain` prop: `true` → `gain`, `false` → `loss`                                                                       |
| `PortfolioOverviewPage` summary cards (gain/loss, realized, unrealized) | Sign of the card's value                                                                                               |
| `PerformancePage` total-value card                                      | Sign of the return value                                                                                               |
| `NetSummaryCard`                                                        | Sign of last month's net result                                                                                        |
| `MonthlyRhythm`                                                         | Sign of the selected month's net result                                                                                |
| `NextSevenDaysStrip`                                                    | Sign of the seven-day net total                                                                                        |

### Colour-role convention (2026-06-24)

The following rule applies across all summary/stat cards:

| Surface                                                           | Colour rule                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Card background tint                                              | `<TrendHue tone={…} />` — gain/loss/neutral at opacity 0.10; neutral border always |
| Featured total headline (net worth, portfolio total, total value) | `text-primary`                                                                     |
| Directional figures (return %, gain/loss amount)                  | `text-gain` / `text-loss`                                                          |
| Component figures (cost basis, unrealized, realized)              | `text-foreground` (neutral)                                                        |

> [!info] The gain/loss BORDER that previously appeared on `PerformancePage` CompactReturnCard and TotalValueCard (via `liquid-glass-trend-up/down` CSS classes) was removed in this pass. The hue is retained via `<TrendHue>`; the border is gone for cross-app consistency. The `glass-trend-up / glass-trend-down / liquid-glass-trend-up / liquid-glass-trend-down` classes have been deleted from `index.css` as they are now orphaned.

Code links: [[apps/frontend/src/components/shared/TrendHue.tsx]], [[apps/frontend/src/components/shared/StatCard.tsx]], [[apps/frontend/src/features/portfolio/TotalValueCard.tsx]], [[apps/frontend/src/features/dashboard/NetSummaryCard.tsx]], [[apps/frontend/src/features/statistics/MonthlyRhythm.tsx]], [[apps/frontend/src/features/planned/NextSevenDaysStrip.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]]

---

## CardSheen

**Path:** `[[apps/frontend/src/components/shared/CardSheen.tsx]]` (paint lives in `.card-sheen`, `.card-sheen-feature`, and `.card-sheen-hero` in `apps/frontend/src/index.css`)

Single shared overlay for the decorative corner orb — the soft round highlight bleeding out of a card's top-right corner. Introduced 2026-07-11 to replace ten copy-pasted gradient divs in three drifting dialects (some hard-coding raw `white`); the last hand-rolled instance (`NetSummaryCard`) was folded in 2026-08-14 by adding the `hero` tier below.

Rendered as an `aria-hidden`, `pointer-events: none` absolutely-positioned child of the card. All tiers read theme tokens, never raw white, so they follow light/dark and every theme variant.

### Props

```typescript
interface CardSheenProps {
  /** Which sheen tier — see the tier policy below. Defaults to "default". */
  tier?: "default" | "feature" | "hero";
  /** Subtle grow-on-hover, matching the KPI-tile treatment (needs a `group` parent). */
  animated?: boolean;
  className?: string;
}
```

`tier` is a `cva` variant, matching the `variant` idiom on [[docs/components/ui-components|Card]] — the tier names a place in the elevation hierarchy rather than exposing size/colour knobs at the call site.

### Tier policy (2026-08-27)

Three named tiers, deliberately — not call-site drift. Low-emphasis content cards get none; KPI tiles, chart cards, and high-information panels such as `VirtualDataTable` use the default tier (ADR-105 reserves the motif for prominent card tiers).

| `tier`    | Class                 | Size / offset  | Token                                    | Reads as                                                                                                                                                 |
| --------- | --------------------- | -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` | `.card-sheen`         | 8rem, `-4rem`  | `--glass-highlight` @ 0.5 (0.12 in dark) | Light sheen in both modes. The KPI/widget tier: stat tiles, chart cards, panel headers.                                                                  |
| `feature` | `.card-sheen-feature` | 10rem, `-5rem` | `--glass-highlight` @ 0.5 (0.12 in dark) | The same light sheen for a prominent in-page feature card. Currently the shared portfolio-value hero.                                                    |
| `hero`    | `.card-sheen-hero`    | 12rem, `-6rem` | `--background` @ 0.4                     | Tone **inverts** by mode — pale wash in light, dark vignette in dark, sinking the corner behind the hero figure. Reserved for a page's single hero tile. |

`--background` flips with the mode by itself, so `.card-sheen-hero` needs no `.dark` companion; it is a standalone class rather than a modifier on `.card-sheen` so the `.dark .card-sheen` rule can never leak into it.

### Consumers

| Component                                                                                                        | Tier                                           |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `NetSummaryCard` (dashboard hero tile)                                                                           | `hero`, `animated` — the only `hero` call site |
| `StatCard`, `MonthlyRhythm`, `NextSevenDaysStrip`                                                                | `default`, `animated`                          |
| `MonthlyTrendsChart`, `CashFlowForecastChart`, `CategoryPieChart` (×2), `BankBalancesWidget`, `VirtualDataTable` | `default`                                      |
| `TotalValueCard` (Portfolio Overview and Performance)                                                            | `feature`                                      |

---

## Notification Components

### UpdateNotification

**Path:** `[[apps/frontend/src/components/notifications/UpdateNotification.tsx]]`

Displays app update notifications in the Electron desktop app. Checks for new versions via the `electronUpdater` API.

### UpcomingPaymentsNotification

**Path:** `[[apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx]]`

Shows notifications for upcoming planned/recurring payments.

#### V11 Refactor (June 2026)

`UpcomingPaymentsNotification` was refactored onto the shared `useUpcomingPlannedPayments` hook:

- Data fetch and dismissed-ID state moved to `hooks/useUpcomingPlannedPayments.ts`.
- **Desktop badge**: Set to the non-dismissed upcoming count and cleared on unmount; Electron maps it to macOS, Linux, and Windows shell conventions.
- Dismissal store is module-level, backed by `useSyncExternalStore`.

#### 2026-06-24: Unified banner, SuggestionCard removed

The former `SuggestionCard` dashboard widget has been deleted. `UpcomingPaymentsNotification` remains mounted by `AppLayout` so its native badge effect runs on every route, but the visible reminder is dashboard-only and does not consume space on every working page. The `suggestions` widget entry was also removed from `DASHBOARD_WIDGETS` in `DashboardPage`.

### Accessibility (Phase C)

- **aria-label** attributes added to dismiss and dismiss-all buttons for screen reader accessibility (Phase C fix)
- Dismiss button label: `aria-label={t('upcoming.dismissAll')}` for "Dismiss all" action
- Individual item dismiss uses consistent accessibility labeling pattern

## Usage Across Pages

| Component                | Used In                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| VirtualDataTable         | Transactions, Recipients, Owes, Net Worth, Portfolio Tax                                        |
| ColumnFilter             | VirtualDataTable column filtering                                                               |
| dateUtils                | Every page (date formatting)                                                                    |
| CategoryCombobox         | Transaction forms, filters, category assignment                                                 |
| CategoryMultiCombobox    | Export filters (Phase 13)                                                                       |
| BankAccountMultiCombobox | Export filters (Phase 13)                                                                       |
| RecipientCombobox        | Transaction forms, filters                                                                      |
| ExclusionToggle          | Statistics page (per-graph toggles)                                                             |
| WidgetVisibilityDialog   | Statistics, Portfolio Tax                                                                       |
| ErrorBoundary            | App root (wraps entire application)                                                             |
| onActivateKeyDown        | OwesPage and WatchlistPage in-page selection surfaces                                           |
| SymbolSearchBox          | ResearchHomePage, MarketLookupPage, ResearchComparePage, ChartBuilderPage                       |
| SymbolSearchResultItem   | ResearchHomePage, MarketLookupPage, ResearchComparePage, ChartBuilderPage, AddToWatchlistDialog |

## TextLink and href-backed drill-downs

**Path:** `[[apps/frontend/src/components/shared/TextLink.tsx]]`

`TextLink` is the canonical inline router link for entity names and numeric drill-downs. It supplies the shared underline decoration and `ring-ring/70` focus treatment. Use the primary tone for names, the inherited tone when the surrounding cell owns gain/loss colour, and the muted tone for secondary labels.

Ordinary cross-page navigation must expose a real `href`. Recipient/category/account names, Owes transaction names, holding and watchlist names, database-table names, research results/tiles, and statistics pivot cells use links. Programmatic navigation remains appropriate for post-mutation redirects, startup normalization, command execution, and in-page selection state.
| TrendHue | StatCard, TotalValueCard, NetSummaryCard, MonthlyRhythm, NextSevenDaysStrip, PortfolioOverviewPage summary cards, PerformancePage cards, NetWorthPage StatCard |

### StateBlock

`StateBlock` owns the shared icon tile, halo, display title, description, details,
and action anatomy for empty and failure states. `EmptyState` is its neutral wrapper;
`PageError` and the crash fallback use the destructive tone. Use `size="compact"`
for constrained chart, table, and card slots; page-level first-run states may use
the default size when `StateBlock` owns the full slot padding.

`VirtualDataTable` renders string/default zero states through compact `EmptyState`.
Primary tables pass an identity icon with `emptyIcon`; filtered-zero states use a
search-specific icon and message. Callers may still provide a complete React node
when they need a contextual action.
