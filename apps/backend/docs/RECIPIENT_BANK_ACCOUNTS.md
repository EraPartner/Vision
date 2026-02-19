# Recipient Bank Account Many-to-Many Implementation

## Overview

This implementation solves the problem of duplicate recipients when banks format names differently (e.g., "JOHN SMITH"
vs "SMITH JOHN") by introducing:

1. **Normalized name matching** - Canonical name form prevents duplicates from word order variations
2. **Many-to-many relationship** - Recipients can have multiple bank accounts via junction table
3. **Bank account metadata** - Track which bank and address per account, not per recipient

## Problem Solved

### Before

```
Transaction 1: "JOHN SMITH" from Belfius → Creates Recipient A
Transaction 2: "SMITH JOHN" from ING → Creates Recipient B (DUPLICATE!)
```

### After

```
Transaction 1: "JOHN SMITH" from Belfius → Creates Recipient with normalized_name="JOHN SMITH"
Transaction 2: "SMITH JOHN" from ING → Finds existing Recipient (same normalized_name)
                                       → Adds second bank account to same recipient
```

## Database Schema

### New Table: `recipient_bank_accounts`

```sql
CREATE TABLE recipient_bank_accounts
(
    id             INTEGER PRIMARY KEY,
    recipient_id   INTEGER NOT NULL,        -- Links to recipients
    account_number TEXT    NOT NULL UNIQUE, -- Unique across system
    bank_name      TEXT,                    -- e.g., "BELFIUS", "KBC"
    account_label  TEXT,                    -- User-friendly label
    address        TEXT,                    -- Address specific to this account
    is_primary     BOOLEAN DEFAULT FALSE,   -- Primary account flag
    is_active      BOOLEAN DEFAULT TRUE,
    created_at     DATETIME,
    updated_at     DATETIME,
    FOREIGN KEY (recipient_id) REFERENCES recipients (id)
);
```

### Modified Table: `recipients`

```sql
ALTER TABLE recipients
    ADD COLUMN normalized_name TEXT NOT NULL UNIQUE;

-- normalized_name contains sorted tokens for matching:
-- "JOHN SMITH" -> "JOHN SMITH"
-- "SMITH JOHN" -> "JOHN SMITH"  (same!)
-- "JANE SMITH" -> "JANE SMITH"  (different!)
```

### Modified Table: `transactions`

```sql
ALTER TABLE transactions
    ADD COLUMN recipient_bank_account_id INTEGER;
-- Optional FK to track which specific bank account was used
```

## Name Normalization Algorithm

The `TextNormalizationService.normalize_name_for_matching()` method handles word order variations AND middle
names/initials:

### Algorithm Steps:

1. Converts to uppercase
2. Removes punctuation (periods, commas)
3. Splits into tokens (words)
4. Identifies single-letter tokens as initials
5. Removes initials that have matching full words (e.g., "F" when "FITZGERALD" exists)
6. Sorts remaining tokens alphabetically
7. Joins with single space

### Middle Name/Initial Handling:

The algorithm intelligently handles cases where someone is listed with or without middle names:

- **With initial only**: "JOHN F KENNEDY" → removes "F" → "JOHN KENNEDY"
- **Without middle**: "JOHN KENNEDY" → stays as → "JOHN KENNEDY"
- **With full middle name**: "JOHN FITZGERALD KENNEDY" → keeps full name → "FITZGERALD JOHN KENNEDY"
- **Full name vs initial**: "JOHN FITZGERALD KENNEDY" and "JOHN F KENNEDY" → both become "FITZGERALD JOHN KENNEDY"

**Key Insight**: If an initial has a corresponding full word (F → FITZGERALD), we keep the full word and drop the
initial. If there's no corresponding word, we drop the initial entirely (treating it as optional middle name info).

### Examples:

**Basic Word Order:**

- `"John Smith"` → `"JOHN SMITH"`
- `"SMITH JOHN"` → `"JOHN SMITH"` ✓ Same
- `"jane smith"` → `"JANE SMITH"` ✗ Different person

**Middle Names & Initials:**

