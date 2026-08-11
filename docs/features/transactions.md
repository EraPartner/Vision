---
title: Transactions
type: feature
status: active
date: 2026-04-16
updated: 2026-08-11
tags: [feature, transactions, finance, phase-q, recipient-groups, bulk-actions, optimistic-updates, optimistic-create, june-2026, context-menu, quick-look, keyboard-nav, duplicate, filter-by-recipient, deep-link, electron-native, new-transaction, render-loop-fix, category-ids-filter, multi-value-filter, balance-write-protection, tag-editing-fix, amount-filter, search-suggestions, date-search, tag-search, url-state]
aliases: [transactions-feature, income, expenses, financial-records, money-tracking]
description: Core transaction management - income, expenses, and tracking financial activities. Phase Q adds recipient-group filtering for linked-recipient transaction discovery. Bulk operations enable atomic multi-row delete, recategorize, reassign, activate/deactivate, export, and tag. June 2026 (ADR-070): useUpdateTransaction/useDeleteTransaction are now optimistic. June 2026 Premium v3 (ADR-071): useCreateTransaction is now optimistic (temp negative-id row → server-row swap → onSettled invalidate; virtual list excluded; 6 tests). June 2026 Premium v3 V5-V7: per-row context menu, Quick Look dialog (Space), keyboard row navigation (↑/↓/Enter), Duplicate, and Filter-by-recipient actions. June 2026 V12 (ADR-072): /transactions?new=1 deep link opens AddTransactionDialog (used by native menu and dock menu). 2026-06-25: balance field is now write-protected (import pipeline only); PATCH and manual create can no longer set it; TransactionInfoDialog renders it read-only. 2026-06-26: TransactionInfoDialog tag-editing state bug fixed — last-tag removal chip persisted on screen after PATCH succeeded; dialog now tracks tag slugs in local state seeded from infoTransaction.tags. 2026-06-28: free-text search now also matches the transaction date (ISO text) and active tag slugs; new amount_min/amount_max/amount_exact filter params; TransactionSearchSuggestions dropdown for quick filters; FilterBanner shows amount descriptors. Aug 2026: search and sort (sort_key/sort_dir) are URL-backed; load-more and attachment-delete failures surface a retry-capable toast instead of failing silently.
related_code: ["apps/node-backend/src/routes/transactions.js", "apps/node-backend/src/repositories/transactionRepository.js", "apps/node-backend/src/services/filterBuilder.js", "apps/node-backend/src/services/bulkSelection.js", "apps/frontend/src/features/transactions/", "apps/frontend/src/features/transactions/components/TransactionSearchSuggestions.tsx", "apps/frontend/src/pages/TransactionsPage.tsx"]
---

# Transactions

The core of Vision - managing financial transactions including income, expenses, and transfers.

## Overview

Transactions represent any financial movement - from grocery shopping to salary deposits. Each transaction is linked to a recipient and can be categorized for organization and analysis.

## Transaction Model

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `date` | date | Transaction date (YYYY-MM-DD) |
| `bank_account` | string | Source/destination bank account |
| `recipient_id` | number | Linked recipient |
| `amount` | number | Transaction amount |
| `memo` | string | Transaction description |
| `currency` | string | Currency code (ISO 4217) |
| `balance` | number | Running balance after transaction (**read-only** — written exclusively by the import pipeline; `NULL` on manual rows; see note below) |
| `category_id` | number | Assigned category |
| `comment` | user_note | User-added comment |

### Amount Convention

- **Negative values** = Expenses (money leaving)
- **Positive values** = Income (money entering)

```javascript
// Expense
{ amount: -45.50 }

// Income  
{ amount: 2500.00 }
```

### Balance Field — Write-Protected (2026-06-25)

> [!warning] `balance` is written exclusively by the import pipeline
> `transactions.balance` is now a **read-only** field from the perspective of the API and the UI.
> It is stamped by `services/importPipeline/commit.js` as a running balance when rows are imported
> from a bank CSV. Manually-created transactions leave `balance = NULL`, which is correct and
> intentional.
>
> **What changed:**
> - `PATCH /api/transactions/:id` rejects any body that contains `balance` (`ALLOWED_COLUMNS.transactions` no longer includes it).
> - `POST /api/transactions` (create) does not accept or forward `balance`; the repository `create()` method ignores it.
> - `TransactionInfoDialog` renders the `balance` field as a read-only display value; the edit affordance is removed (`'balance'` removed from `InfoEditableField` in `types.ts`).
>
> **Why:** The account's computed balance (used by the bank-balances widget and reconciliation) anchors on the `balance` column of the most-recent active transaction. A hand-typed value could corrupt the entire account total. See [[docs/adr/094-balance-reconciliation-drift|ADR-094 addendum]].
>
> The `include_balance=true` export flag and the running-balance accumulator in the CSV export are unaffected — they compute balance from amounts at export time.

