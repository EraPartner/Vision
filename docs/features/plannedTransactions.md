---
title: Planned Transactions
type: feature
status: active
date: 2026-03-26
tags: [feature, planned, recurring, bills]
description: Scheduled and recurring payment tracking - manage bills, subscriptions, and future expenses
related_code: ["apps/node-backend/src/routes/plannedTransactions.js", "apps/node-backend/src/repositories/plannedTransactionRepository.js", "apps/frontend/src/components/planned/PlannedPaymentForm.tsx", "apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx", "apps/frontend/src/components/shared/DatePicker.tsx", "apps/frontend/src/components/shared/dateUtils.ts"]
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

## Related Documentation

- [[docs/api/plannedTransactions]] - Planned Transactions API
- [[docs/api/transactions]] - Transactions API
- [[docs/api/recipients]] - Recipients API
