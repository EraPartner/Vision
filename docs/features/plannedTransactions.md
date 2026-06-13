---
title: Planned Transactions
type: feature
status: active
date: 2026-04-26
updated: 2026-06-11
tags: [feature, planned, recurring, bills, loans, phase-3, phase-12, calculations, immutability, error-handling, toast, atomic-patch, virtual-data-table, i18n-toasts, suggestion-card, upcoming-payments-hook, occurrence-key-dismissal, june-2026]
aliases: [planned-payments, scheduled-payments, recurring-payments, bills, subscriptions, loan-amortization]
description: Scheduled and recurring payment tracking - manage bills, subscriptions, and future expenses. June 2026: PlannedPaymentsPage migrated from DataTable to VirtualDataTable; native alert() replaced with toast.error (new i18n keys plannedPage.toggleFailed/deleteFailed). V11: useUpcomingPlannedPayments shared hook (single fetch + shared dismissed-ID store); SuggestionCard dashboard widget; UpcomingPaymentsNotification stands down on dashboard route when suggestions widget is visible. June 2026 (B1 fix): dismissals now keyed per occurrence (id:YYYY-MM-DD) so recurring reminders re-surface each cycle; past-dated keys pruned on load; legacy id-only entries silently dropped on next load.
related_code: ["apps/node-backend/src/routes/plannedTransactions.js", "apps/node-backend/src/repositories/plannedTransactionRepository.js", "apps/node-backend/src/services/calculations/loanSchedule.js", "apps/node-backend/src/services/calculations/recurrence.js", "apps/node-backend/src/services/recurringDetectionService.js", "apps/frontend/src/components/planned/PlannedPaymentForm.tsx", "apps/frontend/src/components/planned/LinkTransactionDialog.tsx", "apps/frontend/src/components/planned/ExecutionHistoryDialog.tsx", "apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx", "apps/frontend/src/components/shared/DatePicker.tsx", "apps/frontend/src/components/shared/dateUtils.ts", "apps/frontend/src/hooks/useUpcomingPlannedPayments.ts"]
---

# Planned Transactions

Vision's planned transaction system helps track upcoming payments, recurring bills, subscriptions, and loan repayments.

## Overview

Planned transactions represent expected financial activities that haven't occurred yet. They can be one-time or recurring, and can be manually executed or auto-generated.

## Transaction Types

### One-Time Payments

Single future payments with a specific date:

- **Rent payment** - Due on the 1st of each month
- **Annual insurance** - Due once per year
- **Planned purchase** - Saving for future expense

---

### Recurring Payments

Regular payments following a recurrence pattern:

```javascript
{
  "is_recurring": true,
  "recurrence_pattern": {
    "interval": "monthly",  // daily, weekly, biweekly, monthly, quarterly, yearly
    "day_of_month": 15,    // for monthly
    "day_of_week": 1,       // for weekly (0=Sunday)
  }
}
```

**Supported Intervals:**
- Daily
- Weekly
- Biweekly
- Monthly
- Quarterly
- Yearly

---

### Loan Payments

Special handling for loans with amortization:

```javascript
{
  "is_loan": true,
  "loan_type": "mortgage",          // mortgage, personal, car, other
  "loan_principal": 200000,         // Original loan amount
  "loan_annual_interest_rate": 3.5, // Interest rate %
  "loan_term_months": 360,          // Term in months
  "loan_start_date": "2020-01-15",
  "loan_payment_day": 15,           // Day of month for payment
  "loan_regular_payment_amount": 898,
  "loan_first_payment_date": "2020-02-15"
}
```

**Loan Types:**
- Mortgage
- Personal loan
- Car loan
- Other

**Interest convention (whole-month):** the schedule charges interest per whole
month on the remaining principal — installment 1 carries a full month of
interest even when the loan starts mid-month (e.g. start on the 5th, payment
day on the 20th). There is no day-count proration; this is the standard
simplification used by `loanSchedule.js` and matches how most consumer loan
tables are quoted.

---

## Features

### Form UX and Date Handling

Planned payment forms now use shared input components for consistency across dialogs:

