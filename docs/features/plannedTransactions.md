---
title: Planned Transactions
type: feature
status: active
date: 2025-03-18
tags: [feature, planned, recurring, bills]
description: Scheduled and recurring payment tracking - manage bills, subscriptions, and future expenses
related_code: ["apps/node-backend/src/routes/plannedTransactions.js", "apps/node-backend/src/repositories/plannedTransactionRepository.js"]
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
