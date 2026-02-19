# Removal of `source_type` Field from Transactions

## Date

February 19, 2026

## Summary

The `source_type` field has been removed from the `Transaction` model as it was redundant. The presence or absence of a
`TransactionRawReference` record already definitively indicates whether a transaction is imported or custom.

## Rationale

### Previous Design

The `source_type` column stored either `'import'` or `'custom'` to distinguish between:

- **Imported transactions**: Created via bank CSV import
- **Custom transactions**: Manually created by users

### Problem

This design had several issues:

1. **Data Duplication**: The information was already available through the `TransactionRawReference` table
    - If a `TransactionRawReference` exists → transaction is imported
    - If no `TransactionRawReference` exists → transaction is custom

2. **Risk of Inconsistency**: The `source_type` field could become out of sync with reality
    - What if `source_type='import'` but no raw reference exists?
    - What if `source_type='custom'` but a raw reference does exist?

3. **Maintenance Overhead**:
    - Extra column to maintain and index
    - Additional parameter in all create methods
    - More complex queries when the relationship already provides the answer

### New Design

Transactions are now automatically classified by checking for the existence of a `TransactionRawReference`:

```python
# Check if transaction is imported
raw_ref = db.query(TransactionRawReference).filter(
    TransactionRawReference.transaction_id == transaction.id
).first()

is_imported = raw_ref is not None
is_custom = raw_ref is None
```

## Changes Made

### 1. Database Model

- **Removed**: `source_type` column from `Transaction` model
- **Migration needed**: Column must be dropped from database

### 2. API Schema

- **Removed**: `source_type` field from `TransactionCreate` schema
- **Updated**: Documentation to reflect automatic classification

### 3. Service Layer

- **Removed**: `source_type` parameter from `TransactionService.create()`
- **Removed**: `batch_id` parameter (also didn't exist in model)
- **Updated**: All docstrings and examples

### 4. Query/Filtering

- **Removed**: `source_type` parameter from query methods
- **Updated**: `TransactionQueryService.get_transactions()`
- **Updated**: `TransactionRepository.get_transactions()`
- **Updated**: `TransactionRepository.get_filtered_count()`

### 5. API Endpoints

- **Removed**: `source_type` query parameter from `GET /api/transactions`
- **Removed**: `source_type` from all API route handlers
- **Updated**: API documentation and examples

## Migration Guide

### For API Consumers

If you were filtering by `source_type`:

**Before:**

```bash
GET /api/transactions?source_type=import
GET /api/transactions?source_type=custom
```

**After:**
You can now query for imported vs custom transactions by checking the `TransactionRawReference` table directly, or by
using application-level logic:

```python
# Get all transactions
transactions = api.get_transactions()

# Filter imported transactions (have raw reference)
imported = [t for t in transactions if has_raw_reference(t.id)]

# Filter custom transactions (no raw reference)
custom = [t for t in transactions if not has_raw_reference(t.id)]
```

### For Database

A migration is needed to drop the column:

```sql
ALTER TABLE transactions DROP COLUMN source_type;
DROP INDEX IF EXISTS ix_transactions_source_type;
```

### For Code

If you have custom code that references `source_type`:

**Before:**

```python
transaction = Transaction(
    date=date.today(),
    bank_account="Revolut",
    recipient_id=5,
    amount=25.50,
    source_type='custom'  # ❌ No longer needed
)
```

**After:**

```python
transaction = Transaction(
    date=date.today(),
    bank_account="Revolut",
    recipient_id=5,
    amount=25.50
    # Classification is automatic based on TransactionRawReference
)
```

## Benefits

1. **Single Source of Truth**: The `TransactionRawReference` table is the definitive source
2. **No Risk of Inconsistency**: Cannot get out of sync since it's derived, not stored
3. **Simpler API**: One less parameter to think about
4. **Better Performance**: One less column to index and filter
5. **Cleaner Code**: Less code to maintain

## Impact

### Breaking Changes

- API consumers can no longer filter by `source_type` parameter
- Database migration required to drop column

### Non-Breaking

- The first balance calculation fix for Belfius/KBC imports is unaffected
- Raw transaction deletion is unaffected
- All other transaction functionality remains the same

## Related Issues

- Original balance calculation issue: Fixed in the same session
- Raw transaction deletion: Fixed in the same session

## Future Improvements

If filtering by import/custom becomes a common requirement, consider:

1. **View or Computed Column**: Create a database view that includes an `is_imported` flag
2. **API Helper Endpoint**: Add `GET /api/transactions/imported` and `GET /api/transactions/custom`
3. **Frontend Filter**: Handle the distinction in the frontend by checking for raw references

However, given that the current design properly handles the distinction through relationships, these improvements should
only be added if there's a demonstrated need.

