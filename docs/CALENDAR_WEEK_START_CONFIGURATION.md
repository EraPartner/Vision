# Calendar Week Start Configuration - Monday First

## Summary

Updated all date picker/calendar components across the frontend application to display Monday as the first day of the week and Sunday as the last day, following the ISO 8601 standard and European convention.

## Change Made

### Calendar Component (`/apps/frontend/src/components/ui/calendar.tsx`)

Added the `weekStartsOn={1}` prop to the DayPicker component:

```typescript
<DayPicker
    showOutsideDays={showOutsideDays}
    weekStartsOn={1}  // 1 = Monday, 0 = Sunday
    className={cn("p-3", className)}
    // ...rest of props
/>
```

## Impact

This change affects all calendar instances throughout the application:

### Components Using Calendar:

1. **PlannedPaymentForm** (`/components/planned/PlannedPaymentForm.tsx`)
   - Due date picker for planned payments
   - End date picker for recurring payments
   - Used when creating/editing planned transactions

### Calendar Week Layout

**Before:**
```
Su Mo Tu We Th Fr Sa
26 27 28 29 30 31  1
 2  3  4  5  6  7  8
```

**After:**
```
Mo Tu We Th Fr Sa Su
27 28 29 30 31  1  2
 3  4  5  6  7  8  9
```

## Technical Details

### react-day-picker Configuration

The `weekStartsOn` prop accepts:
- `0` = Sunday (US convention)
- `1` = Monday (ISO 8601 / European convention) ✓ **Applied**
- `2` = Tuesday
- etc.

### Centralized Implementation

By updating the base `Calendar` component, this change automatically applies to **all** calendar instances throughout the application without needing individual updates to each usage.

### Components Affected:

1. ✅ Planned Payment Form - Due date selection
2. ✅ Planned Payment Form - End date selection (for recurring)
3. ✅ Any future components that use the Calendar component

## Benefits

1. **Consistency**: All calendars show the same week start across the entire application
2. **ISO 8601 Compliance**: Follows international standard for week numbering
3. **European Convention**: Aligns with European business week structure
4. **User Expectation**: Matches common calendar convention in many regions
5. **Maintainability**: Single change point for all calendars

## Standards Compliance

This change aligns with:
- **ISO 8601**: International standard defining Monday as the first day
- **European Convention**: Common in EU, UK, and many other regions
- **Business Week**: Aligns with Monday-Friday business week

## Testing Recommendations

1. Open Planned Payments page
2. Click "New Payment" button
3. Click the due date field to open calendar
4. Verify Monday appears as the first column
5. Verify Sunday appears as the last column
6. Test with recurring payments end date picker
7. Verify consistency across all date selections

## Date: February 18, 2026
