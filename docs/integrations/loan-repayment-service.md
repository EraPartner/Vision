---
title: Integration - Loan Repayment Service
type: integration
status: active
date: 2026-04-02
tags: [integration, loans, amortization, repayment, planned-transactions]
description: Loan repayment calculation service supporting amortizing, fixed principal, and interest-only loans
aliases: [loan repayment, amortization, loan calculator, planned loans]
related_code: ["apps/node-backend/src/services/calculations/loanSchedule.js", "apps/node-backend/src/routes/plannedTransactions.js"]
---

# Integration: Loan Repayment Service

## Overview

The Loan Repayment Service calculates amortization schedules for planned loan transactions, supporting multiple loan types with proper interest calculations.

---

## Supported Loan Types

| Type | Description | Payment Pattern |
|------|-------------|-----------------|
| **Amortizing** | Standard mortgage/loan | Equal total payments, varying principal/interest split |
| **Fixed Principal** | Equal principal payments | Decreasing total payments over time |
| **Interest Only** | Interest-only period | Interest-only payments, balloon principal at end |

---

## Amortizing Loan Calculation

### Formula

For a loan with principal P, annual interest rate r, and term n months:

```
monthly_rate = r / 12
monthly_payment = P × monthly_rate × (1 + monthly_rate)^n / ((1 + monthly_rate)^n - 1)
```

### Schedule Generation

For each month i:
```
interest_i = remaining_principal × monthly_rate
principal_i = monthly_payment - interest_i
remaining_principal = remaining_principal - principal_i
```

---

## Fixed Principal Calculation

```
monthly_principal = P / n
interest_i = remaining_principal × monthly_rate
monthly_payment_i = monthly_principal + interest_i
```

---

## Interest-Only Calculation

```
monthly_payment = P × monthly_rate  (for all months except last)
final_payment = P + (P × monthly_rate)  (principal + last interest)
```

---

## Database Schema

### planned_transactions (loan fields)

| Column | Type | Description |
|--------|------|-------------|
| is_loan | BOOLEAN | Loan flag |
| loan_type | TEXT | Loan type |
| loan_principal | NUMERIC(15,2) | Principal amount |
| loan_annual_interest_rate | NUMERIC(8,4) | Annual interest rate |
| loan_term_months | INTEGER | Term in months |
| loan_start_date | DATE | Start date |
| loan_payment_day | INTEGER | Day of month for payment |
| loan_regular_payment_amount | NUMERIC(15,2) | Regular payment amount |
| loan_first_payment_date | DATE | First payment date |

### planned_transaction_loan_schedule

| Column | Type | Description |
|--------|------|-------------|
| planned_transaction_id | INTEGER | Loan reference |
| installment_number | INTEGER | Installment number |
| due_date | DATE | Due date |
| payment_amount | NUMERIC(15,2) | Total payment |
| principal_amount | NUMERIC(15,2) | Principal portion |
| interest_amount | NUMERIC(15,2) | Interest portion |
| remaining_principal | NUMERIC(15,2) | Remaining principal |

**Migration:** `0011_planned_loans.py`

---

## API Integration

When creating a planned transaction with `is_loan: true`:
1. Service calculates the amortization schedule
2. Schedule rows are inserted into `planned_transaction_loan_schedule`
3. Each installment becomes an executable planned transaction

---

## Related

- [[docs/features/plannedTransactions]] — Planned transactions feature
- [[docs/features/views#planned-payments]] — Planned payments page
- [[docs/api/plannedTransactions]] — Planned transactions API
