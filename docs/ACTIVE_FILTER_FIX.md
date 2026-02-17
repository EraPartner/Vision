# Active Filter Fix - February 17, 2026

## Issue
When clicking "Showing All" to view all transactions (including inactive ones), the inactive transactions were not appearing. The problem was with how the `active` query parameter was being sent to the backend.

## Root Cause
The code was using this pattern:
```typescript
...(showAll ? {} : { active: true })
```

This meant:
- When `showAll = false`: `active: true` (correct - shows only active)
- When `showAll = true`: parameter omitted (incorrect - backend defaults to `active: true`)

The backend API behavior:
- `active=true` (default) → Returns only active items
- `active=false` → Returns ALL items (both active and inactive)
- Omitting the parameter → Uses default (`active=true`)

## Solution
Changed all three pages to use:
```typescript
active: !showAll
```

This means:
- When `showAll = false`: `active: true` → Shows only active items ✅
- When `showAll = true`: `active: false` → Shows ALL items (active + inactive) ✅

## Files Modified

### 1. TransactionsPage.tsx
**Before:**
```typescript
const { data, isLoading, error } = useTransactions({ 
    limit: PAGE_SIZE, 
    offset: page * PAGE_SIZE, 
    ...(showAll ? {} : { active: true }) 
});
```

**After:**
```typescript
const { data, isLoading, error } = useTransactions({ 
    limit: PAGE_SIZE, 
    offset: page * PAGE_SIZE, 
    active: !showAll  // false = all transactions, true = active only
});
```

### 2. RecipientsPage.tsx
**Before:**
```typescript
const { data, isLoading, error } = useRecipients({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(showAll ? {} : { active: true }),
});
```

**After:**
```typescript
const { data, isLoading, error } = useRecipients({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    active: !showAll,  // false = all recipients, true = active only
});
```

### 3. CategoriesPage.tsx
**Status:** Already correct! Was using `active: !showAll` pattern.

## Testing
After this fix:
1. ✅ "Active Only" button shows only active items
2. ✅ "Showing All" button shows both active and inactive items
3. ✅ Inactive items display with line-through styling
4. ✅ Toggle button correctly hides/shows items
5. ✅ Pagination resets when switching between filters

## Documentation Updated
- Updated `TRANSACTION_SOFT_DELETE.md` to clarify `active` parameter behavior
- Updated `IMPLEMENTATION_SUMMARY.md` with correct API usage
