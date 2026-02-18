# Planned Transactions Frontend-Backend Integration

## Overview

This document describes the integration between the frontend UI and backend API for planned transactions management.

## Implementation Summary

### Backend API (Already Implemented)

The backend provides a complete REST Level 3 (HATEOAS) API for planned transactions at `/api/planned-transactions`:

**Endpoints:**
- `GET /api/planned-transactions` - List all planned transactions with filtering and pagination
- `POST /api/planned-transactions` - Create a new planned transaction
- `GET /api/planned-transactions/{id}` - Get a specific planned transaction
- `PATCH /api/planned-transactions/{id}` - Update a planned transaction
- `DELETE /api/planned-transactions/{id}` - Delete a planned transaction (soft delete)
- `OPTIONS /api/planned-transactions` - Discover available methods

**Key Features:**
- Pagination support (limit, offset)
- Comprehensive filtering (date range, bank account, category, recipient, recurring status, execution status)
- HATEOAS links for navigation
- Category and recipient name resolution
- Recurring transaction patterns (daily, weekly, monthly, quarterly, yearly, custom)

### Frontend Implementation

#### 1. Type Definitions (`/apps/frontend/src/types/api.ts`)

Added complete TypeScript interfaces matching the backend schema:
- `PlannedTransaction` - Full planned transaction object with all fields
- `PlannedTransactionsListResponse` - Paginated list response
- `PlannedTransactionCreate` - Request payload for creating planned transactions
- `PlannedTransactionUpdate` - Partial update payload

**Key Fields:**
```typescript
interface PlannedTransaction {
  id: number;
  planned_date: string;           // YYYY-MM-DD
  bank_account: string;
  recipient_id?: number;
  recipient_name?: string;
  amount: number;
  currency?: string;
  category_id?: number;
  category_name?: string;         // "GENERAL:DETAIL" format
  memo?: string;
  comment?: string;
  is_recurring: boolean;
  recurrence_pattern?: string;    // "daily", "monthly", etc.
  is_executed: boolean;
  executed_transaction_id?: number;
  is_active: boolean;
  created_at: string;
  updated_at?: string;
  links: Link[];
}
```

#### 2. API Client (`/apps/frontend/src/lib/api.ts`)

Added five new methods to the `ApiClient` class:

```typescript
// Get all planned transactions with optional filters
async getPlannedTransactions(params?: {
  limit?: number;
  offset?: number;
  start_date?: string;
  end_date?: string;
  bank_account?: string;
  category_id?: number;
  recipient_id?: number;
  is_recurring?: boolean;
  is_executed?: boolean;
  active?: boolean;
}): Promise<PlannedTransactionsListResponse>

// Get a single planned transaction by ID
async getPlannedTransaction(id: number): Promise<PlannedTransaction>

// Create a new planned transaction
async createPlannedTransaction(
  plannedTransaction: PlannedTransactionCreate
): Promise<PlannedTransaction>

// Update an existing planned transaction
async updatePlannedTransaction(
  id: number, 
  plannedTransaction: PlannedTransactionUpdate
): Promise<PlannedTransaction>

// Delete a planned transaction (soft delete)
async deletePlannedTransaction(id: number): Promise<void>
```

#### 3. Custom Hook (`/apps/frontend/src/hooks/usePlannedPayments.ts`)

**Replaced localStorage-based implementation with API-based implementation:**

**Key Features:**
- Automatic data fetching on mount
- Loading and error states
- Async CRUD operations with proper error handling
- Data transformation between frontend and backend formats

**Mapping Functions:**
- `mapFromAPI()` - Converts backend `PlannedTransaction` to frontend `PlannedPayment` format
- `mapToCreateAPI()` - Converts frontend create payload to backend format
- `mapToUpdateAPI()` - Converts frontend partial updates to backend format

**Recurrence Pattern Handling:**
- Frontend uses structured fields: `frequency`, `custom_interval_days`
- Backend uses a single `recurrence_pattern` string field
- Bidirectional transformation handles: "daily", "weekly", "monthly", "quarterly", "yearly", "custom"

**Exported Interface:**
```typescript
{
  payments: PlannedPayment[];
  addPayment: (payment) => Promise<void>;
  updatePayment: (id, updates) => Promise<void>;
  deletePayment: (id) => Promise<void>;
  toggleActive: (id) => Promise<void>;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}
```

#### 4. UI Components

##### PlannedPaymentsPage (`/apps/frontend/src/pages/PlannedPaymentsPage.tsx`)

**Enhancements:**
- Added loading spinner during initial data fetch
- Added error alert display
- Made all operations async with proper error handling
- Added confirmation dialog for deletions
- Disabled action buttons during operations to prevent duplicate requests
- Shows real-time statistics (total planned, estimated monthly, due this week)

##### PlannedPaymentForm (`/apps/frontend/src/components/planned/PlannedPaymentForm.tsx`)

**Major Changes:**
- Replaced text inputs for recipient/category with dropdowns
- Added real-time fetching of recipients and categories from backend
- Made recipient selection required (backend requirement)
- Category selection is optional
- Shows loading spinner while fetching form data
- Better validation messages

**Form Fields:**
- Name (required) - Maps to `memo` field in backend
- Amount (required) - Negative for expenses, positive for income
- Currency - Dropdown with common currencies
- Due Date (required) - Date picker for `planned_date`
- Recipient (required) - Dropdown from backend recipients
- Category (optional) - Dropdown from backend categories
- Bank Account (optional)
- Recurring toggle
  - Frequency dropdown (daily, weekly, biweekly, monthly, quarterly, yearly, custom)
  - Custom interval (if custom selected)
  - End date (optional)
  - Max occurrences (optional)
