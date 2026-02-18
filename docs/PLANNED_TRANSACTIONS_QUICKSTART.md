# Planned Transactions - Quick Start Guide

## For Developers

### Adding a New Planned Transaction (Code Example)

```typescript
import { apiClient } from '@/lib/api';

// Create a new planned transaction
const newPayment = await apiClient.createPlannedTransaction({
  planned_date: "2026-03-15",
  bank_account: "My Checking Account",
  recipient_id: 5,  // Must reference existing recipient
  memo: "Netflix subscription",
  amount: -12.99,
  currency: "GBP",
  category_id: 3,   // Optional - References categories
  comment: "Entertainment expense",
  is_recurring: true,
  recurrence_pattern: "monthly"
});
```

### Fetching Planned Transactions with Filters

```typescript
// Get all active planned transactions
const response = await apiClient.getPlannedTransactions({
  active: true,
  limit: 50,
  offset: 0
});

// Get upcoming payments (next 30 days)
const upcoming = await apiClient.getPlannedTransactions({
  active: true,
  start_date: "2026-02-18",
  end_date: "2026-03-18",
  is_executed: false
});

// Get recurring payments only
const recurring = await apiClient.getPlannedTransactions({
  active: true,
  is_recurring: true
});

// Filter by bank account
const checking = await apiClient.getPlannedTransactions({
  active: true,
  bank_account: "Chase"  // Partial match, case-insensitive
});
```

### Using the Hook in Components

```typescript
import { usePlannedPayments } from '@/hooks/usePlannedPayments';

function MyComponent() {
  const { 
    payments,      // Array of PlannedPayment objects
    addPayment,    // async (payment) => void
    updatePayment, // async (id, updates) => void
    deletePayment, // async (id) => void
    toggleActive,  // async (id) => void
    loading,       // boolean
    error,         // string | null
    refetch        // async () => void
  } = usePlannedPayments();

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      {payments.map(payment => (
        <div key={payment.id}>{payment.name}</div>
      ))}
    </div>
  );
}
```

### Updating a Planned Transaction

```typescript
// Update amount and memo
await apiClient.updatePlannedTransaction(1, {
  amount: -14.99,
  memo: "Netflix Premium"
});

// Mark as executed
await apiClient.updatePlannedTransaction(1, {
  is_executed: true
});

// Pause/deactivate
await apiClient.updatePlannedTransaction(1, {
  is_active: false
});

// Change recurrence pattern
await apiClient.updatePlannedTransaction(1, {
  recurrence_pattern: "every 10 days"
});
```

### Backend API Endpoints

```bash
# List all planned transactions
GET http://localhost:3002/api/planned-transactions?active=true&limit=50

# Get specific planned transaction
GET http://localhost:3002/api/planned-transactions/1

# Create planned transaction
POST http://localhost:3002/api/planned-transactions
Content-Type: application/json

{
  "planned_date": "2026-03-15",
  "bank_account": "My Account",
  "recipient_id": 5,
  "memo": "Netflix",
  "amount": -12.99,
  "currency": "GBP",
  "is_recurring": true,
  "recurrence_pattern": "monthly"
}

# Update planned transaction (partial)
PATCH http://localhost:3002/api/planned-transactions/1
Content-Type: application/json

{
  "amount": -14.99,
  "memo": "Netflix Premium"
}

# Delete planned transaction (soft delete)
DELETE http://localhost:3002/api/planned-transactions/1

# Discover available methods
OPTIONS http://localhost:3002/api/planned-transactions
```

## For Users

### Creating a New Planned Payment

1. Click the **"New Payment"** button
2. Fill in required fields:
   - **Name**: Description (e.g., "Netflix subscription")
   - **Amount**: Enter positive for income, negative for expenses (e.g., -12.99)
   - **Due Date**: Select from calendar
   - **Recipient**: Choose from dropdown
3. Optional fields:
   - Category
   - Bank Account
   - Notes