- `DatePicker` (Popover + Calendar) for due date and optional end date
- `RecipientCombobox` for recipient selection
- `CategoryCombobox` for category selection
- Shared local-date helpers in `dateUtils` (`parseLocalDateFromYmd`, `toYmd`) to avoid timezone shifts when reading/writing `YYYY-MM-DD`
- `formatDistanceToNow` now accepts a `locale` option in its options parameter and passes it to `Intl.RelativeTimeFormat`, ensuring relative date labels respect the user's locale setting (en or nl) instead of hardcoding English
- **Locale-aware date formatting (2026-04-25):** Portfolio news feed (`PortfolioNewsFeed.tsx`) now explicitly passes the `language` prop from `useLanguage()` context to all `NewsItem` components; `NewsItem` receives `locale` and forwards it to `formatDistanceToNow` options, ensuring relative timestamps display in the correct language rather than defaulting to hardcoded English

This keeps planned-payment date selection aligned with other forms and avoids native date-input overlay/stacking issues in modal contexts. Relative date labels now correctly display in the user's configured language.

Planned payment form currency defaults are now sourced from app settings consistently:

- New planned payment form defaults `currency` to `appSettings.defaultCurrency`
- Form reset after create/edit reuses `appSettings.defaultCurrency`
- Planned payment API mapping fallback currency uses configured defaults rather than hardcoded values

Code links: [[apps/frontend/src/components/planned/PlannedPaymentForm.tsx]], [[apps/frontend/src/hooks/usePlannedPayments.ts]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]]

### Execution Tracking

Track when planned transactions become real transactions:

- Mark as **executed** when paid
- **Auto-create** transactions on due date
- Track **last executed date**

---

### Due Date Notifications

Vision can alert users about upcoming payments:
- Upcoming this week
- Overdue payments
- Monthly bill summary

#### Shared hook and dismissed-occurrence store (V11 + June 2026 fix)

Both the app-level banner (`UpcomingPaymentsNotification`) and the dashboard suggestion card (`SuggestionCard`) use the shared `useUpcomingPlannedPayments` hook. This ensures:

- **Single network fetch**: One React Query instance keyed on `"upcomingPlannedPayments"` shared across both surfaces.
- **Consistent dismissal**: A module-level dismissed-occurrence `Set` backed by `useSyncExternalStore` persists to `LOCAL_STORAGE_KEYS.DISMISSED_UPCOMING_PAYMENTS`. Dismissing from either surface is immediately reflected on the other.

#### Dismissal key format (June 2026 fix — F1)

Dismissals are keyed by **occurrence**, not by row id:

```
key = `${pt.id}:${pt.planned_date.slice(0, 10)}`
// e.g. "42:2026-07-01"
```

**Why this matters for recurring payments:** Recurring planned transactions keep their `id` while `planned_date` advances each cycle. Under the previous id-only scheme, dismissing one month's rent reminder would silence every future occurrence permanently. With occurrence keys, only the specific `id:date` pair is suppressed — the next cycle surfaces as a new occurrence.

**Pruning and migration:**
- On load, entries whose date portion is strictly before today are dropped (bounds growth and removes stale dismissals).
- Legacy entries that are purely numeric (e.g. `"42"`, the old id-only format) do not match `DISMISS_KEY_RE = /^\d+:\d{4}-\d{2}-\d{2}$/` and are silently dropped. This causes a one-time re-surfacing of previously dismissed reminders — intentional, because the prior data was semantically wrong.

**`dismiss()` signature change:** The function now takes `DismissTarget | DismissTarget[]` (objects with `id` and `planned_date`), not bare ids. Both banner and SuggestionCard pass the planned-transaction object(s) directly.

#### Dashboard stand-down

`UpcomingPaymentsNotification` stands down on the `/` route while the `suggestions` widget is visible (`useWidgetVisibility('dashboard', []).isVisible('suggestions')` returns `true`). This prevents showing both the banner and the card simultaneously. Hiding the widget from the widget-visibility dialog re-enables the banner on the dashboard.

#### macOS dock badge

The dock badge count is driven by `UpcomingPaymentsNotification` (non-dismissed due items count) and cleared on unmount — this logic is unaffected by the V11 refactor.

The top-level upcoming-planned-payments notification is dismissible with persistence:

- Dismissal state is stored in browser local storage keyed by `id:YYYY-MM-DD` (occurrence key — see above)
- Dismissing an occurrence hides it for that cycle only; recurring reminders re-surface when `planned_date` advances
- Dismissing the banner hides all currently visible upcoming planned payments for their respective occurrences

