# Raw Transaction Architecture - Quick Reference

## 🏗️ Architecture Summary

```
CSV Import → Bank-Specific Raw Table → Normalized Transaction → API Response
              (with deduplication)       (linked via reference)
```

## 📋 New Tables

| Table                        | Purpose                | Key Fields                                                   |
|------------------------------|------------------------|--------------------------------------------------------------|
| `belfius_raw_transactions`   | Belfius raw CSV data   | account_number, transaction_date, amount, deduplication_hash |
| `revolut_raw_transactions`   | Revolut raw CSV data   | product, completed_date, amount, deduplication_hash          |
| `kbc_raw_transactions`       | KBC raw CSV data       | account_number, transaction_date, amount, deduplication_hash |
| `transaction_raw_references` | Links normalized ↔ raw | transaction_id, raw_source_type, raw_source_id               |

## 🔧 Key Components

### Services

- `RawTransactionImportService` - Main import orchestration
- `RawTransactionDeduplicationService` - Hash-based duplicate detection
- `RecipientService` - Recipient management (unchanged)

### Repositories

- `BelfiusRawTransactionRepository` - Belfius raw data access
- `RevolutRawTransactionRepository` - Revolut raw data access
- `KBCRawTransactionRepository` - KBC raw data access
- `TransactionRepository` - Normalized transactions (unchanged)

### Models

- `BelfiusRawTransaction` - Belfius raw transaction model
- `RevolutRawTransaction` - Revolut raw transaction model
- `KBCRawTransaction` - KBC raw transaction model
- `TransactionRawReference` - Raw ↔ normalized link
- `Transaction` - Normalized transaction (modified: removed raw fields)

## 🚀 Quick Start

### Run Migration

```bash
# Backup first!
cp financial_transactions.db financial_transactions.db.backup

# Run migration
python utils/migrate_to_raw_transactions.py
```

### Test Import

```bash
curl -X POST "http://localhost:8000/api/import/csv?bank_name=revolut" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@transactions.csv"
```

### Query Raw Transactions

```python
from database.connection import get_session
from repositories.raw_transaction_repositories import RevolutRawTransactionRepository

db = get_session()
repo = RevolutRawTransactionRepository(db)

# Get by batch
raw_txns = repo.find_by_batch(batch_id=1)

# Get by date range
raw_txns = repo.find_by_product_and_date_range(
    product="Current",
    start_date=date(2024, 1, 1),
    end_date=date(2024, 12, 31)
)

# Get latest balance
balance = repo.get_latest_balance(product="Current")
```

## 📊 Data Flow

### Import Flow

```python
1. Upload CSV file
   ↓
2. BankAdapter.parse_csv() → List[TransactionData]
   ↓
3. For each transaction:
   a. Check duplicate: RawDeduplicationService.is_duplicate()
   b. Store raw: BankRawRepository.create()
   c. Create normalized: Transaction()
   d. Link: TransactionRawReference()
   ↓
4. Commit all changes
   ↓
5. Return import results
```

### Deduplication Flow

```python
1. Compute hash: SHA256(raw_csv_line)
   ↓
2. Query: SELECT id FROM {bank}_raw_transactions 
          WHERE deduplication_hash = ?
   ↓
3. Return: exists (bool)
```

## 🎯 Use Cases

### Get Raw Transaction Details

```python
# Via normalized transaction
transaction = txn_repo.get_by_id(transaction_id)

# Get the raw reference
raw_ref = db.query(TransactionRawReference).filter(
    TransactionRawReference.transaction_id == transaction_id
).first()

if raw_ref.raw_source_type == 'revolut':
    raw_txn = revolut_repo.find_by_id(raw_ref.raw_source_id)
    print(f"Original CSV: {raw_txn.raw_csv_line}")
```

### Calculate Account Balance

```python
# Get all raw transactions for account
raw_txns = belfius_repo.find_by_account_and_date_range(
    account_number="BE61734041478017",
    start_date=date(2024, 1, 1),
    end_date=date(2024, 12, 31)
)

# Calculate running balance
balance = 0.0
for txn in raw_txns:
    balance += float(txn.amount)
```

### Check for Duplicate Before Import

```python
from services.raw_transaction_deduplication_service import RawTransactionDeduplicationService

dedup_service = RawTransactionDeduplicationService(db)

raw_csv_line = "2024-01-15,Card Payment,Current,..."
is_duplicate = dedup_service.is_duplicate('revolut', raw_csv_line)

if is_duplicate:
    print("Transaction already imported")
```

## 🔍 Debugging

### Check Migration Status

