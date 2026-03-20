---
title: Feature - CSV Import & Deduplication
type: feature
status: active
date: 2026-03-18
tags: [feature, import, csv, deduplication]
description: Import transactions from bank CSV files with automatic deduplication
related_code: ["apps/node-backend/src/services/deduplication.js", "apps/node-backend/src/services/importService.js", "apps/node-backend/src/routes/importRoutes.js"]
---

# Feature: CSV Import & Deduplication

## Overview

Vision provides comprehensive CSV import capabilities with support for multiple bank formats, automatic deduplication, and category detection.

## Supported Banks

### Pre-configured Bank Adapters
| Bank | Format | Fields |
|------|--------|--------|
| Belfius | Belgian bank format | Date, amount, recipient, balance |
| Revolut | Multi-currency | Type, state, amount, currency |
| KBC | Belgian corporate | Counterparty, structured communication |
| SABB | Belgian bank | Posting date, description |
| Wise | Multi-currency transfers | Transfer ID, exchange rate |
| Vision | Internal format | Standard transaction fields |
| Custom | User-defined | Configurable column mapping |

## Import Process

### 1. File Upload
- Maximum file size: 50MB
- Supported format: CSV
- Encoding: UTF-8 (configurable)

### 2. Parsing & Normalization
- CSV parsed with configurable separator
- Date formats converted to YYYY-MM-DD
- Amounts normalized (handle different decimal separators)
- Text normalized (trimming, encoding)

### 3. Deduplication
Uses SHA-256 hash of:
```
date|amount|recipient|memo|bank_account
```

Duplicate detection checks:
1. Hash comparison with existing raw transactions
2. Date + Amount + Recipient field matching
3. Bank-specific deduplication strategies

### 4. Category Detection
- Looks up recipient's default category
- Applies category if found
- Falls back to uncategorized if not

### 5. Transaction Creation
- Creates transactions in main table
- Links to raw source for audit trail
- Updates materialized views

## Deduplication Strategies

### SHA-256 Hash
Each raw transaction gets a unique hash stored in its respective bank-specific table:
- `belfius_raw_transactions.deduplication_hash`
- `revolut_raw_transactions.deduplication_hash`
- `kbc_raw_transactions.deduplication_hash`
- `sabb_raw_transactions.deduplication_hash`
- `wise_raw_transactions.deduplication_hash`
- `vision_raw_transactions.deduplication_hash`
- `custom_raw_transactions.deduplication_hash` - Custom CSV imports
- `manual_raw_transactions.deduplication_hash` - Manual entry deduplication

### Field-based Matching
For manual transactions, checks:
```sql
SELECT id FROM transactions 
WHERE date = $1 AND amount = $2 AND recipient_id = $3
AND is_active = true
```

### Duplicate Handling
- **Skipped**: Duplicate transactions are counted but not imported
- **Status**: Import result includes `duplicates_skipped` count

## Custom CSV Configuration

For unsupported banks, use custom import:

```
POST /api/import/csv/custom
```

**Storage**: Custom imports are stored in `custom_raw_transactions` table, which allows user-defined column mapping for any CSV format.

Parameters:
- `bank_name`: Custom identifier
- `date_format`: e.g., "DD/MM/YYYY", "MM/DD/YYYY"
- `date_column`: Column name containing date
- `recipient_column`: Column name for recipient
- `amount_column`: Column name for amount
- `memo_column`: Optional memo/description column

## Streaming Import

For large files, use streaming import with progress:

```
POST /api/import/csv/stream
```

Returns Server-Sent Events with progress:
```javascript
event: progress
data: {"processed": 50, "total": 150, "status": "processing"}

event: complete  
data: {"imported": 145, "duplicates_skipped": 5, "errors": 0}
```

## Raw Transaction Storage

Imported transactions are stored in raw tables:
- Original CSV line preserved
- Deduplication hash for future imports
- Links to normalized transactions

This allows:
- Re-import without duplicates
- Audit trail of original data
- Multiple bank account management

## Related

- [[docs/api/imports|API: Imports]]
- [[docs/api/transactions|API: Transactions]]
- [[docs/api/recipients|API: Recipients]]
