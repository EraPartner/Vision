# DELETE Endpoint Changes - Summary

## Overview

Changed all DELETE endpoints for categories, recipients, and transactions to always perform hard deletes. The
`is_active` field can now be modified via PATCH endpoints to deactivate resources instead of deleting them.

## Changes Made

### 1. Categories (`api/api_routes_categories.py`)

**DELETE endpoint changes:**

- Removed `soft` query parameter
- Always performs hard delete (permanent removal)
- Updated docstring to recommend using PATCH with `is_active=false` for deactivation

**PATCH endpoint changes:**

- `CategoryUpdate` schema now includes `is_active` field
- `CategoryService.update()` now accepts `is_active` parameter
- API route passes `is_active` to service

### 2. Recipients (`api/api_routes_recipients.py`)

**DELETE endpoint changes:**

- Removed `soft` query parameter
- Always performs hard delete (permanent removal)
- Updated docstring to recommend using PATCH with `is_active=false` for deactivation

**PATCH endpoint changes:**

- `RecipientUpdate` schema already had `is_active` field ✓
- `RecipientService.update()` already supports `is_active` parameter ✓
- No additional changes needed

### 3. Transactions (`api/api_routes_transactions.py`)

**DELETE endpoint changes:**

- Removed `soft` query parameter
- Always performs hard delete (permanent removal)
- Updated docstring to recommend using PATCH with `is_active=false` for deactivation

**PATCH endpoint changes:**

- `TransactionUpdate` schema now includes `is_active` field
- `TransactionService.update()` already supports `is_active` parameter ✓
- API route already passes all update fields to service ✓

## API Usage Examples

### Deactivating a Resource (Soft Delete Alternative)

Instead of soft delete, use PATCH to deactivate:

```http
PATCH /api/categories/123
Content-Type: application/json

{
  "is_active": false
}
```

```http
PATCH /api/recipients/456
Content-Type: application/json

{
  "is_active": false
}
```

```http
PATCH /api/transactions/789
Content-Type: application/json

{
  "is_active": false
}
```

### Hard Delete (Permanent Removal)

```http
DELETE /api/categories/123
DELETE /api/recipients/456
DELETE /api/transactions/789
```

## Benefits

1. **Clearer API Semantics:** DELETE now always means permanent removal
2. **Explicit Deactivation:** Use PATCH to explicitly set `is_active=false` for soft deletion behavior
3. **Consistency:** All resource types follow the same pattern
4. **Reversibility:** Deactivated resources can be reactivated with PATCH `is_active=true`
5. **Audit Trail:** Deactivated resources remain in the database for audit purposes

## Backward Compatibility

**Breaking Change:** The `soft` query parameter has been removed from all DELETE endpoints.

Existing clients using:

- `DELETE /api/categories/123?soft=true` → Now use `PATCH /api/categories/123 {"is_active": false}`
- `DELETE /api/categories/123?soft=false` → Now use `DELETE /api/categories/123`

## Testing Recommendations

1. Test hard delete removes records permanently
2. Test PATCH with `is_active=false` marks records as inactive
3. Test GET endpoints respect `active` filter parameter
4. Test PATCH with `is_active=true` reactivates inactive records
5. Test that inactive records don't appear in default queries (active=true)
6. Test that inactive records appear when querying with active=false

## Files Modified

- `api/api_routes_categories.py`
- `api/api_routes_recipients.py`
- `api/api_routes_transactions.py`
- `api/api_schemas.py` (CategoryUpdate, TransactionUpdate)
- `services/category_service.py` (update method)