---

## Features

### Categorization

Transactions can be assigned categories using the `GENERAL:DETAIL` format:

- `FOOD:GROCERIES` - Grocery shopping
- `FOOD:DINING` - Restaurants
- `TRANSPORT:CAR` - Car expenses
- `TRANSPORT:PUBLIC` - Public transit

Categories can be inherited from recipients if not explicitly set.

---

### Tags

Transactions can be tagged with freeform labels (e.g., `rome-2020`, `home-renovation`) to enable cross-cutting groupings that span categories. Tags are a second, orthogonal classification dimension — a single transaction can have both a category and multiple tags simultaneously.

Key capabilities:
- Create tags on first use with auto-slug normalisation
- Attach tags to individual transactions via the info dialog
- Bulk-tag multiple transactions via checkbox selection + toolbar
- Filter the transaction list by one or more tags
- Soft-delete tags; historical tags are preserved

### Tag Editing in TransactionInfoDialog — State Fix (2026-06-26)

> [!info] Bug fixed 2026-06-26
> Removing the last (or only) tag from a transaction in `TransactionInfoDialog` used to leave the chip on screen even after the `PATCH {tags:[]}` call succeeded. The dialog bound `TagInput`'s `value` directly to the frozen `infoTransaction` snapshot in `TransactionsPage` state. The `applyInfoFieldLocally` update path did not handle `tags`, so the snapshot never updated even though the backend and the transactions table (which reads from the React Query cache) were always correct.
>
> **Fix:** The dialog now maintains a local `tagSlugs` state variable, seeded by a `useEffect` keyed on `infoTransaction?.tags`. Tag removals update `tagSlugs` optimistically and are rolled back on mutation error. The transactions table continues to self-correct via the `onSettled` invalidation regardless.
>
> A regression test ("removing the only tag clears the chip and PATCHes empty tags") was added to `apps/frontend/src/features/transactions/__tests__/TransactionInfoDialog.test.tsx`.

