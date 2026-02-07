# API Response Updates - Category and Recipient Names

## Overview
Updated the entire frontend application to use the new API response fields that include category and recipient names instead of just IDs. This provides a better user experience by displaying human-readable names throughout the application.

## API Changes (from OpenAPI Spec)

### Transaction Response
- **Added**: `category_name` (string, nullable) - Category name in 'GENERAL:DETAIL' format (e.g., 'FOOD:GROCERIES')
- **Added**: `recipient_name` (string, nullable) - Recipient name
- **Existing**: `category_id` and `recipient_id` still present for reference

### Recipient Response
- **Added**: `default_category_name` (string, nullable) - Default category name in 'GENERAL:DETAIL' format
- **Existing**: `default_category_id` still present for reference

## Frontend Changes

### 1. Type Definitions (`src/types/api.ts`)
Updated the TypeScript interfaces to include the new fields:

```typescript
export interface Transaction {
    // ...existing fields
    recipient_name?: string; // NEW
    category_name?: string; // NEW
}

export interface Recipient {
    // ...existing fields
    default_category_name?: string; // NEW
}
```

### 2. Category Color Utility (`src/utils/categoryColors.ts`)
Created a new utility function to handle the new category name format:

- **Function**: `getCategoryColor(category: string): string`
- **Purpose**: Maps category names (in GENERAL:DETAIL format) to Tailwind color classes
- **Features**:
  - Pattern matching for common categories (FOOD, INCOME, UTILITIES, etc.)
  - Works with both simple and compound formats
  - Returns default color for unknown categories

### 3. Dashboard Page (`src/pages/DashboardPage.tsx`)
**Changes**:
- Updated category breakdown calculation to use `category_name` instead of `category_id`
- Updated recent transactions mapping to use `category_name` and `recipient_name`
- Replaced static `categoryColor` object with dynamic `getCategoryColor()` function
- Categories now display as human-readable names (e.g., "FOOD:GROCERIES" instead of "Category 1")
- Recipients now display as names (e.g., "Tesco PLC" instead of "Recipient 123")

### 4. Transactions Page (`src/pages/TransactionsPage.tsx`)
**Changes**:
- Updated transaction mapping to use `category_name` and `recipient_name`
- Replaced static `categoryColor` object with dynamic `getCategoryColor()` function
- Category badges now show meaningful names
- Recipient column shows actual recipient names

### 5. Recipients Page (`src/pages/RecipientsPage.tsx`)
**Changes**:
- Added `default_category_name` to the TableRecipient type
- Added new "Default Category" column to the recipients table
- Displays the default category name in a badge (or "None" if not set)
- Recipients table now shows: Name, Account Number, Default Category, Status

## Benefits

1. **Better UX**: Users see meaningful category and recipient names instead of numeric IDs
2. **Maintainability**: Category color mapping is now pattern-based and handles various category formats
3. **Consistency**: All pages now use the same category color utility
4. **Flexibility**: Works with both simple categories and hierarchical GENERAL:DETAIL formats
5. **Backward Compatibility**: Original ID fields are still available in the API response if needed

## Testing Checklist

- [ ] Dashboard page displays category names in pie chart
- [ ] Dashboard page shows category names in recent transactions table
- [ ] Dashboard page shows recipient names in recent transactions table
- [ ] Transactions page displays category names with correct colors
- [ ] Transactions page displays recipient names
- [ ] Recipients page shows default category names
- [ ] Category colors apply correctly to various category formats (FOOD:GROCERIES, INCOME:SALARY, etc.)
- [ ] "Uncategorized" and "Unknown" display correctly when names are missing

## Notes

- The API automatically provides the category name from either:
  1. The transaction's direct category assignment, OR
  2. The recipient's default category (fallback)
  
- This automatic categorization happens on the backend, so the frontend just displays the result
- The category name format is 'GENERAL:DETAIL' (e.g., 'FOOD:GROCERIES', 'INCOME:SALARY')
- All null/undefined values are handled with fallbacks ('Uncategorized', 'Unknown', 'None')