### Recurring Detection Dismissals

Dismissals in the recurring-pattern detection panel are persistent and do not reappear after reload:

- Uses setting key `dismissed_recurring_patterns`
- Persists to backend settings (`/api/settings/:key`) so state survives sessions/devices
- Keeps a localStorage fallback (`dismissed_recurring_patterns`) when settings API is unavailable
- Users can reset these dismissals from Settings → App via “Reset dismissed recurring suggestions”
- Pattern date labels in `RecurringDetectionPanel` follow app `dateFormat` + locale settings
- Backend settings persistence now stores dismissal arrays as explicit JSONB (`JSON.stringify` + `::jsonb`) to prevent invalid JSON writes when dismissing suggestions

Code links: [[apps/frontend/src/components/planned/RecurringDetectionPanel.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/node-backend/src/repositories/settingsRepository.js]]

---

### URL Support

Link recurring payments to their source:

```javascript
{
  "url": "https://provider.com/account/billing"
}
```

Useful for:
- Subscription management
- Online bill pay links
- Account portals

---

## Atomic Loan PATCH (2026-05-29)

`PATCH /api/planned-transactions/:id` for loan-type planned transactions now applies the field update and the loan-schedule replacement in a **single database transaction** via `plannedTransactionRepository.updateWithLoanSchedule(id, fields, scheduleEntries)`.

**Before:** the route issued two separate calls — `repository.update()` followed by `repository.replaceLoanSchedule()`. A failure between the two left the row's header fields updated but the schedule stale (or vice versa), producing inconsistent amortization data.

**After:** `updateWithLoanSchedule` wraps both operations in `withTransaction(client => …)`:
1. `UPDATE planned_transactions SET … WHERE id = $n RETURNING id`
2. `DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = $1`
3. Batch `INSERT` of the new schedule rows

All three steps commit or roll back together. If the row no longer exists, `null` is returned and no schedule mutation occurs.

**Scope:** Only the PATCH path for loan-bearing rows uses this method. Non-loan PATCHes continue through the standard `repository.update()` path. The standalone `replaceLoanSchedule()` method remains for any direct schedule-reset calls.

## Execution Atomicity and Idempotency (Phase 3)

The execute endpoint is now **atomic and idempotent**:

- **Database:** Migration `0027_planned_execution_idempotency` adds a UNIQUE INDEX on `planned_transaction_executions (planned_transaction_id, executed_transaction_id)`. Any attempt to re-execute the same (planned_id, executed_id) pair will trigger a unique violation.
- **Endpoint:** `POST /api/planned-transactions/:id/execute` wraps the insert-execution-row + update-parent pair in a single `BEGIN/COMMIT` transaction. If a unique violation occurs (Postgres error 23505), the transaction rolls back and returns a 200 OK with the current planned state + `Idempotent-Replay: true` header instead of error.
- **Result:** Double-clicks, retries, and network replays return the same result without creating duplicate execution rows.

See [[docs/adr/012-planned-execution-idempotency|ADR-012]] for design rationale.

## Supporting Services

## Backend Route Implementation Notes

Recent backend route refactoring consolidated duplicated logic in [[apps/node-backend/src/routes/plannedTransactions.js]] while preserving endpoint behavior:

- Shared route-id parsing via `parseRouteId(req)` across `GET /:id`, `PATCH /:id`, `POST /:id/execute`, and `DELETE /:id`
- Shared PATCH sanitization via `withoutPatchOnlyReadOnlyFields(fields)` — returns new object via destructured rest pattern, eliminating in-place mutations
- Shared name→id resolution helpers for recipient/category updates (`resolveRecipientIdFromName`, `resolveCategoryIdFromName`)
- Shared loan recalculation/defaulting helper for PATCH updates (`applyLoanPatchDefaults`)
- Shared execution-date fallback helper (`getCurrentDateString`)
- Shared write-path error handling helper for POST/PATCH (`handlePlannedTransactionWriteError`)
- Shared PATCH loan-schedule persistence branch helper (`updateLoanScheduleForPatch`)

Performance/efficiency follow-ups (behavior-preserving):