See [[docs/features/tags#transactioninfodialog--tag-editing-state-fix-2026-06-26|Tags — TransactionInfoDialog Tag Editing Fix]] for the full root-cause analysis.

See [[docs/features/tags]] for the complete tagging feature spec.

---

### Recipient Association

Every transaction is linked to a recipient (payee/payer). Recipients can have:
- Default category preferences
- Associated bank accounts
- Notes and metadata

---

### CSV Import

Transactions can be imported from bank CSV exports. The import process includes:
1. Text normalization (cleaning descriptions)
2. Deduplication (preventing duplicates)
3. Recurring detection (identifying subscription payments)
4. Auto-categorization

See [[docs/features/import]] for details.

---

### Search & Filtering

Transactions support rich filtering:

- Date range (start/end)
- Exact transaction ID
- Category filter
- Recipient filter (direct + aliases via `recipient_id`)
- Recipient group filter (full primary group via `recipient_group_id`, Phase Q)
- Amount range (min/max) — see [Amount Filters](#amount-filters-2026-06-28) below
- Bank account
- Currency

#### Amount Filters (2026-06-28)

Optional query params control amount filtering. By default they match on magnitude (sign-agnostic — both income and expenses of a given absolute value are matched):

| Param | Description |
|-------|-------------|
| `amount_min` | Inclusive lower bound: `ABS(amount) >= amount_min` |
| `amount_max` | Inclusive upper bound: `ABS(amount) <= amount_max` |
| `amount_exact` | Shorthand for min == max (single amount match) |
| `amount_signed` | When true, `amount_min`/`amount_max` compare the SIGNED amount instead of `ABS(amount)` |

`amount_exact` takes precedence over `amount_min`/`amount_max` when all three are supplied. By default the sign convention (`income`/`expense`) is controlled separately by `transaction_type`; alternatively `amount_signed=true` makes the amount bounds themselves sign-aware. In the search-suggestion UI a bare number (`50`) matches the magnitude, while a `+50` / `-50` prefix sends `amount_signed=true` for an exact signed match.

These params are threaded through the full stack:
- `parseTransactionListQuery` in [[apps/node-backend/src/routes/transactions.js]] parses all three and forwards `amountMin`/`amountMax` to `buildTransactionWhere`.
- `buildTransactionWhere` in [[apps/node-backend/src/services/filterBuilder.js]] emits `ABS(t.amount) >= $n` / `ABS(t.amount) <= $n` clauses.
- `getAllWithCount` in [[apps/node-backend/src/repositories/transactionRepository.js]] accepts and forwards `amountMin`/`amountMax`.
- `buildExportFilters` passes them to both CSV and JSON export endpoints.
- `normalizeBulkFilter` in [[apps/node-backend/src/services/bulkSelection.js]] maps them so bulk "select all matching" stays in lockstep.
- Frontend: `useTransactionListData`, `BulkTransactionFilter`, and the export query all accept `amountMinFilter`/`amountMaxFilter`.

#### Extended Free-Text Search (2026-06-28)

The free-text `search` parameter (`ILIKE %term%`) now matches across **all** of the following columns (extended from the previous set):

| Column | Notes |
|--------|-------|
| `t.memo` | Transaction description |
| `t.comment` | User note |
| `t.bank_account` | IBAN / account identifier |
| `t.currency` | ISO 4217 code |
| `CAST(t.amount AS TEXT)` | Amount as string |
| `CAST(t.date AS TEXT)` | ISO date string (e.g., `2026-01`) — **new** |
| `r.name` / `pr.name` | Recipient / primary recipient |
| `c.general` / `c.detail` | Category general/detail |
| `rc.general` / `rc.detail` | Recipient default category |
| `pc.general` / `pc.detail` | Primary recipient category |
| Tag slugs (EXISTS subquery) | Active tags on the row — **new** |

The tag match uses `EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id AND tg.is_active AND tg.slug ILIKE $n)`, so a search for `rome` will surface rows tagged `rome-2025`.

Code links: [[apps/node-backend/src/services/filterBuilder.js]]

#### TransactionSearchSuggestions (2026-06-28)

A new `TransactionSearchSuggestions` component renders a dropdown when the transactions search bar receives focus. It offers a palette of quick filters that merge into the URL-param filter set without requiring manual param construction:

- All income / All expenses (sets `transaction_type`)
- Exact amount (sets `amount_exact`)
- Amount range (sets `amount_min` and/or `amount_max`)
- Current year / Previous year / Arbitrary year (sets `start_date` + `end_date`)
- Custom date range

Selecting a suggestion updates the URL search params and closes the dropdown. The `VirtualDataTable` exposes a `searchSuggestions` slot that `TransactionsTable` populates with this component.

`FilterBanner` now shows readable amount descriptors alongside type and date pills — e.g., `≥ 500 EUR`, `= 75.50 EUR`, or `50–200 EUR`.

Code links: [[apps/frontend/src/features/transactions/components/TransactionSearchSuggestions.tsx]], [[apps/frontend/src/features/transactions/components/FilterBanner.tsx]], [[apps/frontend/src/components/shared/VirtualDataTable.tsx]]

#### Filter by Account (deep link, 2026-06-19)

The list reads a `bank_account` URL search param (single value) and threads it through
`TransactionsPage` → `useTransactionListData` → the list/export queries (the backend already accepted
`bank_account` on `GET /api/transactions` and the export endpoints). The active filter shows in the
`FilterBanner` (using `filter_label`) and is honoured by CSV/JSON export.

This powers **double-click navigation from the accounts hub**: double-clicking an account card in
`AccountsPage` navigates to `/transactions?bank_account=<account.name>&filter_label=<display>`. The
account *name* is the filter key because the ADR-088 dual-write trigger (migration `0051`) keeps
`transactions.bank_account` equal to `accounts.name`. Strings shown via the `accounts.openTransactions`
hint (en/nl).

Implementation note:
- Backend route parsing/normalization for list filters is centralized in `parseTransactionListQuery`, preserving existing defaults and coercion behavior while reducing duplicate parsing logic ([[apps/node-backend/src/routes/transactions.js]]).
- Backend non-`uncategorised` list path now uses repository one-query pagination (`getAllWithCount`) instead of separate list and count queries, reducing DB round-trips while preserving filters/totals/response shape ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- Backend `uncategorised=true` list path now uses dedicated repository one-query pagination (`getUncategorisedWithCount`) instead of route-level dual queries, preserving uncategorised row filtering and historical total semantics while reducing route round-trips ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- PATCH name-resolution and CSV export DB-access helpers now use module-scoped imports (`dbQuery`, `normalizeForMatching`) instead of per-request dynamic imports, preserving route behavior while removing avoidable import overhead on hot paths ([[apps/node-backend/src/routes/transactions.js]]).
- PATCH recipient/category name-resolution now runs concurrently and keeps existing recipient-first/category-second validation error precedence, reducing avoidable sequential lookup latency when both fields are provided ([[apps/node-backend/src/routes/transactions.js]]).
- Repository transaction update now returns the enriched row via one CTE query (update + joins) instead of update followed by `getById`, preserving response shape and not-found behavior while reducing one DB round-trip per update ([[apps/node-backend/src/repositories/transactionRepository.js]]).
- `recipientGroupId` filter in `buildTransactionWhere` resolves the full primary-recipient group via an indexable semi-join on `recipients` (Phase Q), enabling linked-recipient transaction history discovery ([[apps/node-backend/src/services/filterBuilder.js]]).

#### Table Search Sync Behavior

- Transaction table search input updates immediately in the UI and persists after execution.
- Server filtering is debounced at 300ms (`SEARCH_DEBOUNCE_MS` from `@/hooks/useDebounce`) through `VirtualDataTable`, keeping request volume controlled while remaining responsive.
- Search reacts correctly when loosening terms (character-by-character deletion) and when clearing entirely.
- Table rows are rendered from a deferred data value (`useDeferredValue`) so typing remains responsive while results refresh.
- Filter/sort/search pipelines preserve stable source-row identity through `sourceIndex` mapping, so row edits/actions always target the original source row even when table ordering changes.
- `TransactionsPage` handlers now consistently consume `sourceIndex` semantics from shared table components.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/components/shared/DataTable.tsx]], [[apps/frontend/src/components/shared/ColumnFilter.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]]

#### URL-Backed Search + Sort, and Load-More/Attachment-Delete Failure Toasts (Aug 2026)

`search`, `sort_key`, and `sort_dir` are now URL search params alongside the existing filter params (`bank_account`, `category_id`, date range, amount range, tags, etc.):

- **Search**: the live `search` state mirrors out to `?search=` on the same debounce the query already uses (`SEARCH_DEBOUNCE_MS`), so a param write costs no extra request. Writes use `{ replace: true }`; an incoming `?search=` (e.g. from the command palette) still seeds the local state on mount.
- **Sort**: `sort_key`/`sort_dir` moved out of `useTransactionListData`'s local `useState` into the URL (`{ replace: true }` writes, so cycling a column asc/desc/none doesn't push a history entry per click). The pair is only honoured together — a half-set pair (hand-edited URL) reads as unsorted.
- **Clear filters preserves sort**: `FilterBanner`'s "clear filters" action (`onClear`) now rebuilds the param set carrying `sort_key`/`sort_dir` forward instead of wiping the URL to `{}` — sort is view state, not a filter chip, so clearing filters no longer silently reorders the list.
- **Load-more failures**: a failed infinite-scroll page fetch in `useTransactionListData` now shows `toast.error(t('txPage.loadMoreFailed'))` with a **Retry** action that re-invokes the last `loadMore()` call — previously the fetch failed silently and the list just stopped growing, reading as "end of data."
- **Attachment-delete failures**: `AttachmentPanel`'s delete mutation now shows `toast.error(t('txPage.deleteAttachmentError'))` on failure (it suppresses the global MutationCache toast backstop, so it has to speak for itself) — previously only the inline spinner reset, leaving a failed delete looking like a no-op.