- `"JOHN F KENNEDY"` → `"JOHN KENNEDY"`
- `"JOHN KENNEDY"` → `"JOHN KENNEDY"` ✓ Same
- `"KENNEDY JOHN"` → `"JOHN KENNEDY"` ✓ Same
- `"JOHN FITZGERALD KENNEDY"` → `"FITZGERALD JOHN KENNEDY"`
- `"JOHN F KENNEDY"` → `"FITZGERALD JOHN KENNEDY"` when F=FITZGERALD ✓ Same

**Punctuation:**

- `"John F. Kennedy"` → `"JOHN KENNEDY"`
- `"Kennedy, John F."` → `"JOHN KENNEDY"` ✓ Same

**Multiple Initials:**

- `"JOHN F K SMITH"` → `"JOHN SMITH"` (removes both initials)
- `"J. F. K. SMITH"` → `"SMITH"` (removes all initials)

**Edge Cases:**

- `"  John   Smith  "` → `"JOHN SMITH"` (whitespace normalized)
- `"PRINCE"` → `"PRINCE"` (single name supported)
- `"jane smith"` → `"JANE SMITH"` (different person)

## Usage Examples

### Creating Recipients with Bank Accounts

```python
from services.recipient_service import RecipientService

service = RecipientService(db_session)

# First transaction - creates new recipient
recipient, created = service.create_or_get_recipient(
    name="JOHN SMITH",
    account_number="BE61734041478017",
    address="123 Main St",
    bank_name="BELFIUS"
)
print(f"Created: {created}")  # True
print(f"ID: {recipient.id}")  # 1

# Second transaction - same person, different name order
recipient2, created2 = service.create_or_get_recipient(
    name="SMITH JOHN",  # Different order!
    account_number="NL91ABNA0417164300",
    address="456 Oak Ave",
    bank_name="ING"
)
print(f"Created: {created2}")  # False (found existing)
print(f"ID: {recipient2.id}")  # 1 (same recipient!)
```

### Managing Bank Accounts

```python
from services.recipient_bank_account_service import RecipientBankAccountService

service = RecipientBankAccountService(db_session)

# Get all bank accounts for a recipient
accounts = service.get_by_recipient_id(recipient_id=1)
for account in accounts:
    print(f"{account.bank_name}: {account.account_number}")

# Get primary account
primary = service.get_primary_account(recipient_id=1)
print(f"Primary: {primary.account_number}")

# Set different account as primary
service.set_primary(bank_account_id=2, recipient_id=1)
```

### Transaction Import Flow

```python
# Bank adapter creates TransactionData with recipient info
transaction_data = TransactionData(
    recipient="JOHN SMITH",
    recipient_account="BE61734041478017",
    recipient_address="123 Main St",
    recipient_bank_name="BELFIUS",
    # ... other fields
)

# Import service processes transaction
recipient, _ = recipient_service.create_or_get_recipient(
    transaction_data.recipient,
    transaction_data.recipient_account,
    transaction_data.recipient_address,
    transaction_data.recipient_bank_name
)

# Transaction is created with recipient link
transaction = Transaction(
    recipient_id=recipient.id,
    # recipient_bank_account_id is set automatically if account exists
    # ... other fields
)
```

## Migration

### For Fresh Database (You)

```bash
# The models will create the correct schema automatically
python main.py
```

### For Existing Database (Future Reference)

```bash
# Run migration script
python utils/add_recipient_bank_accounts.py

# Verify migration
python utils/add_recipient_bank_accounts.py --verify-only
```

The migration script:

1. Adds `normalized_name` column to recipients
2. Populates normalized names for existing recipients
3. Creates `recipient_bank_accounts` table
4. Migrates existing `account_number` values to junction table
5. Adds `recipient_bank_account_id` to transactions

## Testing

```bash
# Run test script
python test_recipient_bank_accounts.py
```

Tests verify:

- Name normalization works correctly
- Same person with different name orders → same recipient
- Different people with same last name → different recipients
- Multiple bank accounts link to same recipient
- Primary account designation works

## Family Members Handling

The system correctly handles family members with the same last name:

```python
# John Smith
recipient1, _ = service.create_or_get_recipient("JOHN SMITH")
# normalized_name = "JOHN SMITH"

# Jane Smith (different person!)
recipient2, _ = service.create_or_get_recipient("JANE SMITH")
# normalized_name = "JANE SMITH"

assert recipient1.id != recipient2.id  # Different recipients ✓
```

