# Raw Transaction Architecture Migration Guide

## Overview

This guide covers the migration from the old architecture (mixed raw/normalized data) to the new architecture (
bank-specific raw transaction tables with normalized transaction references).

## Architecture Changes

### Before (Old Architecture)

```
┌─────────────────────────────┐
│      transactions           │
│  ┌──────────────────────┐   │
│  │ Normalized fields    │   │
│  │ + original_raw_data  │   │
│  │ + bank_reference     │   │
│  └──────────────────────┘   │
└─────────────────────────────┘
         Mixed concerns
```

### After (New Architecture)

```
┌──────────────────────────────────────┐
│   Bank-Specific Raw Tables           │
│  ┌────────────────────────────────┐  │
│  │ belfius_raw_transactions       │  │
│  │ revolut_raw_transactions       │  │
│  │ kbc_raw_transactions           │  │
│  │  - Exact CSV structure         │  │
│  │  - Immutable (append-only)     │  │
│  │  - Deduplication hash          │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
            │
            │ linked via
            ▼
┌──────────────────────────────────────┐
│  transaction_raw_references          │
│  - transaction_id                    │
│  - raw_source_type (discriminator)   │
│  - raw_source_id                     │
└──────────────────────────────────────┘
            │
            │ references
            ▼
┌──────────────────────────────────────┐
│      transactions (normalized)       │
│  - Core fields only                  │
│  - No raw data                       │
│  - No dedup hash                     │
└──────────────────────────────────────┘
     Clean separation of concerns
```

## Benefits

1. **Immutable Source of Truth**: Raw CSV data never changes
2. **Bank-Specific Fields**: Each bank can have custom fields without pollution
3. **Efficient Deduplication**: Check at source level before normalization
4. **Audit Trail**: Complete history preserved exactly as imported
5. **Balance Calculation**: Calculate from raw tables (accurate to CSV)
6. **Clean Architecture**: Separation of concerns (raw vs. normalized)

## Migration Steps

### Step 1: Backup Your Database

**CRITICAL: Always backup before migration!**

```bash
# SQLite
cp financial_transactions.db financial_transactions.db.backup

# PostgreSQL
pg_dump -U your_user -d your_database > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Step 2: Run the Migration Script

```bash
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend

# Run migration
python utils/migrate_to_raw_transactions.py

# If you need to rollback (only PostgreSQL)
python utils/migrate_to_raw_transactions.py --rollback
```

The migration will:

1. Create new raw transaction tables
2. Create transaction_raw_references table
3. Remove `original_raw_data` and `bank_reference` columns from `transactions`

### Step 3: Verify Migration

```bash
# Check that new tables exist
python utils/check_database.py
```

Expected output:

```
✓ belfius_raw_transactions table exists
✓ revolut_raw_transactions table exists
✓ kbc_raw_transactions table exists
✓ transaction_raw_references table exists
✓ transactions table updated (columns removed)
```

### Step 4: Update Your Code

The API endpoints have been automatically updated to use `RawTransactionImportService`.

**No changes needed to existing API clients** - the endpoints remain the same:

- `POST /api/import/csv`
- `POST /api/import/csv/custom`
- `GET /api/import/batches`
- `GET /api/import/batches/{batch_id}`

### Step 5: Test Import

Test with a small CSV file first:

```bash
curl -X POST "http://localhost:8000/api/import/csv?bank_name=revolut" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@test_transactions.csv"
```

Expected response:

```json
{
  "batch_id": "1",
  "total_processed": 10,
  "imported": 10,
  "duplicates": 0,
  "errors": 0,
  "status": "completed",
  "links": [
    ...
  ]
}
```

### Step 6: Verify Data Flow

Check that data flows correctly:

```python
from database.connection import get_session
from repositories.raw_transaction_repositories import RevolutRawTransactionRepository

db = get_session()
repo = RevolutRawTransactionRepository(db)

