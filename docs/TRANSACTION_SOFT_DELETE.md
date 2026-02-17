# Transaction Soft Delete Feature Implementation

## Summary
Implemented soft delete functionality for transactions, matching the existing implementation for recipients and categories. Transactions can now be hidden/shown with a visual toggle, and the backend soft_delete mechanism is used instead of hard deletion.

## Changes Made

### Frontend

#### 1. Type Definitions (`apps/frontend/src/types/api.ts`)
- **Added** `is_active: boolean` field to `Transaction` interface
- **Added** `is_active?: boolean` field to `TransactionUpdate` interface

#### 2. Transactions Page (`apps/frontend/src/pages/TransactionsPage.tsx`)
- **Added** imports: `Eye`, `EyeOff`, `ToggleLeft`, `ToggleRight` icons from lucide-react
- **Added** `is_active: boolean` field to `TableTransaction` type
- **Added** `showAll` state to track visibility filter
- **Modified** `useTransactions` hook call to conditionally apply `active` filter based on `showAll` state
- **Added** `toggleActive` function to handle soft delete by toggling `is_active` status
- **Added** `is_active` field to transactions mapping from backend data (defaults to `true`)
- **Modified** date column render to apply `line-through` styling for inactive transactions
- **Added** Status column with toggle button before delete column
  - Shows "Active" with green styling when `is_active=true`
  - Shows "Inactive" with muted styling when `is_active=false`
  - Uses `ToggleRight`/`ToggleLeft` icons
- **Added** `actions` variable with:
  - Eye/EyeOff toggle button to switch between "Active Only" and "Showing All"
  - AddTransactionDialog component
- **Modified** DataTable to use `actions` prop instead of inline AddTransactionDialog

### Backend
- **No changes required** - Transaction model already has `is_active` field (line 36 in `database/models.py`)
- **Existing** `soft_delete` method in `TransactionService` works with the `is_active` field
- **Existing** `active` query parameter in `/api/transactions` endpoint filters by `is_active` status

## Visual Behavior

### Matching Recipients & Categories Pattern
- **Toggle Button**: Same UI as Recipients and Categories pages
  - Green "Active" state with `ToggleRight` icon
  - Muted "Inactive" state with `ToggleLeft` icon
- **Visibility Filter**: Eye/EyeOff button to show all or active only
  - "Active Only" (default): Shows only active transactions
  - "Showing All": Shows both active and inactive transactions
- **Visual Indication**: Inactive transactions appear with:
  - Line-through text on the date column
  - Muted text color

## API Communication
- **Toggle Active/Inactive**: Uses `PATCH /api/transactions/{id}` with `{ is_active: boolean }` in request body to toggle visibility
- **Filter Active Only**: Uses `GET /api/transactions?active=true` (default - shows only active transactions)
- **Filter All**: Uses `GET /api/transactions?active=false` (shows both active and inactive transactions)
- **Hard Delete**: Uses `DELETE /api/transactions/{id}` (permanent removal via trash button)

## Implementation Details

### Visibility Filter
The Eye/EyeOff button controls the `active` query parameter:
- **"Active Only" (default)**: `active=true` - Returns only active transactions
- **"Showing All"**: `active=false` - Returns both active and inactive transactions

**Important**: The backend requires `active=false` to see all transactions, not omitting the parameter. By default, `active=true` filters to show only active items.

### Toggle Mechanism
The toggle button uses PATCH to toggle the `is_active` field:
- **When Active → Inactive**: Calls `PATCH /api/transactions/{id}` with `{ is_active: false }`
- **When Inactive → Active**: Calls `PATCH /api/transactions/{id}` with `{ is_active: true }`

This approach is consistent with Recipients and Categories, which also use PATCH to toggle their `is_active` field.

### Hard Delete
The trash button calls `DELETE /api/transactions/{id}` for permanent removal from the database.

## User Workflow
1. **Hide Transaction**: Click the "Active" toggle button → Transaction becomes inactive and styled with line-through
2. **Show All**: Click "Active Only" button → Changes to "Showing All" and displays hidden transactions
3. **Restore Transaction**: Click the "Inactive" toggle button → Transaction becomes active again
4. **Hard Delete**: Delete button still available for permanent removal

## Testing Recommendations
1. Verify toggle switches transaction between active/inactive
2. Verify "Active Only" shows only active transactions
3. Verify "Showing All" displays both active and inactive transactions
4. Verify inactive transactions display with line-through styling
5. Verify pagination respects visibility filter
6. Verify backend correctly returns `is_active` field in responses
7. Verify soft delete doesn't affect related data (categories, recipients)
