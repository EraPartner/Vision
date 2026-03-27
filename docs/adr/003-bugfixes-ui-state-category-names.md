---
title: ADR-003: Bug Fixes - UI State Consistency, Category Names, Dashboard Charts, Date Picker, Splits/Owes Workflows, and Edit Mode Stability
type: adr
status: Accepted
date: 2026-03-23
tags: [bug-fix, frontend, backend, ui, statistics, recipients, dashboard, planned-payments, splits, settings, database, schema, react-query]
description: Fixed UI/data consistency issues across virtual tables, statistics, planned-payment date handling, split settlement/export flows, settings defaults, and transaction filtering
related_code: 
  - "apps/frontend/src/pages/RecipientsPage.tsx"
  - "apps/frontend/src/components/shared/VirtualDataTable.tsx"
  - "apps/frontend/src/hooks/useStatistics.ts"
  - "apps/frontend/src/pages/StatisticsPage.tsx"
  - "apps/frontend/src/pages/DashboardPage.tsx"
  - "apps/frontend/src/pages/PlannedPaymentsPage.tsx"
  - "apps/frontend/src/pages/portfolio/WatchlistPage.tsx"
  - "apps/frontend/src/pages/TransactionsPage.tsx"
  - "apps/frontend/src/pages/OwesPage.tsx"
  - "apps/frontend/src/components/planned/PlannedPaymentForm.tsx"
  - "apps/frontend/src/components/shared/DatePicker.tsx"
  - "apps/frontend/src/components/shared/dateUtils.ts"
  - "alembic/versions/0013_investment_inheritance.py"
  - "apps/frontend/src/hooks/useTransactions.ts"
  - "apps/frontend/src/hooks/useSplits.ts"
  - "apps/node-backend/src/routes/splits.js"
  - "apps/node-backend/src/repositories/splitRepository.js"
  - "apps/node-backend/src/routes/transactions.js"
  - "apps/node-backend/src/repositories/transactionRepository.js"
  - "apps/node-backend/src/routes/settings.js"
  - "apps/node-backend/tests/routes/splits.test.js"
---

# ADR-003: Bug Fixes - UI State Consistency, Category Names, Dashboard Charts, Date Picker, Splits/Owes Workflows, and Edit Mode Stability

## Status

Accepted - 2026-03-23

## Context

Multiple bugs were identified in the Vision application:

### Bug 1: RecipientsPage Uncategorized View Inconsistency

When a user was viewing recipients with the `showUncategorized` filter enabled and assigned a category to an uncategorized recipient:

1. The category assignment triggered the `useUpdateRecipient` mutation
2. `onSuccess` invalidates all recipient queries
3. React Query refetches the list, but the recipient no longer matches `uncategorized: true`
4. The list re-renders without that recipient
5. However, `editingRow` state in `VirtualDataTable` remained set
6. This caused UI inconsistency with a stale edit row

### Bug 2: Statistics Category Name Display Issues

The statistics page had two issues with category names:

1. **Name mismatch**: The frontend formats categories as `GENERAL: DETAIL` (with space after colon), but could fall back to `tx.category_name` from transactions which might have different formatting (e.g., `GENERAL:DETAIL` without space)

2. **Duplicates**: When the same category appeared with inconsistent formatting, it created duplicate entries in the category pivot

### Bug 3: Dashboard Chart Disappearing When Toggling Filters

When toggling filters on the cash flow chart or 6-month trends chart in the dashboard:

1. User toggles the exclusion filter OFF for a specific graph
2. The chart data getter tries to return unfiltered data
3. However, the unfiltered query was disabled (`enabled: !exclusionsApply`)
4. Unfiltered data was `undefined`, causing the chart to render with empty data
5. The chart disappeared due to conditional rendering (`monthlyData.length > 0`)

### Bug 4: White Box Over Date Picker in Link Transaction Dialog

When linking a transaction to a planned payment:

1. The Link Transaction Dialog uses a native HTML `<input type="date">` element
2. Native date pickers render their dropdown calendars outside the normal CSS stacking context
3. This caused the date picker dropdown to appear behind the dialog overlay (white box)
4. The calendar was not visible/accessible to users