Code links: [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/features/transactions/hooks/useTransactionListData.ts]], [[apps/frontend/src/features/transactions/components/FilterBanner.tsx]], [[apps/frontend/src/components/shared/AttachmentPanel.tsx]]

#### Multi-Value Filter Memoization (June 2026)

`categoryIdsFilter` and `tagsFilter` in `TransactionsPage` are memoized on their raw comma-separated search-param strings (`categoryIdsRaw`, `tagsRaw`) rather than computed inline. This matters because pivot-table drillthrough from the Statistics page generates multi-value URLs such as `?category_ids=1,2,3`, and inline array construction (e.g. `str.split(',')`) produces a new array reference on every render. That fresh reference invalidated the `currentFilter` memo on every render, which in turn triggered the selection-clear effect unconditionally, reaching React's "Maximum update depth exceeded" limit and wedging the page until a hard refresh.

Detail-cell drills (scalar `category_id`) were immune because they produce a simple scalar comparison, not an array. General-category group header drills and tag drills were affected.

**Fix**: Both arrays are wrapped in `useMemo` keyed on the raw string. The `currentFilter` memo dependency stays stable as long as the URL does not change, breaking the loop.

**Regression test**: `apps/frontend/src/pages/__tests__/TransactionsPage.integration.test.tsx` — test case verified to trip on unfixed code.

