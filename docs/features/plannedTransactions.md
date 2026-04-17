---
title: Planned Transactions
type: feature
status: active
date: 2026-04-16
tags: [feature, planned, recurring, bills, loans, phase-3, calculations]
aliases: [planned-payments, scheduled-payments, recurring-payments, bills, subscriptions, loan-amortization]
description: Scheduled and recurring payment tracking - manage bills, subscriptions, and future expenses
related_code: ["apps/node-backend/src/routes/plannedTransactions.js", "apps/node-backend/src/repositories/plannedTransactionRepository.js", "apps/node-backend/src/services/calculations/loanSchedule.js", "apps/node-backend/src/services/calculations/recurrence.js", "apps/node-backend/src/services/recurringDetectionService.js", "apps/frontend/src/components/planned/PlannedPaymentForm.tsx", "apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx", "apps/frontend/src/components/shared/DatePicker.tsx", "apps/frontend/src/components/shared/dateUtils.ts"]
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
    "interval": "monthly",  // daily, weekly, monthly, yearly
    "day_of_month": 15,    // for monthly
    "day_of_week": 1,       // for weekly (0=Sunday)
  }
}
```

**Supported Intervals:**
- Daily
- Weekly
- Monthly
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

---

## Features

### Form UX and Date Handling

Planned payment forms now use shared input components for consistency across dialogs:

- `DatePicker` (Popover + Calendar) for due date and optional end date
- `RecipientCombobox` for recipient selection
- `CategoryCombobox` for category selection
- Shared local-date helpers in `dateUtils` (`parseLocalDateFromYmd`, `toYmd`) to avoid timezone shifts when reading/writing `YYYY-MM-DD`

This keeps planned-payment date selection aligned with other forms and avoids native date-input overlay/stacking issues in modal contexts.

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

The top-level upcoming-planned-payments notification is dismissible with persistence:

- Dismissal state is stored in browser local storage by planned payment ID
- Dismissing an item hides it on subsequent page loads/sessions
- Dismissing the banner hides all currently visible upcoming planned payments

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
- Shared PATCH sanitization via `removePatchOnlyReadOnlyFields(fields)`
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

### `recurringDetectionService.js`
**File:** [[apps/node-backend/src/services/recurringDetectionService.js]]

Analyzes transaction history to detect recurring payment patterns and suggests planned transactions.

**Detection Algorithm:**
1. Groups transactions by recipient
2. Calculates intervals between consecutive transactions
3. Matches against known patterns (weekly, biweekly, monthly, quarterly, yearly) with tolerance
4. Detects custom regular intervals using coefficient of variation (< 25%)
5. Flags amount changes (> 5% from median)
6. Computes confidence score (0-100) based on consistency, occurrence count, and amount stability

**Minimum Requirements:** 3 occurrences to consider a pattern.

**Output per Pattern:**
- `detectedPattern` — Pattern name (weekly, monthly, custom, etc.)
- `intervalDays` — Median interval in days
- `consistency` — Percentage match (0-100)
- `confidence` — Overall confidence score
- `predictedNext` — Predicted next occurrence date
- `amountChanges` — Recent amount deviations
- `isAlreadyPlanned` — Whether recipient already has a planned transaction

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

---

## Related Documentation

- [[docs/api/plannedTransactions]] - Planned Transactions API
- [[docs/api/transactions]] - Transactions API
- [[docs/api/recipients]] - Recipients API

## Migrations

- `0002_add_url_to_planned_transactions.py` — Added `url` field for linking to billing portals
- `0011_planned_loans.py` — Added loan support fields (`is_loan`, `loan_type`, `loan_principal`, `loan_annual_interest_rate`, `loan_term_months`, `loan_start_date`, `loan_payment_day`, `loan_regular_payment_amount`, `loan_first_payment_date`) and `planned_transaction_loan_schedule` table