- List repository now computes `total` from `COUNT(*) OVER()` in the paginated query and only executes a fallback count query when the page is empty.
- List query removed redundant pre-aggregated execution-count join and now derives `execution_count` from the already batched executions fetch.
- Update repository path now returns enriched updated row via single CTE query (`WITH updated ... SELECT ...`) before attaching executions/schedule.
- Route-level recipient/category name resolution and recurring execute-date calculation now use module-scoped imports (`dbQuery`, `calculateNextDate`) instead of per-request dynamic imports.
- PATCH recipient/category name-resolution now executes in parallel via `Promise.all`, preserving unresolved-name behavior while reducing sequential lookup latency when both fields are present.
- **Execution history loading optimization (2026-04-25):** `PlannedPaymentsPage.tsx` now wraps `loadExecutionHistory` in `useCallback([payments])` to prevent function recreation on every render, reducing unnecessary dependency array churn and improving efficiency when the history modal is opened.

These changes preserve API payloads/status semantics while reducing hot-path overhead.

This refactor reduced handler duplication and improved maintainability without changing API contracts, response payload shapes, or status-code behavior.

### Calculation Services (Phase 3 — Canonical Paths)

**Note:** Calculation services have been relocated to `apps/node-backend/src/services/calculations/` as part of Phase 3 of the non-portfolio refactor. Back-compat re-export shims are maintained at the old paths (`loanRepaymentService.js`, `recurrenceService.js`) but new code should use the canonical paths below.

### `services/calculations/recurrence.js`
**File:** [[apps/node-backend/src/services/calculations/recurrence.js]]

Calculates next occurrence dates for recurring planned transactions. Pure calculation function with no I/O side effects.

**Supported Patterns:** `daily`, `weekly`, `biweekly`, `monthly`, `quarterly`, `yearly`, and custom `every N days`.

| Function | Purpose |
|----------|---------|
| `calculateNextDate(currentDate, pattern)` | Returns next date based on recurrence pattern |
| `isValidPattern(pattern)` | Validates pattern string |
| `getSupportedPatterns()` | Returns array of supported pattern names |

**Implementation Details (2026-04-25):** Month-end clamping uses a double-modulo pattern `((targetMonthIndex % 12) + 12) % 12` to normalize negative month indices to their zero-based month equivalents (e.g., `-1` → `11` for December). This ensures that month arithmetic in TZ-aware contexts correctly handles month overflow/underflow before converting back to UTC.

#### Recurrence advancement: sticky month-end clamp (2026-06-11)

When `POST /:id/execute` advances a recurring planned transaction it calls `calculateNextDate(baseDate, recurrence_pattern)` where `baseDate` is the row's current `planned_date`. The next date is then stored via `toAppDateString(nextDate)`.

`addMonthsClampedInAppTz` clamps the day-of-month to the last valid day of the *target* month:

```
Jan 31  --[+1 month]--> Feb 28   (28 stored; Feb has no 31st)
Feb 28  --[+1 month]--> Mar 28   (advance chains from 28, not from the original 31)
Mar 28  --[+1 month]--> Apr 28   (stays at 28 forever)
```

**This "sticky clamp" is intentional, documented behavior.** The alternative — storing the user's original day-of-month as a `preferred_day` anchor and restoring it each cycle (the pattern used in `loanSchedule.js#addMonthsAtDay`) — was considered and deliberately not implemented. Reasons:

- Planned transactions are created with a single `planned_date` field; there is no separate anchor column.
- The sticky behavior is transparent and deterministic: the stored `planned_date` is always the actual next due date, with no hidden state.
- Adding a `preferred_day` column is a possible future enhancement but requires a migration and a UI affordance for users to understand the gap.

> [!info] Scope of this note
> The 2026-04-25 note above this section describes the *double-modulo math* for normalizing month indices (a low-level arithmetic detail). This section describes the *anchor semantics*: that after a clamp the chain advances from the clamped date, not from a remembered original day-of-month. These are separate concerns.

The code comment in `routes/plannedTransactions.js` at the `updateFields.planned_date` assignment points to this section: `(Day-of-month anchor is intentionally sticky-clamped — see docs/features planned-transactions.)`

### `services/calculations/loanSchedule.js`
**File:** [[apps/node-backend/src/services/calculations/loanSchedule.js]]

Generates amortization schedules for loan-type planned transactions. Pure calculation function with no I/O side effects.