```python
from sqlalchemy import inspect
from database.connection import get_engine

engine = get_engine()
inspector = inspect(engine)

# Check tables exist
tables = inspector.get_table_names()
assert 'belfius_raw_transactions' in tables
assert 'revolut_raw_transactions' in tables
assert 'kbc_raw_transactions' in tables
assert 'transaction_raw_references' in tables

# Check columns removed
columns = [col['name'] for col in inspector.get_columns('transactions')]
assert 'original_raw_data' not in columns
assert 'bank_reference' not in columns
```

### Verify Data Integrity

```python
# Count transactions
txn_count = db.query(Transaction).count()

# Count raw transactions
belfius_count = db.query(BelfiusRawTransaction).count()
revolut_count = db.query(RevolutRawTransaction).count()
kbc_count = db.query(KBCRawTransaction).count()

# Count references
ref_count = db.query(TransactionRawReference).count()

print(f"Transactions: {txn_count}")
print(f"Raw (total): {belfius_count + revolut_count + kbc_count}")
print(f"References: {ref_count}")
```

### Check Deduplication

```python
# Get all hashes for a batch
batch_id = 1
raw_txns = revolut_repo.find_by_batch(batch_id)

hashes = [txn.deduplication_hash for txn in raw_txns]
print(f"Total: {len(hashes)}")
print(f"Unique: {len(set(hashes))}")  # Should be equal
```

## ⚠️ Important Notes

### Immutability

Raw transaction tables are **append-only**. Never update or delete raw records.

### Backward Compatibility

Existing transactions (imported before migration) will NOT have raw references.
This is expected and they will continue to work normally.

### Balance Calculation

For new imports, balance can be calculated from raw tables.
For old transactions, use the `balance` field in `Transaction` table.

### Deduplication

Deduplication now happens at raw table level, preventing duplicate raw imports.
This is more accurate than the old normalized-level deduplication.

## 🛠️ Common Tasks

### Add Support for New Bank

1. Create model in `database/raw_transaction_models.py`
2. Create repository in `repositories/raw_transaction_repositories.py`
3. Add parsing logic in `services/raw_transaction_import_service.py`
4. Create adapter in `services/bank_adapters.py` (if needed)
5. Add to deduplication service
6. Run migration to create table

### Export Raw CSV

```python
# Get raw transaction
raw_txn = revolut_repo.find_by_hash(deduplication_hash)

# Export to CSV
with open('export.csv', 'w') as f:
    f.write(raw_txn.raw_csv_line + '\n')
```

### Bulk Import Check

```python
# Check if CSV already imported
csv_lines = read_csv_file('transactions.csv')
duplicates = []

for line in csv_lines:
    if dedup_service.is_duplicate('revolut', line):
        duplicates.append(line)

print(f"Found {len(duplicates)} duplicate lines")
```

## 📈 Performance Tips

1. **Batch Processing**: Import uses single transaction for all rows
2. **Index Usage**: Queries use optimized indexes on date, account, hash
3. **Connection Pooling**: Use SQLAlchemy session pooling
4. **Caching**: Consider caching balance calculations

## 🐛 Troubleshooting

| Issue                   | Solution                                    |
|-------------------------|---------------------------------------------|
| Migration fails         | Restore backup, check logs                  |
| Import fails            | Check bank name matches supported banks     |
| Duplicates not detected | Verify hash computation, check raw_csv_line |
| Missing raw reference   | Expected for pre-migration transactions     |
| Performance slow        | Check indexes, use date range filters       |

## 📚 Documentation

- **Architecture**: `docs/architecture/raw_transaction_overhaul.md`
- **Migration Guide**: `docs/RAW_TRANSACTION_MIGRATION_GUIDE.md`
- **API Docs**: OpenAPI/Swagger at `/docs`

## ✅ Checklist

Pre-migration:

- [ ] Backup database
- [ ] Review architecture docs
- [ ] Test on development environment

Migration:

- [ ] Run migration script
- [ ] Verify tables created
- [ ] Check columns removed

Post-migration:

- [ ] Test CSV import
- [ ] Verify deduplication works
- [ ] Check API responses
- [ ] Monitor performance
- [ ] Update tests

## 🎓 Key Concepts

### Discriminator Pattern

`TransactionRawReference` uses a discriminator pattern:

- `raw_source_type`: Bank identifier ('belfius', 'revolut', 'kbc')
- `raw_source_id`: ID in the bank-specific table

This allows flexible linking without complex foreign keys.

### Hash-Based Deduplication

Each raw transaction has a SHA256 hash of the complete CSV line.
This ensures exact duplicate detection at the source level.

### Append-Only Tables

Raw tables never update, only insert. This preserves complete audit trail.

### Balance Integrity

Balances calculated from raw tables match the original CSV exactly.

---

**Need help?** Check the full migration guide or review the architecture documentation.