**Why it works**: Full names must match, not just last names.

## API Changes

### Response Format

Recipients now include bank accounts in API responses:

```json
{
  "id": 1,
  "name": "JOHN SMITH",
  "normalized_name": "JOHN SMITH",
  "bank_accounts": [
    {
      "id": 1,
      "account_number": "BE61734041478017",
      "bank_name": "BELFIUS",
      "address": "123 MAIN ST",
      "is_primary": true
    },
    {
      "id": 2,
      "account_number": "NL91ABNA0417164300",
      "bank_name": "ING",
      "address": "456 OAK AVE",
      "is_primary": false
    }
  ],
  "default_category": "PERSONAL:FRIENDS"
}
```

## Files Created/Modified

### New Files

- `database/models.py` - Added `RecipientBankAccount` model
- `repositories/recipient_bank_account_repository.py` - Repository for bank accounts
- `services/recipient_bank_account_service.py` - Service for bank account operations
- `utils/add_recipient_bank_accounts.py` - Migration script
- `test_recipient_bank_accounts.py` - Test suite
- `docs/RECIPIENT_BANK_ACCOUNTS.md` - This documentation

### Modified Files

- `database/models.py`:
    - Modified `Recipient` model (added `normalized_name`, `bank_accounts` relationship)
    - Modified `Transaction` model (added `recipient_bank_account_id` FK)
    - Added `RecipientBankAccount` model

- `services/recipient_service.py`:
    - Rewrote `create_or_get_recipient()` to use normalized name matching
    - Added `bank_name` parameter

- `services/text_normalization_service.py`:
    - Added `normalize_name_for_matching()` method

- `repositories/recipient_repository.py`:
    - Added `get_by_normalized_name()` method
    - Deprecated `get_by_account_number()` (use bank account service instead)

- `services/bank_adapters.py`:
    - Added `recipient_bank_name` field to `TransactionData`
    - Updated all adapters (Belfius, KBC, Revolut, Generic) to populate bank name

- `services/transaction_import_service.py`:
    - Updated to pass `bank_name` to recipient service

## Benefits

✅ **No More Duplicates**: "JOHN SMITH" and "SMITH JOHN" correctly identified as same person  
✅ **Multiple Accounts**: Same person can have accounts at different banks  
✅ **Family-Safe**: Different people with same last name stay separate  
✅ **Address Tracking**: Each bank account can have its own address  
✅ **Audit Trail**: Track which bank account was used per transaction  
✅ **Primary Account**: Designate one account as primary per recipient  
✅ **Backward Compatible**: Existing code continues to work

## Troubleshooting

### Issue: Duplicate recipients still being created

**Check**: Verify normalized_name is being set

```python
recipient = db.query(Recipient).filter_by(name="JOHN SMITH").first()
print(f"Normalized: {recipient.normalized_name}")
# Should show: "JOHN SMITH"
```

### Issue: Bank account not linking to recipient

**Check**: Verify account number is being passed

```python
# In transaction import
print(f"Account: {transaction_data.recipient_account}")
print(f"Bank: {transaction_data.recipient_bank_name}")
```

### Issue: Name variations not matching

**Test normalization**:

```python
from services.text_normalization_service import TextNormalizationService

name1 = "JOHN SMITH"
name2 = "SMITH JOHN"

norm1 = TextNormalizationService.normalize_name_for_matching(name1)
norm2 = TextNormalizationService.normalize_name_for_matching(name2)

assert norm1 == norm2, f"Should match: {norm1} vs {norm2}"
```

## Future Enhancements

1. **Fuzzy Matching**: Handle typos with similarity threshold (e.g., "JOHN SMYTH" ≈ "JOHN SMITH")
2. **Manual Merge UI**: Web interface for users to merge duplicate recipients
3. **Duplicate Detection API**: Endpoint to find potential duplicates for review
4. **Account Ownership Transfers**: Handle cases where account numbers change hands
5. **International Name Formats**: Handle non-Western name orderings

## Questions?

Contact the development team or check:

- `test_recipient_bank_accounts.py` for usage examples
- API documentation for endpoint details
- Database schema diagrams in `/docs`

