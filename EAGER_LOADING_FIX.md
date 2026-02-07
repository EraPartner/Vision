# Backend Eager Loading Fix - Recipient and Transaction Names

## Summary
Fixed the backend to properly load recipient and category relationships so that `recipient_name` and `default_category_name` are populated in API responses.

## Problem
- Transaction API responses showed `recipient_id` but `recipient_name` was not being populated
- Recipient API responses showed `default_category_id` but `default_category_name` was showing as null
- This was because SQLAlchemy wasn't eagerly loading the relationships

## Root Cause
The database models have properties that access relationships:
- `Transaction.recipient_name` property accesses `self.recipient.name`
- `Recipient.default_category_name` property accesses `self.default_category.full_path()`

Without eager loading, these relationships aren't loaded from the database, so when Pydantic tries to serialize the response, it can't access the related data.

## Solution
Added eager loading using `joinedload()` to load relationships in a single query instead of causing N+1 queries.

### Backend Changes

#### 1. Recipient Repository (`recipient_repository.py`)
Added eager loading of `default_category` relationship:

```python
from sqlalchemy.orm import Session, joinedload

# In get_all_active()
query = self.db.query(Recipient).options(
    joinedload(Recipient.default_category)
).order_by(Recipient.id)

# In get_by_id()
result = self.db.query(Recipient).options(
    joinedload(Recipient.default_category)
).filter(Recipient.id == recipient_id).first()

# In get_by_name()
result = self.db.query(Recipient).options(
    joinedload(Recipient.default_category)
).filter(Recipient.name == name).first()
```

#### 2. Transaction Repository (`transaction_repository.py`)
Added eager loading of `recipient` and `category` relationships:

```python
from sqlalchemy.orm import Session, joinedload

# In get_transactions()
query = self.db.query(Transaction).options(
    joinedload(Transaction.recipient),
    joinedload(Transaction.category)
)

# In get_uncategorised_transactions()
query = self.db.query(Transaction).options(
    joinedload(Transaction.recipient),
    joinedload(Transaction.category)
)

# In get_by_id()
return self.db.query(Transaction).options(
    joinedload(Transaction.recipient),
    joinedload(Transaction.category)
).filter(Transaction.id == transaction_id).first()
```

### Frontend Changes

#### RecipientsPage.tsx
Enhanced the default category display to:
1. Extract only the detail part (e.g., "FOOD:GROCERIES" → "Groceries")
2. Format with proper capitalization
3. Style "None" values with muted color

```typescript
const formatCategoryName = (categoryName?: string): string => {
    if (!categoryName) return 'None';
    
    const parts = categoryName.split(':');
    if (parts.length > 1) {
        const detail = parts[1].trim();
        return detail.charAt(0) + detail.slice(1).toLowerCase();
    }
    return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
};
```

## Benefits

1. **Single Query Efficiency**: Uses SQL JOIN instead of N+1 queries
2. **Complete Data**: API responses now include both IDs and human-readable names
3. **Better UX**: Frontend can display "Tesco PLC" instead of "Recipient 492"
4. **Consistent Formatting**: Category names are formatted consistently across all pages
5. **Null Handling**: Properly handles recipients without default categories

## How Eager Loading Works

**Without eager loading:**
```python
# Query 1: Get transactions
transactions = db.query(Transaction).all()

# Queries 2-N: For each transaction, load recipient (N+1 problem!)
for t in transactions:
    name = t.recipient.name  # Triggers a new query!
```

**With eager loading:**
```python
# Single query with JOIN
transactions = db.query(Transaction).options(
    joinedload(Transaction.recipient)
).all()

# No additional queries - data is already loaded
for t in transactions:
    name = t.recipient.name  # No query! Data already loaded
```

## Testing Checklist

- [x] Recipient API returns `default_category_name` for recipients with categories
- [x] Recipient API returns null for `default_category_name` when no category assigned
- [x] Transaction API returns `recipient_name` for all transactions
- [x] Transaction API returns `category_name` from transaction or recipient default
- [x] Recipients page displays formatted category names
- [x] Recipients page shows "None" for recipients without default categories
- [x] Transactions page displays recipient names
- [x] Dashboard displays recipient names in recent transactions
- [x] No N+1 query issues (check SQL logs)

## API Response Examples

### Transaction with eager loading:
```json
{
    "id": 3413,
    "date": "2026-01-07",
    "recipient_id": 492,
    "recipient_name": "TESCO PLC",
    "category_id": null,
    "category_name": "FOOD:GROCERIES",
    "amount": 0.03
}
```

### Recipient with eager loading:
```json
{
    "id": 1,
    "name": "TESCO PLC",
    "default_category_id": 5,
    "default_category_name": "FOOD:GROCERIES"
}
```

### Recipient without default category:
```json
{
    "id": 2,
    "name": "UNKNOWN MERCHANT",
    "default_category_id": null,
    "default_category_name": null
}
```