### Bug 5: Redundant Price Display in Watchlist

The watchlist was showing both the current price AND the percentage above/below target, which was redundant:

1. Current code showed: `9.21` (price) and `9% above target` (percentage)
2. User wanted to see EITHER the price OR the percentage, not both

## Decision

### Fix 4: Replace Native Date Input with Popover + Calendar

**Solution**: Replaced the native `<input type="date">` with a Radix UI Popover containing a Calendar component:

```tsx
<Popover>
  <PopoverTrigger asChild>
    <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !executionDate && "text-muted-foreground")}>
      <CalendarIcon className="mr-2 h-4 w-4" />
      {executionDate ? format(new Date(executionDate), "PPP") : t('plannedPage.link.pickDate')}
    </Button>
  </PopoverTrigger>
  <PopoverContent className="w-auto p-0" align="start">
    <Calendar
      mode="single"
      selected={executionDate ? new Date(executionDate) : undefined}
      onSelect={(date) => setExecutionDate(date ? format(date, "yyyy-MM-dd") : "")}
      initialFocus
      className="pointer-events-auto"
    />
  </PopoverContent>
</Popover>
```

The Radix UI Popover + Calendar combination properly respects the stacking context and renders above the dialog overlay.

**Files Changed**:
- `PlannedPaymentsPage.tsx`: Replaced native date input with Popover + Calendar
- `en.ts`: Added `plannedPage.link.pickDate` translation
- `nl.ts`: Added `plannedPage.link.pickDate` translation

### Fix 5: Watchlist Price Display

**Solution**: Simplified watchlist to show EITHER price OR percentage, not both:

