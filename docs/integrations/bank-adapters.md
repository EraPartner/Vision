---
title: Integration - Bank Adapters
type: integration
description: Bank API integrations for CSV imports
date: 2026-04-25
updated: 2026-04-25
tags: [integration, bank, csv, import]
status: active
related_code: [[apps/node-backend/src/services/bankAdapters.js]]
---

# Integration: Bank Adapters

## Overview

Bank adapters parse CSV files from various banks into a normalized transaction format.

## Architecture

Each bank adapter:
1. Parses bank-specific CSV format
2. Normalizes to common transaction structure
3. Generates deduplication hash
4. Returns standardized transaction data

## Supported Banks

### Belfius
- **Fields**: transaction_date, amount, recipient_name, recipient_account, balance
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Features**: Full transaction details including BIC and location

### Revolut
- **Fields**: completed_date, amount, fee, currency, state
- **Date Format**: ISO 8601
- **States**: COMPLETED, PENDING, REVERTED, DECLINED
- **Features**: Multi-currency support, fees tracking

### KBC
- **Fields**: transaction_date, amount, counterparty_name, structured_communication
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Features**: Belgian structured communications (OCR)

### SABB
- **Fields**: transaction_date, posting_date, description, amount
- **Date Format**: DD/MM/YYYY
- **Features**: Posting date vs transaction date

### Wise
- **Fields**: finished_on, source_amount, target_amount, exchange_rate, fee
- **Date Format**: ISO 8601
- **Features**: Multi-currency with exchange rates

### Vision (Internal)
- **Fields**: date, recipient, memo, amount
- **Purpose**: Internal format for manual entry

### Custom
- **Purpose**: User-defined column mapping
- **Configuration**: Date format, column names, separator
- **Date Parsing (2026-04-25)**: Generic adapter now uses `Date.UTC()` with explicit numeric components for all date formats, eliminating timezone-dependent parsing of unpadded dates (e.g., `5/1/2025`). This ensures dates are parsed consistently regardless of the server's local timezone, preventing off-by-one date shifts during import.

## Adding New Banks

1. Create parser in `apps/node-backend/src/services/bankAdapters.js`
2. Register in `getSupportedBanks()`
3. Handle all edge cases (missing fields, date formats)

## Field Mapping

Each adapter maps to standard transaction:
```javascript
{
  date: Date,
  amount: Number,
  recipient: String,
  memo: String,
  bankAccount: String,
  currency: String,
  balance: Number
}
```

## Related

- [[docs/api/imports|API: Imports]]
- [[docs/features/import|Feature: Import & Deduplication]]