Code link: [[apps/frontend/src/pages/TransactionsPage.tsx]]

#### Frontend Page Decomposition (Phase 5)

TransactionsPage has been decomposed into feature-scoped modules under [[apps/frontend/src/features/transactions/]] to improve maintainability and code organization:

- `types.ts` — Shared types: `TableTransaction`, `RawApiTransaction`, `InfoEditableField`
- `hooks/useTransactionListData.ts` — React Query hook for infinite-scroll list data management; owns `allItems`, sort/search/filter state, `loadMore`, and editing guards
- `components/FilterBanner.tsx` — Displays active filter pills and clear-all action
- `components/TableActions.tsx` — Toolbar actions: CSV export button and "show inactive" toggle
- `components/TransactionsTable.tsx` — `VirtualDataTable` wrapper with column renderers (category/recipient comboboxes, inline date/amount edit, row toggle/delete, info/split dialogs)
- `components/TransactionInfoDialog.tsx` — Per-row info display and inline field editor
- `components/TransactionQuickLook.tsx` — Read-only Space-toggled glance dialog (NEW, premium v3 V6)
- `pages/TransactionsPage.tsx` — Slim composer that wires the hook to components and owns mutation handlers (`applyTransactionLocalPatch`, `applyInfoFieldLocally`, `handleDuplicate`, `handleFilterByRecipient`) and `useConfirmDialog`

This structure keeps related code together, makes each module focused and testable, and makes the page composition logic clear at a glance.

---

### Row Interactions — Context Menu, Quick Look & Keyboard Navigation (Premium v3 V5-V7, June 2026)

The transaction table rows gained a full interaction layer in the premium-v3 V5-V7 batch.

#### Per-Row Context Menu (right-click)