- When price is ABOVE target: Show only the percentage with trend icon (e.g., "9% above target ↑")
- When price is AT or BELOW target: Show the current price (no need to show percentage since it's at/good)

**Files Changed**:
- `WatchlistPage.tsx`: Conditional rendering based on `priceDiff > 0`

### Fix 6: Investment Table Inheritance

**Context**: The original `investments` table had nullable columns like `municipality`, `cadastral_income`, `municipality_tax_rate` that were only relevant for real estate investments. This created:
- Unnecessary NULL columns for non-real-estate investments
- No clear separation of investment types
- Harder to enforce type-specific constraints

**Solution**: Implemented PostgreSQL table inheritance with separate tables per investment type:

```
investments_base (parent - common fields)
├── stock_investments (symbol, current_price)
├── etf_investments (symbol, current_price)
├── crypto_investments (symbol, current_price)
├── real_estate_investments (current_price, location, municipality, cadastral_income, municipality_tax_rate)
├── savings_investments (current_price, interest_rate)
└── bond_investments (current_price, interest_rate, maturity_date)
```

Similarly for transactions:
```
portfolio_transactions_base (parent - common fields)
├── stock_transactions (units, price_per_unit)
├── etf_transactions (units, price_per_unit)
├── crypto_transactions (units, price_per_unit)
├── real_estate_transactions (no extra columns)
├── savings_transactions (no extra columns)
└── bond_transactions (no extra columns)
```

**Backward Compatibility**: Created legacy views (`investments`, `portfolio_transactions`) that aggregate all data, allowing existing queries to continue working.

**Files Changed**:
- `alembic/versions/0013_investment_inheritance.py`: New migration creating inheritance structure
- Old tables renamed to `investments_legacy` and `portfolio_transactions_legacy`

### Fix 7: Transaction List Not Updating

**Context**: When adding or deleting transactions, the table in TransactionsPage didn't refresh automatically.

**Root Cause**: Query key mismatch between where transactions are fetched and where they are invalidated:
- `TransactionsPage` uses: `['transactions-virtual', params]`
- `useTransactions` invalidates: `['transactions']`

**Solution**: Added `['transactions-virtual']` to the invalidation in all transaction mutations:
```typescript
// In useCreateTransaction, useUpdateTransaction, useDeleteTransaction:
queryClient.invalidateQueries({queryKey: ['transactions']});
queryClient.invalidateQueries({queryKey: ['transactions-virtual']}); // Added
queryClient.invalidateQueries({queryKey: ['monthlySummary']});
```

**Files Changed**:
- `useTransactions.ts`: Added `transactions-virtual` invalidation to all three mutations

### Fix 9: Prevent Auto-Refresh During Edit Mode

**Context**: When editing a transaction (changing category, recipient, etc.), the table would auto-refresh and lose the edit state or cause inconsistent UI behavior.

**Solution**: Added `onEditingChange` callback prop to VirtualDataTable and used it to track editing state in TransactionsPage. The query reset effect now checks `isEditingRef.current` and skips the reset when editing:

```typescript
// VirtualDataTable - notify parent of editing state changes
useEffect(() => {
    onEditingChange?.(editingRow !== null);
}, [editingRow, onEditingChange]);

// TransactionsPage - skip reset during editing
useEffect(() => {
    if (initialData && !isEditingRef.current) {
        setAllItems(initialData.items);
        // ...
    }
}, [initialData]);
```

**Files Changed**:
- `VirtualDataTable.tsx`: Added `onEditingChange` prop and effect
- `TransactionsPage.tsx`: Added `isEditingRef` and `setEditing` callback

### Fix 8: Virtual Table Search Sync and Progressive Updates

**Context**: Search in server-backed virtual tables needed to stay predictable while typing and after search execution:

1. The input should keep the exact typed value after the debounced request executes.
2. Search should update progressively for every keystroke, including when the user loosens the query by deleting characters.
3. Clearing should work correctly for both single-character backspacing and full clear actions, without stale delayed requests re-applying old terms.

**Solution**: Kept immediate local input state, tuned debounced server calls to `200ms` for a more live feel, added explicit typing/sync guards, and deferred heavy row rendering with `useDeferredValue`:

```typescript
// Debounced server search - input updates immediately, API call is debounced
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const isTypingRef = useRef(false);

const handleSearchInput = useCallback((value: string) => {
    setLocalSearchQuery(value);
    if (isServerSearch) {
        isTypingRef.current = true;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            onSearchChange!(value);
            debounceRef.current = null;
            isTypingRef.current = false;
        }, 200);
    }
}, [isServerSearch, onSearchChange]);

// Keep local search in sync with external searchValue changes
useEffect(() => {
    const externalQuery = searchValue ?? "";
    if (!isTypingRef.current && externalQuery !== localSearchQuery) {
        setLocalSearchQuery(externalQuery);
    }
}, [isServerSearch, searchValue, localSearchQuery]);

const clearSearch = useCallback(() => {
    clearPendingSearch();
    setLocalSearchQuery("");
    if (isServerSearch) onSearchChange!("");
}, [clearPendingSearch, isServerSearch, onSearchChange]);
```

```typescript
const deferredData = useDeferredValue(data);

const processedData = useMemo(() => {
    let result = [...deferredData];
    // ... existing filter/sort pipeline
    return result;
}, [deferredData, columnFilters, localSearchQuery, isServerSearch, isServerSort, sortKey, sortDir, columns]);
```

**Files Changed**:
- `VirtualDataTable.tsx`: Added typing guard + external sync logic, uses 200ms debounce, deferred data rendering, and immediate clear behavior
- `TransactionsPage.tsx`: Uses controlled `search` state via `onSearchChange`/`searchValue` with virtual server search
- `RecipientsPage.tsx`: Uses the same controlled search flow for recipient list filtering

### Fix 3: Dashboard Chart Filter Toggle

**Solution**: Always enable both filtered and unfiltered queries:

The unfiltered queries for `monthlySummary` and `cashflowComparison` were being disabled when `exclusionsApply` was true. This prevented users from toggling a specific graph to show unfiltered data.

Changed from:
```typescript
enabled: !exclusionsApply,
```

To:
```typescript
enabled: true,
```

This ensures unfiltered data is always available as a fallback when users toggle individual graphs.

**Files Changed**:
- `DashboardPage.tsx`: Changed `enabled` prop for `monthlySummaryUnfiltered` and `cashflowDataUnfiltered` queries to `true`

### Fix 1: RecipientsPage UI State Consistency

**Solution**: Added a `cancelEditingRef` mechanism to VirtualDataTable:

1. Added optional `cancelEditingRef` prop to `VirtualDataTable` that exposes the internal `cancelEditing` function
2. Before triggering a category mutation, the category combobox now:
   - Cancels ongoing React Query queries to prevent premature refetch
   - Calls `cancelEditingRef.current?.()` to exit edit mode
   - Then triggers the mutation in a setTimeout to let the UI update

**Files Changed**:
- `VirtualDataTable.tsx`: Added `cancelEditingRef` prop and useEffect to set the ref
- `RecipientsPage.tsx`: Added `cancelEditingRef` usage in category selection handler

### Fix 2: Statistics Category Name Normalization

**Solution**: Centralized category name normalization:

1. Added `normalizeCategoryName()` helper function in `useStatistics.ts`:
   ```typescript
   function normalizeCategoryName(name: string): string {
     return name.replace(/^([^:]+): */, '$1: ').trim();
   }
   ```

2. Applied normalization when building the category map:
   ```typescript
   const categoryMap = new Map(categories.map(c => [c.id, normalizeCategoryName(`${c.general}: ${c.detail}`)]));
   ```

3. Removed fallback to `tx.category_name` - now always uses the category from the map with a generic fallback if not found

4. Fixed `StatisticsPage.tsx` pivot table parsing to properly handle the space after colon:
   ```typescript
   const [rawGeneral, ...detailParts] = String(cat.categoryName).split(":");
   const general = rawGeneral?.trim() || t('txPage.field.uncategorized');
   const detailName = detailParts.length > 0 ? detailParts.join(":").replace(/^ /, '') : general;
   ```

5. Fixed pie chart label parsing for consistent display

## Consequences

### 2026-03-23 Additions

- Added strict split amount validation so single and batch split creation cannot exceed transaction totals.
- Added per-recipient owed CSV export and a per-recipient settle-all operation for faster debt cleanup workflows.
- Added `transaction_id` filtering in transactions list APIs and frontend navigation deep-links from Owes details.
- Added `widget_visibility` as a defaulted settings key to stabilize widget preference reads.
- Standardized planned-payment form date handling with a shared `DatePicker` + local date utilities to avoid modal/date-input issues.
- Added dedicated split route coverage (`apps/node-backend/tests/routes/splits.test.js`) for validation and CSV export behavior.

### Positive

- **UI Consistency**: No more stale edit states when assigning categories
- **Reliable Statistics**: Category names display consistently across all charts
- **No Duplicates**: Category pivot now correctly groups categories
- **Better Maintainability**: Centralized normalization logic
- **Dashboard Filters Work**: Users can now toggle filters on individual dashboard charts without charts disappearing
- **Date Picker Accessible**: Calendar is now visible and usable in the Link Transaction Dialog
- **Better Schema Design**: Investment tables now have proper inheritance with type-specific columns
- **No NULL Waste**: Real estate-specific columns only exist in `real_estate_investments` table
- **Cleaner Watchlist**: Shows either price or percentage, not both
- **Search Behavior Is Predictable**: Input value persists after execution, updates progressively while typing, and clearing does not resurrect stale terms

### Neutral

- **New Prop**: `cancelEditingRef` is optional and backward-compatible
- **Memo Dependency**: Added `t` to `hierarchicalCategories` useMemo dependencies
- **Extra Queries**: Always fetching both filtered and unfiltered data (minor increase in network activity when exclusions are active)
- **Translation Keys**: Added `plannedPage.link.pickDate` to en.ts and nl.ts

### Negative

- None identified

## Related

- [[docs/adr/001-technology-stack|ADR-001: Technology Stack]]
- [[docs/adr/002-database-schema|ADR-002: Database Schema]]
- [[docs/features/views|Recipients View]]
- [[docs/features/views|Statistics View]]
- [[docs/features/views|Dashboard View]]
- [[docs/features/plannedTransactions|Planned Payments]]
- [[docs/features/portfolio|Portfolio]]
- [[docs/components/hooks|useStatistics Hook]]
