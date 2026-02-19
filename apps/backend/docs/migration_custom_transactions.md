# Database Migration: Add Custom Transaction Support

## Date: 2026-02-19

## Overview

Added support for custom user-created transactions in the existing `transactions` table, maintaining a unified
transaction model while distinguishing between imported and manually-entered data.

## Schema Changes

### Modified Table: `transactions`

**Added Column:**

- `source_type` (VARCHAR(20), NOT NULL, DEFAULT 'import', INDEXED)
    - Values: 'import' | 'custom'
    - Distinguishes between bank-imported transactions and user-created transactions
    - Default value 'import' maintains backward compatibility with existing data

## Migration Strategy

### For Existing Installations:

1. **Add the column with default value:**
   ```sql
   ALTER TABLE transactions 
   ADD COLUMN source_type VARCHAR(20) NOT NULL DEFAULT 'import';
   ```

2. **Create index for performance:**
   ```sql
   CREATE INDEX idx_transactions_source_type ON transactions(source_type);
   ```

3. **Update existing records (optional, as default handles this):**
   ```sql
   UPDATE transactions 
   SET source_type = 'import' 
   WHERE source_type IS NULL OR source_type = '';
   ```

### For Fresh Installations:

No migration needed - the column is created automatically with the model definition.

## API Changes

### Updated Schemas:

- **TransactionCreate**: Added `source_type` field (default: 'custom')
- **TransactionResponse**: Added `source_type` field in responses

### Updated Endpoints:

**POST /api/transactions**

- Now accepts `source_type` in request body
- Default is 'custom' for user-created transactions
- Import processes should explicitly set `source_type='import'`

**GET /api/transactions**

- New query parameter: `source_type` to filter by transaction source
- Example: `GET /api/transactions?source_type=custom` returns only user-created transactions

## Usage Examples

### Creating a Custom Transaction (from UI):

```json
POST /api/transactions
{
  "date": "2026-02-19",
  "bank_account": "Revolut",
  "recipient_id": 5,
  "amount": 25.50,
  "currency": "EUR",
  "memo": "Coffee purchase",
  "category_id": 3,
  "source_type": "custom"
}
```

### Creating an Imported Transaction (from CSV):

```json
POST /api/transactions
{
  "date": "2026-02-19",
  "bank_account": "Belfius",
  "recipient_id": 10,
  "amount": 150.00,
  "currency": "EUR",
  "batch_id": 42,
  "bank_reference": "TXN-2026-001234",
  "source_type": "import"
}
```

### Filtering Transactions:

```bash
# Get only custom transactions
GET /api/transactions?source_type=custom

# Get only imported transactions from a specific bank
GET /api/transactions?source_type=import&bank_account=revolut

# Get all transactions (no filter)
GET /api/transactions
```

## Benefits

1. **Unified Model**: Single `transactions` table for all transaction data
2. **Clear Distinction**: `source_type` field clearly identifies origin
3. **Backward Compatible**: Existing transactions default to 'import'
4. **Flexible Filtering**: Easy to query by source type
5. **Audit Trail**: Clear tracking of manually-entered vs. imported data

## Notes

- The `batch_id` field naturally remains NULL for custom transactions
- Raw transaction tables (belfius_raw_transactions, revolut_raw_transactions, kbc_raw_transactions) are unaffected
- Custom transactions do not require `bank_reference` or `original_raw_data` fields
- Duplicate checking logic respects source_type (only checks imports)

## Rollback Instructions

If rollback is needed:

```sql
-- Remove index
DROP INDEX IF EXISTS idx_transactions_source_type;

-- Remove column
ALTER TABLE transactions DROP COLUMN source_type;
```

Note: This will lose the distinction between imported and custom transactions, but no data will be lost.

