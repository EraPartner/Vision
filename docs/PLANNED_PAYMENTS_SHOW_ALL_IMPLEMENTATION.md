# Show All / Active Only Toggle for Planned Payments

## Summary

Implemented a "Show All" / "Active Only" toggle button for Planned Payments page to view inactive (paused/deleted) planned transactions, matching the workflow already present in Transactions, Categories, and Recipients pages.

## Changes Made

### 1. Updated Hook (`usePlannedPayments.ts`)

**Modified function signature:**
```typescript
export function usePlannedPayments(showInactive: boolean = false)
```

**Updated fetchPayments:**
- Now accepts `showInactive` parameter
- Passes `active: !showInactive` to API
- When `showInactive` is `true`, fetches all planned transactions (including inactive)
- When `showInactive` is `false` (default), fetches only active transactions

**Dependency update:**
- Added `showInactive` to the `useCallback` dependency array so the hook refetches when the toggle changes

### 2. Updated Page Component (`PlannedPaymentsPage.tsx`)

**Added state management:**
```typescript
const [showAll, setShowAll] = useState(false);
```

**Updated hook call:**
```typescript
const { payments, ... } = usePlannedPayments(showAll);
```

**Added toggle button:**
- Button shows "Active Only" with EyeOff icon when inactive view
- Button shows "Showing All" with Eye icon when showing all
- Button has visual state change (outline vs secondary variant)
- Placed next to "New Payment" button in header

**Added icon imports:**
- Imported `Eye` and `EyeOff` from lucide-react

## User Experience

### Active Only Mode (Default)
- Shows only active planned payments
- Button displays: 🚫 "Active Only"
- Button variant: outline
- Clean view of current/upcoming payments

### Show All Mode
- Shows all planned transactions including inactive/paused ones
- Button displays: 👁️ "Showing All"
- Button variant: secondary (highlighted)
- Inactive payments displayed with:
  - Muted text color
  - Line-through styling
  - "Paused" status label

## Workflow Consistency

This implementation ensures the planned payments workflow matches the existing pattern in:

1. **TransactionsPage** - Toggle between active and all transactions
2. **CategoriesPage** - Toggle between active and all categories  
3. **RecipientsPage** - Toggle between active and all recipients

All pages now share the same UX pattern:
- Same icon usage (Eye/EyeOff)
- Same button labels ("Active Only" / "Showing All")
- Same visual styling for inactive items (opacity + line-through)
- Same toggle behavior (refetches data with different filter)

## Backend Integration

The backend API already supports this functionality:

**Endpoint:** `GET /api/planned-transactions`

**Query Parameter:** `active` (boolean)
- `active=true` (default): Returns only active planned transactions
- `active=false`: Returns all planned transactions including inactive

**Repository Filter:**
```python
if active:
    query = query.filter(PlannedTransaction.is_active == True)
# If active is False, no filter is applied, returns all
```

## Visual Indicators for Inactive Payments

Inactive planned payments are already styled appropriately:
- Payment name: muted color with line-through
- Status badge: Shows "Paused" instead of "Active"
- Toggle icon: ToggleLeft (off state) instead of ToggleRight
- Execute button: Disabled for inactive payments

## Testing

To test the functionality:
1. Navigate to Planned Payments page
2. Click "Active Only" button to toggle to "Showing All"
3. Verify inactive payments appear with appropriate styling
4. Toggle back to "Active Only" 
5. Verify inactive payments are hidden
6. Create a payment and pause it (toggle active status)
7. Verify it only shows when "Show All" is enabled

## Benefits

1. **Consistency**: Matches workflow of other pages
2. **Visibility**: Users can audit all planned payments including paused ones
3. **Control**: Easy toggle without navigating away
4. **Clarity**: Visual indicators clearly show inactive state
5. **Flexibility**: Supports both focused (active only) and comprehensive (all) views

## Date: February 18, 2026