Right-clicking a transaction row opens a Radix `ContextMenu` (`modal={false}` — see [[docs/components/ui-components#per-row-context-menu|VirtualDataTable context-menu gotcha]]) with these actions:

| Action | Key hint | Condition |
|--------|----------|-----------|
| Show details | ↵ | Always |
| Quick Look | ␣ | Always |
| Edit in row | — | Always |
| Duplicate | — | `recipient_id` + `date` + `bank_account` all present |
| Show all from {recipient} | — | Recipient known |
| Mark active / inactive | — | Always |
| Delete… | — | Always (destructive style) |

#### Keyboard Row Navigation

Rows are focusable when any row handler is wired. Shortcuts while a row is focused:

- **↑ / ↓** — move focus to adjacent row (virtual scroll aware; up to 5 rAF retries until the target DOM node is mounted).
- **Enter** — open the transaction details dialog (`TransactionInfoDialog`).
- **Space** — open the Quick Look dialog (`TransactionQuickLook`).

These shortcuts are shown in `ShortcutsOverlay` (`?` key).

#### Quick Look Dialog

`TransactionQuickLook` is a read-only glance dialog (Space to open, Space or Esc to close):

- Displays: big money amount with sign color, recipient, date · bank, category badge, inactive badge, tag chips, memo/comment.
- Intentionally read-only — editing lives in `TransactionInfoDialog`.
- Focus returns to the source row on close so keyboard navigation continues.

#### Duplicate

`handleDuplicate` in `TransactionsPage` copies the focused row into a new transaction via `useCreateTransaction`. Fields copied: `transaction_date`, `bank_account`, `recipient_id`, `memo`, `amount`, `currency`, `category_id`, `comment`, `tags`. Field deliberately **not** copied: `balance` (running balance is write-protected and import-pipeline-only; the `create()` path ignores it regardless).

Gate: `recipient_id`, `transaction_date`, and `bank_account` must all be present (same contract as the create endpoint).

#### Filter by Recipient

"Show all from {recipient}" in the context menu calls `handleFilterByRecipient`, which:
1. Clears the local search string.
2. Sets `?recipient_id=<id>&filter_label=<name>` in `searchParams`, replacing all previously active URL filters.

This replaces the entire filter set with a single-recipient view, consistent with how pivot-table drilldowns work throughout the app.

Code links: [[apps/frontend/src/features/transactions/components/TransactionsTable.tsx]], [[apps/frontend/src/features/transactions/components/TransactionQuickLook.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/components/shared/ShortcutsOverlay.tsx]]

---

### Extra Information Dialog Inline Editing

- In the transaction extra information dialog, existing detail rows can now be edited inline using a per-row pencil action.
- Transaction ID is displayed for reference and remains non-editable.
- Inline row editing provides save/cancel controls and persists through the existing transaction update flow (`PATCH /api/transactions/:id`).

Code link: [[apps/frontend/src/pages/TransactionsPage.tsx]]

---

### Deep Links / Query-Param Triggers (V12, June 2026)

#### `/transactions?new=1` — Open Add Transaction Dialog

Navigating to `/transactions?new=1` immediately opens `AddTransactionDialog`. The dialog's mounting hook reads the `new` search param and, if present, opens the dialog and then strips the param from the URL (using `replace` navigation so the browser Back button does not re-trigger it).

This deep link is used by:
- The **native macOS menu** (File → New Transaction ⌘N via `ElectronBridge` `menu:action` dispatch)
- The **dock menu** (New Transaction item)

The param is safe to include in any navigation: navigating to `/transactions` without `?new=1` is unaffected.

Code link: [[apps/frontend/src/components/forms/AddTransactionDialog.tsx]]

---

### Export

Export transactions to CSV or JSON for external analysis:

```
GET /api/transactions/export/csv?start_date=2025-01-01&end_date=2025-03-18&include_balance=true
GET /api/transactions/export/json?start_date=2025-01-01&end_date=2025-03-18
```

**Streaming Response (Phase 5+):**
- Response uses chunked `res.write()` streaming instead of `res.send()` to support large exports without memory overhead.
- Pagination happens internally via `CSV_EXPORT_CHUNK_SIZE` (1000 rows per chunk).
- Running balance (CSV only) is computed in JavaScript across chunks using an accumulator so balance stays correct when sorted by date.
- Optional `include_balance=true` query param adds a "Running Balance" column; defaults to false for backward compatibility.
- 404 probe query runs before streaming starts, so error responses still return JSON.

Implementation note:
- CSV escaping, row construction, and filename generation use extracted helpers (`escapeCsvValue`, `buildTransactionCsvRow`, `buildTransactionExportFilename`) with unchanged output format.
- CSV export neutralizes spreadsheet-formula-leading values (`=`, `+`, `-`, `@`) before writing cells to reduce formula-injection risk in spreadsheet tools.
- Export and PATCH error responses avoid leaking internal exception details and return sanitized generic `detail` payloads.

#### Filtered Export (Phase 13)

The `FilterBanner` component exposes two export buttons (CSV, JSON) when a structural filter is active in the Transactions table. The export query string is built from:

- **Structural filters**: `bank_account`, `bank_accounts`, `category_id`, `category_ids`, `recipient_id`, `recipient_name`, `transaction_type`, `transaction_id`
- **Date filters**: `start_date`, `end_date`
- **Amount filters**: `amount_min`, `amount_max` (2026-06-28 — magnitude-based, sign-agnostic)
- **Search**: `search` (memo/comment/date/tag text) is included in the export when present

**Filename pattern**: `transactions_<slug-of-filterLabel-or-"filtered">_<YYYY-MM-DD>.{csv|ndjson}`

**Frontend implementation**: [[apps/frontend/src/features/transactions/components/FilterBanner.tsx]], [[apps/frontend/src/features/transactions/components/TransactionsExportButtons.tsx]]

This allows users to drill down from pivot-table summaries (e.g., "Show all transactions for Q1 2026 in the Groceries category") and export the resulting filtered view directly without manual parameter construction.

---

## Planned Transactions

Vision supports scheduled/recurring transactions through planned transactions:

- **One-time** - Single future payment
- **Recurring** - Regular payments (weekly, monthly, yearly)
- **Loans** - Special handling for loan repayments

See [[docs/api/plannedTransactions]] for the API.

---

## Analytics Integration

Transactions feed into various analytics views:

- **Monthly summary** - Income vs. expenses by month
- **Category breakdown** - Spending by category
- **Cashflow** - Daily/weekly/monthly trends
- **Trends** - Year-over-year comparison

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/transactions` | List transactions (paginated) |
| POST | `/api/transactions` | Create transaction |
| GET | `/api/transactions/:id` | Get single transaction |
| PATCH | `/api/transactions/:id` | Update transaction |
| DELETE | `/api/transactions/:id` | Delete transaction |
| GET | `/api/transactions/export/csv` | Export to CSV |
| PATCH | `/api/transactions/batch` | Batch update |

---

## Rate Limiting

Heavy operations (export, batch updates) are rate-limited to protect database performance.

---

## Best Practices

1. **Import regularly** - Set up recurring CSV imports from your bank
2. **Review categories** - Check categorization accuracy monthly
3. **Use consistent naming** - Establish clear recipient names
4. **Track cash** - Create "CASH" bank account for cash transactions

---

## Bulk Operations

Transactions support multi-row selection and bulk operations for efficiency:
- **Bulk delete** — Permanently delete many rows at once
- **Bulk recategorize** — Apply a new category to many rows
- **Bulk reassign recipient** — Change payee/payer for many rows
- **Bulk activate/deactivate** — Toggle `is_active` status across a selection
- **Bulk export** — Stream selected transactions as CSV or NDJSON
- **Bulk tag** — Apply or remove tags from many rows simultaneously

See [[docs/features/bulk-actions]] for full details on selection modes (IDs vs. filter), UI patterns, and atomic guarantees.

---

## Optimistic Create (Premium v3, June 2026)

`useCreateTransaction` is now optimistic (ADR-071). On mutation start, a temp row with a negative id (`-Date.now()`) is inserted at the head of all plain `['transactions', params]` React Query caches. On success, the temp row is swapped with the server-returned row. On error, the temp row is removed and the snapshot is restored. On settlement, `['transactions']` is invalidated.

**Derived fields**: the optimistic row may briefly show stale or missing `category_name` / `recipient_name` until the `onSettled` refetch completes (only ids are in the mutation payload). Amounts and dates from user input are always correct.

**Virtual list excluded**: `['transactions-virtual']` is deliberately not patched — same rationale as update/delete.

6 tests total in `hooks/__tests__/useOptimisticTransactions.test.tsx`.

## Optimistic Update / Delete (June 2026)

`useUpdateTransaction` and `useDeleteTransaction` are now optimistic (ADR-070 Tier 5). On mutation start, the change is applied immediately to all `['transactions', params]` React Query cache entries via `setQueriesData`, giving the user instant feedback. On error, all entries are rolled back to their snapshot. On settlement (success or error), `['transactions']` is invalidated so server truth wins.

**Important constraint**: `['transactions-virtual']` is deliberately not patched optimistically — `useTransactionListData` mirrors the virtual list's cached first page into local component state, and patching that key while the user has scrolled would collapse the list. It is corrected by the `onSettled` invalidation.

See [[docs/components/hooks#useTransactions|useTransactions hook]], [[docs/adr/071-premium-v3-effects-toggle|ADR-071]] (optimistic create), and [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] (optimistic update/delete) for full details and test coverage.

---

## Related Documentation

- [[docs/api/transactions]] - Transaction API Reference
- [[docs/features/bulk-actions]] - Bulk Transaction Operations
- [[docs/features/tags]] - Transaction Tags Feature
- [[docs/api/categories]] - Categories API
- [[docs/api/recipients]] - Recipients API
- [[docs/features/import]] - CSV Import Feature
- [[docs/features/portfolio]] - Portfolio & Investments

## Migrations

- `0001_initial_database_schema.py` — Initial schema with `transactions`, `categories`, `recipients` tables
- `0003_make_recipient_nullable.py` — Made `recipient_id` nullable on transactions
- `0005_manual_raw_transactions.py` — Added `manual_raw_transactions` table for manual entry deduplication
- `0007_recipient_merge.py` — Added `primary_recipient_id` for recipient merge support
- `0008_drop_custom_raw_transactions.py` — Dropped `custom_raw_transactions` table (custom imports now use generic path)
- `0012_add_indexes.py` — Performance indexes on transactions and related tables