# Check raw transactions were created
raw_txns = repo.find_by_batch(batch_id=1)
print(f"Found {len(raw_txns)} raw transactions")

# Check they're linked to normalized transactions
for raw_txn in raw_txns:
    print(f"Raw ID: {raw_txn.id}, Hash: {raw_txn.deduplication_hash[:16]}...")
```

## Data Flow

### Import Process

```
1. CSV Upload
   ↓
2. Parse via Bank Adapter (TransactionData)
   ↓
3. Check Duplicate (raw table hash lookup)
   ↓ (if not duplicate)
4. Store in Bank-Specific Raw Table
   ↓
5. Create Normalized Transaction
   ↓
6. Link via TransactionRawReference
   ↓
7. Commit Transaction
```

### Deduplication

```
Old Way:
Transaction.bank_reference hash check
→ Mixed with normalized data

New Way:
Raw table deduplication_hash check
→ Source-level prevention
→ Cleaner separation
```

## Rollback Procedure

### PostgreSQL

```bash
# Rollback adds columns back
python utils/migrate_to_raw_transactions.py --rollback

# Restore old service (manual)
# Edit api/api_routes_import.py
# Change: RawTransactionImportService → TransactionImportService
```

### SQLite

SQLite doesn't support ADD COLUMN in all cases. Best approach:

```bash
# Restore from backup
cp financial_transactions.db.backup financial_transactions.db

# Revert code changes manually
```

## Troubleshooting

### Issue: Migration fails with "table already exists"

**Solution:** Tables were partially created. Either:

1. Drop tables manually and re-run
2. The migration script uses `checkfirst=True`, so this should be safe

```sql
-- Drop tables if needed
DROP TABLE IF EXISTS transaction_raw_references;
DROP TABLE IF EXISTS belfius_raw_transactions;
DROP TABLE IF EXISTS revolut_raw_transactions;
DROP TABLE IF EXISTS kbc_raw_transactions;
```

### Issue: Import fails with "unsupported bank type"

**Solution:** Check bank name matches:

- `belfius` or `Belfius`
- `revolut` or `Revolut`
- `kbc` or `KBC`

### Issue: Duplicates not detected

**Solution:** Check deduplication hash generation:

```python
from services.raw_transaction_deduplication_service import RawTransactionDeduplicationService

# Verify hash computation
raw_csv_line = "your,csv,line,here"
hash_value = RawTransactionDeduplicationService.compute_hash(raw_csv_line)
print(f"Hash: {hash_value}")
```

### Issue: Existing transactions don't have raw references

**Solution:** This is expected. Existing transactions won't have raw references until:

1. You re-import the original CSV files, or
2. You write a migration script to backfill (optional)

Existing transactions continue to work normally without raw references.

## Performance Considerations

### Indexes

The new tables have optimized indexes:

```sql
-- Belfius
CREATE INDEX idx_belfius_account_date ON belfius_raw_transactions (account_number, transaction_date);
CREATE INDEX idx_belfius_batch_hash ON belfius_raw_transactions (import_batch_id, deduplication_hash);

-- Revolut
CREATE INDEX idx_revolut_product_date ON revolut_raw_transactions (product, completed_date);
CREATE INDEX idx_revolut_state ON revolut_raw_transactions (state);

-- KBC
CREATE INDEX idx_kbc_account_date ON kbc_raw_transactions (account_number, transaction_date);
CREATE INDEX idx_kbc_statement ON kbc_raw_transactions (statement_number);
```

### Query Optimization

For balance calculation from raw tables:

```python
# Efficient query with indexes
raw_txns = repo.find_by_account_and_date_range(
    account_number="BE61734041478017",
    start_date=date(2024, 1, 1),
    end_date=date(2024, 12, 31)
)

# Calculate running balance
balance = 0.0
for txn in raw_txns:
    balance += float(txn.amount)
    print(f"{txn.transaction_date}: {balance}")
