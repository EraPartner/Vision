---
title: Bank Reconciliation
type: feature
status: active
date: 2026-04-24
tags: [feature, bank-reconciliation, statements, matching, phase-6, database]
aliases: [reconciliation, statement-reconciliation, bank-statements, match-transactions, recon]
description: Match bank statement entries to recorded transactions using scoring-based auto-match with manual override capability
related_code:
  - apps/node-backend/src/routes/reconciliation.js
  - apps/node-backend/src/repositories/reconciliationRepository.js
  - apps/frontend/src/pages/ReconciliationPage.tsx
  - apps/frontend/src/lib/api/reconciliation.ts
  - alembic/versions/0007_bank_reconciliation.py
---

# Bank Reconciliation

Vision's bank reconciliation feature helps verify that recorded transactions match actual bank statements, ensuring data integrity and catching discrepancies early.

## Overview

Bank reconciliation compares transactions in Vision with entries from your bank statement. The system:

1. **Imports statement entries** from your bank (manual entry supported)
2. **Auto-matches** entries to transactions using scoring heuristics
3. **Allows manual overrides** for entries the algorithm can't confidently match
4. **Tracks match status** (unmatched, auto, confirmed, manual, ignored)

This feature is essential for:
- Verifying data accuracy after imports
- Finding missing or duplicate transactions
- Detecting bank errors or fraudulent activity
- Confirming account balances at specific dates

## Key Concepts

### Bank Statement

A period-specific snapshot of account activity.

**Fields:**
- `bank_account` — IBAN or other account identifier (text, uppercase)
- `currency` — ISO 4217 code (default: EUR)
- `period_start` — Statement start date (YYYY-MM-DD)
- `period_end` — Statement end date (YYYY-MM-DD)
- `opening_balance` — Balance at period start (optional)
- `closing_balance` — Balance at period end (optional)
- `notes` — Free-form statement notes (e.g., bank name, reference)

### Reconciliation Entry

A single line item from a bank statement.

**Fields:**
- `entry_date` — Transaction date (YYYY-MM-DD)
- `description` — Bank-provided description
- `amount` — Transaction amount (negative for debits, positive for credits)
- `currency` — Entry currency (default: EUR; typically matches statement currency)
- `transaction_id` — Linked transaction ID (null if unmatched)
- `match_status` — One of: `unmatched`, `auto`, `confirmed`, `manual`, `ignored`
- `match_score` — Confidence score (0–100) from auto-match algorithm

### Match Status Values

| Status | Meaning |
|--------|---------|
| `unmatched` | No transaction linked yet |
| `auto` | Auto-match found a candidate (pending user confirmation) |
| `confirmed` | User confirmed the auto-match |
| `manual` | User manually linked a transaction |
| `ignored` | User marked entry as not needing a match (e.g., bank fee with no transaction) |

## Auto-Match Algorithm

The auto-match scorer evaluates each unmatched statement entry against eligible transactions to find the best match candidate(s).

### Scoring Factors

**Date proximity** (primary):
- Exact date match: +100
- Off by 1–2 days: +80
- Off by 3–7 days: +50
- Off by 8–14 days: +20
- Off by 15+ days: 0

**Amount match** (secondary):
- Exact match: +100
- Within 0.01%: +80
- Within 1%: +50
- Within 5%: +20
- Off by more: 0

**Description/memo match** (tertiary):
- Full word overlap in memo: +20 per word (capped)

**Final score:** Date score + Amount score + Description bonus, normalized to 0–100

### Matching Constraints

The algorithm considers only transactions that:
- Have the same currency (or are convertible via configured FX rates)
- Fall within the statement period (with 7-day grace for processing delays)
- Are not already matched to another statement entry (per statement)
- Have the same sign (debit/credit direction)

If multiple transactions score >= 75 (configurable threshold), the entry is marked `auto` for user review.

## Workflow

### 1. Create a Bank Statement