**Supported Loan Types:**
- `amortizing` — Fixed monthly payment (principal + interest), calculated using standard annuity formula
- `fixed_principal` — Equal principal payments + declining interest
- `interest_only` — Interest-only payments, full principal due at final installment

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `validateLoanConfig(config)` | Validates loan parameters (principal, rate, term, payment day, start date). Max term: 600 months (50 years) |
| `generateLoanSchedule(config)` | Generates full amortization schedule with per-installment breakdown (principal, interest, remaining) |

**Schedule Output:** Each installment includes `installment_number`, `due_date`, `payment_amount`, `principal_amount`, `interest_amount`, `remaining_principal`.

**Testing:** Covered by golden-fixture test suites in [[apps/node-backend/tests/services/loanSchedule.golden.test.js]] and [[apps/node-backend/tests/services/recurrence.golden.test.js]]. See [[docs/reference/code-patterns#golden-fixture-pattern|Code Patterns: Golden-Fixture Pattern]] for workflow.

> [!info] Locked contracts (Phase 8)
> Amortization and recurrence invariants are pinned by property tests in [[apps/node-backend/tests/property/loanSchedule.property.test.js]] and [[apps/node-backend/tests/property/recurrence.property.test.js]]. Locked invariants include: sum of principal rows = original principal (amortizing), remaining principal monotonically decreases, recurrence `calculateNextDate` is strictly forward-moving and cadence-consistent. See [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] and [[apps/node-backend/tests/golden/INVENTORY.md|Calculation Inventory]].

### `recurringDetectionService.js`
**File:** [[apps/node-backend/src/services/recurringDetectionService.js]]

Analyzes transaction history to detect recurring payment patterns and suggests planned transactions.

**Detection Algorithm:**
1. Groups transactions by recipient
2. Calculates intervals between consecutive transactions
3. Computes interval statistics: mean, **median (true median, averaging two middle values for even-length arrays)**, standard deviation
4. Matches against known patterns (weekly, biweekly, monthly, quarterly, yearly) with tolerance
5. Detects custom regular intervals using coefficient of variation (< 25%)
6. Flags amount changes (> 5% from median)
7. Computes confidence score (0-100) based on consistency, occurrence count, and amount stability

**Minimum Requirements:** 3 occurrences to consider a pattern.

**Output per Pattern:**
- `detectedPattern` — Pattern name (weekly, monthly, custom, etc.)
- `medianDays` — True median interval in days (for even-length samples, average of two middle values)
- `customIntervalDays` — Custom interval value (for non-standard patterns)
- `consistency` — Percentage match (0-100)
- `confidence` — Overall confidence score
- `predictedNext` — Predicted next occurrence date
- `amountChanges` — Recent amount deviations
- `isAlreadyPlanned` — Whether recipient already has a planned transaction

**Correctness Note (2026-04-25):** The median calculation now correctly computes the true median for even-length interval arrays by averaging the two middle values. This affects pattern classification for samples with even occurrence counts, especially near tolerance boundaries where the choice between two candidate patterns depends on precise median computation.

---

## Bill Reminders (Phase 6)

New endpoint to fetch upcoming bills within a specified number of days, useful for dashboard notifications and quick checks.

**Endpoint:** `GET /api/planned-transactions/due-soon?days=N`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `days` | integer | 7 | 90 | Look-ahead window in days |

**Response:** List of active, unexecuted planned transactions with planned dates within the next N days, sorted by date.

**Example:**
```http
GET /api/planned-transactions/due-soon?days=14
```

Returns bills due in the next 14 days (common use: dashboard notification banner, weekly bill checklist).

**i18n Keys (Phase 6):**
- `planned.dueSoon` — "Due Soon"
- `planned.dueSoonEmpty` — "No bills due in the next N days"
- `planned.dueSoonTitle` — "Upcoming Bills"
- `planned.dueInDays` — "Due in X days"
- `planned.overdueBy` — "X days overdue"

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/planned-transactions` | List planned transactions |
| POST | `/api/planned-transactions` | Create planned transaction |
| GET | `/api/planned-transactions/:id` | Get single planned transaction |
| PATCH | `/api/planned-transactions/:id` | Update planned transaction |
| DELETE | `/api/planned-transactions/:id` | Delete planned transaction |
| POST | `/api/planned-transactions/:id/execute` | Execute as transaction |
| GET | `/api/planned-transactions/due-soon` | Upcoming bills within N days (Phase 6) |

---

## Use Cases

### Personal Finance

- **Rent/Mortgage** - Regular housing payments
- **Utilities** - Recurring bills
- **Subscriptions** - Netflix, Spotify, software
- **Insurance** - Health, car, home insurance

### Business Finance

- **Vendor payments** - Regular supplier payments
- **Payroll** - Salary schedules
- **Tax estimates** - Quarterly tax payments

### Debt Management

- **Loan tracking** - Monitor payoff progress
- **Extra payments** - Track additional principal payments
- **Refinancing** - Compare loan terms

---

## Integration with Transactions

When a planned transaction is executed:
1. Creates a new transaction
2. Links to the planned transaction
3. Updates execution history
4. Triggers analytics recalculation

---

## Best Practices

1. **Review regularly** - Check upcoming payments weekly
2. **Set reminders** - Enable notifications for due dates
3. **Categorize** - Assign categories to automate
4. **Track loans** - Use loan features for accurate amortization

---

## Frontend Components

### PlannedPaymentForm

Dialog form for creating and editing planned transactions. Supports both one-time payments and recurring payments with optional loan configuration.

**Props:**
| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Dialog open state |
| `onOpenChange` | `(open) => void` | Open state change handler |
| `onSubmit` | `(data) => void` | Submit handler with PlannedPayment payload |
| `initial` | `PlannedPayment?` | Pre-fill values for editing mode |

**Form Fields:**
- Name, amount, currency, due date
- Recurring toggle with frequency selector (daily, weekly, biweekly, monthly, quarterly, yearly, custom)
- Loan toggle with loan type (amortizing, fixed_principal, interest_only)
- Loan fields: principal, annual interest rate, term months, payment day
- Recurring limits: end date, max occurrences
- Recipient, category, bank account, notes, URL

**Validation:**
- Name and due date always required
- Amount required for non-loan payments
- Loan requires principal, rate, and term (1-600 months)
- When loan is enabled, recurrence inputs are cleared before submission

**Code**: [[apps/frontend/src/components/planned/PlannedPaymentForm.tsx]]

### LinkTransactionDialog (2026-04-26)

Extracted dialog component that manages linking a transaction execution to a planned payment. Owns all state for transaction search, filtering, and linking UI.

**Props:**
| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Dialog open state |
| `onOpenChange` | `(open: boolean) => void` | Open state change handler |
| `payment` | `PlannedPayment \| null` | Planned payment to link transaction to |
| `onExecute` | `(paymentId: number, txId: number, executionDate?: string) => Promise<void>` | Called when user confirms link |

**Internal State:**
- `txSearchQuery` — Transaction search input
- `candidateTxs` — Matching transactions from API
- `txLoading` — Search in progress
- `actionLoading` — Execution in progress
- `selectedTxId` — Selected transaction ID
- `executionDate` — Date to record execution for
- `txFilters` — Filter object with recipient, dates, bank account, amount matching

**Behavior:**
- Initializes filters from planned payment's recipient/due_date/bank_account
- **Recipient Resolution (2026-04-26):** When the planned payment has a `recipient_id`, the dialog:
  1. Fetches the recipient object to resolve the cluster root
  2. Uses `primary_recipient_id` if present (indicating the recipient is an alias in a cluster), otherwise uses the recipient's own ID
  3. Sets `txFilters.recipient_id` to the resolved cluster root ID
  4. Passes this to the API, which applies the filter `(t.recipient_id = $X OR r.primary_recipient_id = $X)` to include both the primary recipient's transactions and all alias transactions
  5. Shows helper text "Includes transactions from linked recipients" when in linked-recipient mode
- When user manually edits the recipient text input, `recipient_id` is cleared and search falls back to text-based matching
- Debounced transaction fetch on filter changes
- Shows matching transactions with amount, date, recipient
- Allows optional execution date adjustment
- **Error feedback (2026-04-26):** Uses `toast.error(...)` from sonner instead of native `alert()` for consistent project convention
- **i18n (2026-04-26):** New key `plannedPage.link.includesLinked` for linked-recipient helper text

**Code**: [[apps/frontend/src/components/planned/LinkTransactionDialog.tsx]]

### ExecutionHistoryDialog (2026-04-26)

Extracted dialog component that displays the execution history for selected planned payments. Fetches linked transaction details on dialog open.

**Props:**
| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Dialog open state |
| `onOpenChange` | `(open: boolean) => void` | Open state change handler |
| `payments` | `PlannedPayment[]` | Planned payments to load history for |

**Internal State:**
- `historyLoading` — History fetch in progress
- `executionHistory` — Array of `ExecutionHistoryItem` (internally defined type with plannedPaymentId, name, executionDate, transactionId, transactionDate, recipient, category, amount, currency, memo)

**Behavior:**
- `loadExecutionHistory` callback wrapped in `useCallback([payments])` to avoid unnecessary function recreation
- Loads when dialog opens
- Batches transaction fetches for all planned payments' executions

**Code**: [[apps/frontend/src/components/planned/ExecutionHistoryDialog.tsx]]

### RecurringDetectionPanel

Panel that displays detected recurring payment patterns from the backend. Allows users to review patterns, dismiss false positives, and convert patterns into planned transactions.

**Props:**
| Prop | Type | Description |
|------|------|-------------|
| `onCreatePlanned` | `(pattern) => void` | Called when user creates a planned from a pattern |

**Features:**
- Fetches patterns via `apiClient.getRecurringPatterns()`
- Displays pattern details: frequency, amount, recipient, date range, occurrence count
- Shows confidence indicators (amount stability, interval consistency)
- Dismiss patterns (persisted to localStorage + backend settings)
- Create planned transactions from detected patterns
- Expandable/collapsible pattern cards
- Amount change detection warnings

**Dismissal Storage:** Uses dual storage — localStorage for immediate persistence and backend settings API for cross-device sync. Storage key: `dismissed_recurring_patterns`.

**Code**: [[apps/frontend/src/components/planned/RecurringDetectionPanel.tsx]]

### PlannedPaymentsPage Refactoring (2026-04-26)

The `PlannedPaymentsPage` was refactored from 914 lines to 503 lines by extracting two dialog components:
- Dialog state management and logic moved to respective dialog components
- Main page now focuses on list display, form submission, and deletions
- Performance improvement: `loadExecutionHistory` wrapped in `useCallback` to prevent function recreation

### PlannedPaymentsPage — VirtualDataTable + Toast Errors (June 2026)

- **DataTable → VirtualDataTable:** `PlannedPaymentsPage` now uses `VirtualDataTable` for row rendering. This enables consistent virtualized list behavior with the rest of the app and handles large planned-payment lists without DOM bloat.
- **alert() → toast.error:** Native `window.alert()` calls for toggle and delete failures have been replaced with `toast.error(t('plannedPage.toggleFailed'))` and `toast.error(t('plannedPage.deleteFailed'))`. These are new i18n keys added to `en.json` and `nl.json` in June 2026. See [[docs/i18n/translations|Translations]] for key values.

**Column sizing (follow-up polish, June 2026):**

After the VirtualDataTable migration the column widths were adjusted so the table fills its container correctly without overflow:

| Column | `defaultWidth` | `minWidth` | Notes |
|--------|---------------|-----------|-------|
| `is_executed` | 52 (fixed) | — | Icon column; fixed so it does not expand as a flex column |
| `category` | _none_ (auto-fit) | 140 | **Flexible column** — no `defaultWidth`; absorbs all remaining table width after fixed/semi-fixed columns are placed. Category labels are typically the longest cells. Previously had a fixed 120px width that caused overflow. |
| `status` | 130 | — | Widened from 100 to fit status badge + toggle |
| `actions` | 96 (fixed) | — | Action buttons column; fixed to prevent greedy flex growth |

The category column's absence of `defaultWidth` is intentional — VirtualDataTable treats columns without a `defaultWidth` as the auto-fill column.

---

## Related Documentation

- [[docs/api/plannedTransactions]] - Planned Transactions API
- [[docs/api/transactions]] - Transactions API
- [[docs/api/recipients]] - Recipients API

## Migrations

- `0002_add_url_to_planned_transactions.py` — Added `url` field for linking to billing portals
- `0011_planned_loans.py` — Added loan support fields (`is_loan`, `loan_type`, `loan_principal`, `loan_annual_interest_rate`, `loan_term_months`, `loan_start_date`, `loan_payment_day`, `loan_regular_payment_amount`, `loan_first_payment_date`) and `planned_transaction_loan_schedule` table