4. For recurring payments:
   - Toggle **"Recurring"** switch
   - Select frequency (daily, weekly, monthly, etc.)
   - Optionally set end date or max occurrences
5. Click **"Create Payment"**

### Editing a Planned Payment

1. Click the **pencil icon** next to the payment
2. Modify any fields
3. Click **"Save Changes"**

### Deleting a Planned Payment

1. Click the **trash icon** next to the payment
2. Confirm deletion in the dialog

### Pausing/Activating a Payment

1. Click the **toggle button** in the Status column
2. Active payments show "Active" with green toggle
3. Paused payments show "Paused" with gray toggle and are strikethrough

### Understanding the Dashboard

**Summary Cards:**
- **Total Planned**: Number of all planned payments
- **Est. Monthly**: Estimated monthly recurring cost
  - Calculated based on frequency (e.g., weekly × 4.33)
- **Due This Week**: Payments due in the next 7 days

**Due Date Badges:**
- **Red (Overdue)**: Payment date has passed
- **Yellow (Today)**: Payment is due today
- **Green (In Xd)**: Payment due in X days (within 7 days)
- **Gray (Date)**: Payment due later (beyond 7 days)

**Recurrence Column:**
- Shows frequency for recurring payments
- "One-time" for non-recurring payments

## Common Workflows

### Setting Up Monthly Bills

1. Create recipient for each bill (electricity, internet, etc.)
2. Create category "BILLS:UTILITIES"
3. Create planned payments for each bill
4. Set frequency to "Monthly"
5. Set appropriate due dates

### Managing Subscriptions

1. Create recipients for services (Netflix, Spotify, etc.)
2. Create category "ENTERTAINMENT:STREAMING"
3. Create recurring planned payments
4. Set to "Monthly" frequency
5. Track in the dashboard

### Weekly Budgeting

1. Create planned payment for weekly allowance
2. Set frequency to "Weekly"
3. Set due date to preferred day (e.g., Monday)
4. Track weekly expenses against this budget

### Salary/Income Tracking

1. Create recipient "Employer"
2. Create planned payment with positive amount
3. Set frequency to match pay schedule (biweekly, monthly)
4. Set due date to payday

## Troubleshooting

### "Cannot create planned transaction"
- **Cause**: No recipients exist in the system
- **Solution**: Go to Recipients page and create at least one recipient first

### Planned payment not showing
- **Check**: Is the payment marked as inactive?
- **Solution**: Click toggle to reactivate

### Wrong estimated monthly amount
- **Check**: Frequency settings on recurring payments
- **Solution**: Edit payment and verify frequency is correct

### Can't select category
- **Cause**: No categories exist in the system
- **Solution**: Categories are optional, or create categories first

## Tips & Best Practices

1. **Use meaningful names**: "Netflix subscription" instead of just "Netflix"
2. **Negative amounts for expenses**: Follow convention for easy tracking
3. **Keep recipients organized**: Use consistent naming (all caps, etc.)
4. **Review regularly**: Check the "Due This Week" card frequently
5. **Use categories wisely**: Organize by type (BILLS, ENTERTAINMENT, etc.)
6. **Set bank accounts**: Track which account each payment comes from
7. **Add notes**: Include account numbers, reference codes, etc.
8. **Inactive vs Delete**: Use inactive for temporary pauses, delete for permanent removal

## Keyboard Shortcuts (Future Enhancement)

- `Ctrl/Cmd + N`: New planned payment
- `Esc`: Close dialog
- `/`: Focus search (when implemented)

## API Rate Limits

No rate limits currently enforced in development. Production may implement:
- Max 100 requests per minute per user
- Bulk operations count as single request

## Support

For issues or feature requests:
1. Check console for detailed error messages
2. Verify backend is running on port 3002
3. Check network tab for failed API calls
4. Review this documentation
5. Contact development team with:
   - Error message
   - Steps to reproduce
   - Browser console logs
   - Expected vs actual behavior