```http
POST /api/reconciliation/statements
Content-Type: application/json

{
  "bank_account": "BE62 1111 2222 3333",
  "currency": "EUR",
  "period_start": "2026-04-01",
  "period_end": "2026-04-30",
  "opening_balance": 5000.00,
  "closing_balance": 4250.50,
  "notes": "Argenta April statement"
}
```

### 2. Add Statement Entries

**Single entry:**
```http
POST /api/reconciliation/statements/:id/entries
Content-Type: application/json

{
  "entry_date": "2026-04-05",
  "description": "PAYMENT TO LANDLORD",
  "amount": -800.00,
  "currency": "EUR"
}
```

**Bulk entries:**
```http
POST /api/reconciliation/statements/:id/entries
Content-Type: application/json

{
  "entries": [
    { "entry_date": "2026-04-05", "description": "...", "amount": -800.00 },
    { "entry_date": "2026-04-10", "description": "...", "amount": 2500.00 }
  ]
}
```

### 3. Auto-Match Candidates

Fetch candidate transactions for a given entry:

```http
GET /api/reconciliation/statements/:statementId/entries/:entryId/candidates
```

Returns ordered list of matches by score, with full transaction details.

### 4. Confirm or Override Match

**Confirm auto-match:**
```http
POST /api/reconciliation/statements/:statementId/entries/:entryId/match
Content-Type: application/json

{
  "transaction_id": 42,
  "match_status": "confirmed"
}
```

**Manual match:**
```http
POST /api/reconciliation/statements/:statementId/entries/:entryId/match
Content-Type: application/json

{
  "transaction_id": 100,
  "match_status": "manual"
}
```

**Ignore entry** (no transaction needed):
```http
POST /api/reconciliation/statements/:statementId/entries/:entryId/match
Content-Type: application/json

{
  "match_status": "ignored"
}
```

### 5. Clear a Match

Unlink a transaction from an entry:

```http
DELETE /api/reconciliation/statements/:statementId/entries/:entryId/match
```

The entry reverts to `unmatched` status.

## Frontend UI

The Reconciliation page (`/reconciliation`) provides:

1. **Statement List** — All imported statements with entry count and match summary
2. **Statement Detail** — Entries table with:
   - Entry date, description, amount, currency
   - Match status badge (unmatched/auto/confirmed/manual/ignored)
   - Match score (if auto-matched)
   - Linked transaction details (if matched)
3. **Candidate Panel** — Sliding drawer showing auto-match candidates with:
   - Candidate transaction details (date, recipient, amount, memo)
   - Score breakdown (date, amount, description bonus)
   - Quick-confirm button
   - Manual search/select option

## Multi-Currency Support

Entries in foreign currencies are matched against transactions in the same currency. If a statement entry is in USD and an eligible transaction is in EUR, the system can optionally apply configured FX rates, but match scoring still prioritizes exact-currency matches.

## Best Practices

1. **Import statements regularly** — Don't let statements pile up; reconcile monthly or as statements arrive
2. **Review auto-matches** — Confirm auto-matches; don't blindly accept them
3. **Handle duplicates carefully** — If a transaction appears twice in Vision, mark one as ignored to avoid confusion
4. **Use notes** — Add statement notes for later reference (bank name, reference number)
5. **Balance checks** — Use opening/closing balances to verify statement integrity

## Related Features

- [[docs/features/import|CSV Import]] — Import transactions from bank CSVs
- [[docs/features/transactions|Transactions]] — Core transaction management
- [[docs/features/recipients|Recipients]] — Payee/payer management
- [[docs/api/reconciliation|Reconciliation API]] — Technical endpoint reference

## Architecture Notes

**Database schema:** [[alembic/versions/0007_bank_reconciliation.py]]

- `bank_statements` table — Statement headers
- `reconciliation_entries` table — Individual entries with FK to transactions

**Scoring heuristic:** Implemented in `reconciliationRepository.js` as pure logic, enabling easy testing and tuning of thresholds.

**Frontend:** React page with split pane layout using Radix UI components; utilizes TanStack Query for statement/entry management.