- Notes (optional) - Maps to `comment` field

## Data Flow

### Creating a Planned Transaction

```
User fills form → PlannedPaymentForm collects data →
onSubmit callback → usePlannedPayments.addPayment() →
mapToCreateAPI() transforms data → apiClient.createPlannedTransaction() →
POST /api/planned-transactions → Backend validates & stores →
Response with created transaction → mapFromAPI() transforms →
State updated → UI refreshes
```

### Loading Planned Transactions

```
Component mounts → usePlannedPayments hook runs →
useEffect triggers fetchPayments() →
apiClient.getPlannedTransactions({ active: true, limit: 1000 }) →
GET /api/planned-transactions → Backend returns paginated list →
response.items.map(mapFromAPI) → State updated → UI renders
```

### Updating a Planned Transaction

```
User clicks edit → Form opens with initial values →
User modifies fields → Clicks save →
usePlannedPayments.updatePayment(id, changes) →
mapToUpdateAPI() creates partial update →
apiClient.updatePlannedTransaction(id, updates) →
PATCH /api/planned-transactions/{id} → Backend updates →
Response with updated transaction → mapFromAPI() →
State updated → UI refreshes
```

## Field Mapping Reference

| Frontend Field | Backend Field | Notes |
|----------------|---------------|-------|
| `name` | `memo` | Transaction description |
| `due_date` | `planned_date` | ISO date format |
| `recipient` (display only) | `recipient_name` | Resolved from recipient_id |
| `recipient_id` | `recipient_id` | **Required** - References recipients table |
| `category` (display only) | `category_name` | Format: "GENERAL:DETAIL" |
| `category_id` | `category_id` | Optional - References categories table |
| `notes` | `comment` | Additional notes |
| `frequency` + `custom_interval_days` | `recurrence_pattern` | Transformed bidirectionally |
| `is_active` | `is_active` | Soft delete flag |

## Recurrence Pattern Examples

| Frontend | Backend Pattern |
|----------|----------------|
| `{ frequency: "daily" }` | `"daily"` |
| `{ frequency: "monthly" }` | `"monthly"` |
| `{ frequency: "custom", custom_interval_days: 10 }` | `"every 10 days"` |

## Error Handling

All API operations include try-catch blocks with:
- Console error logging for debugging
- User-friendly error messages
- State cleanup (loading flags reset)
- Form validation before submission

## Testing Checklist

### Manual Testing Steps:

1. **List View**
   - [ ] Page loads without errors
   - [ ] Loading spinner shows during initial fetch
   - [ ] Planned payments display correctly
   - [ ] Summary cards show correct statistics
   - [ ] Badges show correct due date status (Today, Overdue, In Xd)

2. **Create New**
   - [ ] Click "New Payment" button opens form
   - [ ] Recipients and categories load in dropdowns
   - [ ] Form validation works (required fields)
   - [ ] Recurring options show/hide correctly
   - [ ] Successful creation adds payment to list
   - [ ] Error messages display on failure

3. **Edit Existing**
   - [ ] Click edit icon opens form with pre-filled values
   - [ ] Changes save correctly
   - [ ] UI updates immediately after save
   - [ ] Cancel closes form without changes

4. **Delete**
   - [ ] Click delete shows confirmation
   - [ ] Confirming removes payment from list
   - [ ] Canceling keeps payment

5. **Toggle Active/Inactive**
   - [ ] Toggle button switches state
   - [ ] Backend updates persist
   - [ ] UI reflects new state (strikethrough when inactive)

6. **Recurring Transactions**
   - [ ] Frequency dropdown works
   - [ ] Custom interval field appears for custom frequency
   - [ ] Recurring badge displays correct frequency
   - [ ] Monthly estimate calculation is accurate

## Known Limitations

1. **Recipient Requirement**: The backend requires a `recipient_id` for all planned transactions. Users must have at least one recipient in the system before creating planned transactions.

2. **Pagination**: Currently loads up to 1000 planned transactions at once. For very large datasets, implement proper pagination in the UI.

3. **End Date & Max Occurrences**: The frontend collects these fields but they may not be fully implemented in the backend's recurrence logic yet.

4. **Executed Transactions**: The UI doesn't yet show a link to the actual transaction when `is_executed` is true and `executed_transaction_id` is set.

## Future Enhancements

1. Add filtering UI (by date range, bank account, category, etc.)
2. Implement pagination for large datasets
3. Add bulk operations (activate/deactivate multiple, bulk delete)
4. Show linked actual transactions when executed
5. Add calendar view for planned transactions
6. Implement drag-and-drop to reschedule
7. Add notifications/reminders for upcoming payments
8. Export planned transactions to CSV
9. Quick-add from recent transactions

## API Configuration

The frontend uses the following environment variable for API URL:
```
VITE_API_URL=http://localhost:3002
```

Default fallback: `http://localhost:3002`

## Dependencies

**Frontend:**
- React hooks: useState, useEffect, useCallback, useMemo
- date-fns: Date formatting and manipulation
- lucide-react: Icons
- shadcn/ui: UI components (Button, Dialog, Select, etc.)

**Backend:**
- FastAPI
- SQLAlchemy ORM
- Pydantic validation
- PostgreSQL/SQLite database

## Conclusion

The planned transactions feature is now fully integrated between frontend and backend, providing a complete CRUD interface for managing upcoming and recurring payments. The implementation follows REST best practices, includes proper error handling, and provides a smooth user experience with loading states and real-time updates.
