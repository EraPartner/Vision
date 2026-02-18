# Link Transaction Dialog Implementation

## Overview
Implemented a user-friendly dialog for linking planned payments to existing transactions, replacing the previous prompt-based approach that required users to manually enter transaction IDs.

## Changes Made

### 1. New Component: LinkTransactionDialog.tsx
**Location:** `apps/frontend/src/components/planned/LinkTransactionDialog.tsx`

**Features:**
- **Transaction List**: Displays recent transactions (last 90 days) in a searchable table
- **Search Functionality**: Filter transactions by:
  - Transaction ID
  - Recipient name
  - Memo
  - Bank account
  - Category
  - Amount
- **Visual Selection**: Radio button selection with row highlighting
- **Transaction Details**: Shows all relevant information:
  - Transaction ID (for reference)
  - Date (formatted)
  - Recipient
  - Memo
  - Category
  - Amount (color-coded: red for expenses, green for income)
- **Context Display**: Shows planned payment name and amount at the top for easy comparison
- **Loading State**: Spinner while fetching transactions
- **Empty State**: Clear message when no transactions are found

### 2. Updated: PlannedPaymentsPage.tsx
**Changes:**
1. Added import for `LinkTransactionDialog`
2. Added state management:
   - `linkDialogOpen`: Controls dialog visibility
   - `paymentToLink`: Stores the planned payment being linked
3. Modified execute button click handler:
   - Removed `prompt()` call
   - Opens `LinkTransactionDialog` instead
4. Added dialog component with transaction selection handler

### 3. User Flow

**Before:**
1. Click execute button
2. Browser prompt appears asking for transaction ID
3. User must manually find and type the transaction ID
4. Risk of typos or invalid IDs

**After:**
1. Click execute button (circle icon)
2. Dialog opens showing recent transactions
3. User can search/filter transactions
4. User selects transaction by clicking row or radio button
5. Click "Link Transaction" to confirm
6. Dialog closes and payment is linked

## Technical Details

### Date Parsing
Uses the same `parseLocalDate` approach to avoid timezone issues when displaying transaction dates.

### Transaction Fetching
- Fetches last 90 days of transactions
- Limit: 100 transactions
- Only active transactions
- Uses `useTransactions` hook from the existing infrastructure

### Formatting
- Amount formatting with currency symbol
- Color coding for positive/negative amounts
- Date formatting using `date-fns`
- Truncated text with max-width for long fields

### Accessibility
- Radio buttons for clear selection indication
- Clickable rows for easy selection
- Visual feedback with background color on selection
- Keyboard accessible

## Benefits

1. **User-Friendly**: No need to know transaction IDs
2. **Visual Confirmation**: See transaction details before linking
3. **Search/Filter**: Quickly find the right transaction
4. **Error Prevention**: Only valid transactions can be selected
5. **Consistent UX**: Matches the pattern used elsewhere in the app
6. **Mobile-Friendly**: Responsive design with scrollable table

## Future Enhancements (Optional)

- Add date range filter controls
- Show transactions already linked to other planned payments
- Add sorting by column
- Add pagination for better performance with large datasets
- Show transaction balance
- Filter by amount range
- Highlight transactions with similar amounts to the planned payment