```

## API Compatibility

### No Breaking Changes

All existing API endpoints work identically:

```bash
# Standard import (unchanged)
POST /api/import/csv?bank_name=revolut

# Custom import (unchanged)
POST /api/import/csv/custom

# Get batches (unchanged)
GET /api/import/batches

# Get specific batch (unchanged)
GET /api/import/batches/{batch_id}
```

### Response Format (unchanged)

```json
{
  "batch_id": "123",
  "total_processed": 150,
  "imported": 145,
  "duplicates": 5,
  "errors": 0,
  "status": "completed",
  "links": [
    ...
  ]
}
```

## Future Enhancements

### Add New Banks

To add support for a new bank:

1. **Create raw transaction model**
   ```python
   # database/raw_transaction_models.py
   class NewBankRawTransaction(Base):
       __tablename__ = "newbank_raw_transactions"
       # Define fields matching CSV structure
   ```

2. **Create repository**
   ```python
   # repositories/raw_transaction_repositories.py
   class NewBankRawTransactionRepository:
       # Implement CRUD methods
   ```

3. **Update import service**
   ```python
   # services/raw_transaction_import_service.py
   def _store_newbank_raw(self, ...):
       # Implement bank-specific storage
   ```

4. **Create bank adapter** (if not exists)
   ```python
   # services/bank_adapters.py
   class NewBankAdapter(BaseBankAdapter):
       # Implement CSV parsing
   ```

### Balance Calculation Service

Future enhancement: Create a dedicated service for calculating balances from raw tables.

```python
# services/balance_calculation_service.py
class BalanceCalculationService:
    def calculate_account_balance(self, bank_type, account_identifier):
        # Query raw table
        # Calculate running balance
        # Cache result
        pass
```

## Testing

### Unit Tests

Tests need updating to use the new service:

```python
# tests/test_import.py
from services.raw_transaction_import_service import RawTransactionImportService


def test_import_csv(db_session):
    service = RawTransactionImportService(db_session)
    result = service.import_csv("test.csv", "revolut")
    assert result['status'] == 'completed'
```

### Integration Tests

Test the complete flow:

```python
def test_full_import_flow(client, db_session):
    # Upload CSV
    response = client.post(
        "/api/import/csv?bank_name=revolut",
        files={"file": ("test.csv", csv_content)}
    )
    assert response.status_code == 201

    # Verify raw transaction created
    from repositories.raw_transaction_repositories import RevolutRawTransactionRepository
    repo = RevolutRawTransactionRepository(db_session)
    raw_txns = repo.find_by_batch(response.json()['batch_id'])
    assert len(raw_txns) > 0

    # Verify normalized transaction created
    # Verify link exists
```

## Monitoring

### Key Metrics

Monitor these metrics post-migration:

1. **Import Success Rate**: Should remain stable
2. **Duplicate Detection Rate**: Should improve (more accurate)
3. **Import Duration**: May be slightly slower (extra table writes)
4. **Storage Usage**: Will increase (raw data preserved)

### Logging

Enhanced logging is included:

```python
logger.info("Raw transaction import", extra={
    "batch_id": batch_id,
    "bank_type": bank_type,
    "imported": count,
    "duplicates": dup_count
})
```

## Support

For issues or questions:

1. Check troubleshooting section above
2. Review logs: Check application logs for detailed error messages
3. Verify database state: Use `check_database.py` utility
4. Restore from backup if needed

## Conclusion

This migration provides a robust, scalable foundation for managing financial transaction imports with proper separation
of concerns and immutable source data preservation.

**Key Takeaways:**

- ✅ Raw CSV data preserved exactly as imported
- ✅ Bank-specific fields supported without schema pollution
- ✅ Efficient deduplication at source level
- ✅ Clean separation of concerns
- ✅ Backward compatible API
- ✅ Existing transactions continue to work

**Next Steps:**

1. Backup database ✓
2. Run migration ✓
3. Test imports ✓
4. Monitor performance ✓
5. Update tests ✓

