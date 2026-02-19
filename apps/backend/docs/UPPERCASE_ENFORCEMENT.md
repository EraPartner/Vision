"""
UPPERCASE ENFORCEMENT DOCUMENTATION
====================================

This document describes how uppercase normalization is enforced throughout the system
for recipient names, addresses, transaction memos, and bank accounts.

EXCEPTION: Transaction and PlannedTransaction 'comment' fields preserve original case.

## 1. DATABASE LAYER - SQLAlchemy Event Listeners

All text fields (except comments) are automatically normalized to UPPERCASE when data
is inserted or updated via SQLAlchemy ORM.

Location: `database/models.py`

### Transaction Fields

- `Transaction.memo` → AUTO-UPPERCASE
- `Transaction.currency` → AUTO-UPPERCASE
- `Transaction.bank_account` → AUTO-UPPERCASE
- `Transaction.comment` → PRESERVED (original case)

### Recipient Fields

- `Recipient.name` → AUTO-UPPERCASE (with URL preservation)
- `Recipient.address` → AUTO-UPPERCASE (with URL preservation)

### PlannedTransaction Fields

- `PlannedTransaction.memo` → AUTO-UPPERCASE
- `PlannedTransaction.currency` → AUTO-UPPERCASE
- `PlannedTransaction.bank_account` → AUTO-UPPERCASE
- `PlannedTransaction.comment` → PRESERVED (original case)

### Category Fields

- `Category.general` → AUTO-UPPERCASE
- `Category.detail` → AUTO-UPPERCASE

### URL Preservation

Event listeners detect URLs and preserve their original case:

- Full URLs: `www.example.com`, `https://example.com`
- URLs in text: "Visit www.test.com today" → "VISIT www.test.com TODAY"
- Domain patterns: `example.com`, `subdomain.example.co.uk`

## 2. IMPORT LAYER - Bank Adapters

All bank adapters normalize data to UPPERCASE before creating TransactionData objects.
This ensures consistent hashing for duplicate detection.

Location: `services/bank_adapters.py`

### BelfiusAdapter

```python
# Recipient name normalized
full_recipient = TextNormalizationService.clean_recipient_name(recipient)
full_recipient = TextNormalizationService.normalize_recipient_name(full_recipient)

# Memo normalized
memo = TextNormalizationService.normalize_recipient_name(memo)

# Bank account already uppercase
bank_account = "BELFIUS CHECKING ACCOUNT"
```

### RevolutAdapter

```python
# Recipient name normalized
cleaned_description = TextNormalizationService.clean_recipient_name(description)
cleaned_description = TextNormalizationService.normalize_recipient_name(cleaned_description)

# Memo normalized
memo = TextNormalizationService.normalize_recipient_name(f"{transaction_type} - {product}")

# Bank account already uppercase
bank_account = "REVOLUT"
```

### KBCAdapter

```python
# Recipient name normalized (address kept separate)
final_recipient = TextNormalizationService.clean_kbc_recipient_name(recipient_name)
final_recipient = TextNormalizationService.normalize_recipient_name(final_recipient)

# Memo normalized
memo = TextNormalizationService.normalize_recipient_name(memo)

# Bank account normalized
account_type = TextNormalizationService.normalize_recipient_name(account_type)
```

## 3. SERVICE LAYER - Recipient Management

Location: `services/recipient_service.py`

### create_or_get_recipient()

Accepts `name`, `account_number`, and `address` parameters.
Event listeners automatically normalize name and address to uppercase when saved.

```python
recipient = Recipient(
    name=name,  # Will be normalized via event listener
    account_number=account_number,
    address=address,  # Will be normalized via event listener
    is_active=True
)
```

### Address Enrichment

If a recipient exists without an address and one is provided, it will be updated:

```python
if address and not recipient.address:
    recipient.address = address  # Will be normalized via event listener
```

## 4. REPOSITORY LAYER - Lookups & Searches

Location: `repositories/recipient_repository.py`

### Exact Match Lookups

`get_by_name(name)` uses exact equality:

```python
Recipient.name == name  # Both are uppercase, exact match works
```

### Partial Match Searches

`get_all_active(name="partial")` uses case-insensitive ILIKE:

```python
Recipient.name.ilike(f"%{name}%")  # Case-insensitive partial match
```

This works correctly because:

1. All stored names are uppercase
2. ILIKE is case-insensitive
3. Search term can be any case and will match

## 5. DUPLICATE DETECTION

Location: `services/deduplication_service.py`

### Hash Generation

Duplicate detection uses SHA256 hashing of transaction data:

1. **Primary**: Hash of `raw_data` from CSV (exact line from file)
2. **Fallback**: Hash of normalized fields when raw_data unavailable:
   ```python
   hash_string = (
       f"{transaction_data.date.isoformat()}|"
       f"{transaction_data.amount}|"
       f"{transaction_data.recipient}|"  # Already uppercase from adapter
       f"{transaction_data.memo or ''}"  # Already uppercase from adapter
   )
   ```

Since bank adapters normalize recipient names and memos to uppercase BEFORE creating
TransactionData, the fallback hash is consistent even if raw_data differs slightly.

## 6. API LAYER - Input Validation

Location: `api/api_routes_recipients.py`, `api/api_schemas.py`

### Pydantic Validators

Input data is validated and normalized via Pydantic model validators:

```python
@field_validator('name', 'address', mode='before')
def normalize_to_uppercase(cls, value: Optional[str]) -> Optional[str]:
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_recipient_name(value)
    return value
```

This provides an additional layer of normalization at the API boundary.

## 7. MIGRATION HISTORY

### migrate_recipient_addresses.py

Extracts addresses from recipient names that had addresses embedded (comma-separated).

### migrate_all_to_uppercase.py

Migrated all existing data to uppercase:

- 336 recipients (names and addresses)
- 3,486 transactions (memo, currency, bank_account)
- 2 planned transactions (memo, currency, bank_account)
- 0 categories (already uppercase)

**Total: 3,824 records migrated**

## 8. TESTING & VERIFICATION

To verify uppercase enforcement is working:

1. Create a test recipient with lowercase:
   ```python
   recipient = Recipient(name='test recipient', address='123 main st')
   session.add(recipient)
   session.commit()
   session.refresh(recipient)
   # recipient.name == 'TEST RECIPIENT'
   # recipient.address == '123 MAIN ST'
   ```

2. Test URL preservation:
   ```python
   recipient = Recipient(name='www.example.com')
   session.add(recipient)
   session.commit()
   session.refresh(recipient)
   # recipient.name == 'www.example.com' (preserved)
   ```

3. Test duplicate detection with mixed case:
   ```python
   # These will be detected as duplicates because names are normalized
   recipient1 = service.create_or_get_recipient('John Smith')
   recipient2 = service.create_or_get_recipient('JOHN SMITH')
   # recipient1.id == recipient2.id
   ```

## 9. KEY DESIGN DECISIONS

1. **Normalization at Multiple Layers**: Defense in depth approach
    - Bank adapters normalize during import
    - Event listeners normalize before database write
    - Pydantic validators normalize at API boundary

2. **URL Preservation**: URLs are detected via regex and preserved
    - Pattern: `(?:https?://)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:/[^\s]*)?`
    - Full URL check: starts with http://, https://, www., or matches domain.tld

3. **Comment Field Exception**: Original case preserved for user notes
    - `Transaction.comment` - NOT normalized
    - `PlannedTransaction.comment` - NOT normalized

4. **Consistent Hashing**: Normalization before TransactionData creation ensures
   consistent duplicate detection even when raw CSV data has minor variations.

5. **Case-Insensitive Search**: Using ILIKE ensures searches work regardless of
   input case, even though all stored data is uppercase.

## 10. MAINTENANCE NOTES

When adding new text fields:

1. Add event listener in `database/models.py` if field should be uppercase
2. Normalize in bank adapters if used for duplicate detection
3. Add Pydantic validator if exposed via API
4. Update this documentation

When adding new bank adapters:

1. Use `TextNormalizationService.normalize_recipient_name()` for all text fields
2. Keep addresses separate from recipient names
3. Do NOT normalize comment fields
4. Ensure raw_data is preserved for accurate hashing
   """

