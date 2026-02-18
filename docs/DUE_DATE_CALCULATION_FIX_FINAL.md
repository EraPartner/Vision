# Due Date Calculation Fix - Complete Solution

## Issue
The due date calculation was showing incorrect values:
- When today is February 18, 2026, selecting February 19 in the form was showing as "Today"
- Selecting February 20 was showing as "In 1d" instead of "In 2d"

## Root Causes

### 1. Timezone Issue in Date Display (PlannedPaymentsPage)
When normalizing dates to midnight using `.setHours(0, 0, 0, 0)`, UTC conversion was causing the date to shift backward by one day in certain timezones (like CET +01:00).

### 2. Timezone Issue in Date Saving (PlannedPaymentForm)
**This was the main issue you were experiencing!**

When saving a date selected in the calendar, the form was using `.toISOString().split("T")[0]` which converts to UTC, causing a one-day shift:
- User selects **Feb 19** locally
- `.toISOString()` converts it to **"2026-02-18"** (shifted back by 1 day!)
- When displayed, Feb 18 shows as "Today" instead of "In 1d"

## Solutions

### Fix 1: PlannedPaymentsPage - Display Logic

Use local date components exclusively for comparison:

```typescript
function dueBadge(dateStr: string) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dueDate = new Date(year, month - 1, day);
  
  const today = new Date();
  
  // Extract local components (no UTC conversion)
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const todayDay = today.getDate();
  
  const dueYear = dueDate.getFullYear();
  const dueMonth = dueDate.getMonth();
  const dueDay = dueDate.getDate();
  
  // Check if same day
  if (todayYear === dueYear && todayMonth === dueMonth && todayDay === dueDay) {
    return <Badge>Today</Badge>;
  }
  
  // Create normalized dates for difference calculation
  const normalizedToday = new Date(todayYear, todayMonth, todayDay);
  const normalizedDue = new Date(dueYear, dueMonth, dueDay);
  const days = differenceInDays(normalizedDue, normalizedToday);
  
  if (days < 0) return <Badge>Overdue</Badge>;
  if (days <= 7) return <Badge>In {days}d</Badge>;
  return <Badge>{format(dueDate, "PP")}</Badge>;
}
```

### Fix 2: PlannedPaymentForm - Date Conversion

Replace `.toISOString()` with local date component extraction:

```typescript
// OLD METHOD (BROKEN):
due_date: dueDate.toISOString().split("T")[0]  // Converts to UTC!

// NEW METHOD (FIXED):
const year = dueDate.getFullYear();
const month = String(dueDate.getMonth() + 1).padStart(2, '0');
const day = String(dueDate.getDate()).padStart(2, '0');
const dueDateStr = `${year}-${month}-${day}`;
// ...
due_date: dueDateStr
```

## Test Results

### Form Date Conversion Test
When selecting dates in the calendar (timezone: CET +01:00):

| Selected Date | OLD (.toISOString()) | NEW (local) | Status |
|---------------|---------------------|-------------|--------|
| Feb 18, 2026 | 2026-02-17 ❌ | 2026-02-18 ✓ | Fixed |
| Feb 19, 2026 | 2026-02-18 ❌ | 2026-02-19 ✓ | Fixed |
| Feb 20, 2026 | 2026-02-19 ❌ | 2026-02-20 ✓ | Fixed |

### Display Test
With today = February 18, 2026:

| Stored Date | Expected Display | Actual | Status |
|------------|------------------|--------|--------|
| 2026-02-18 | Today | Today | ✓ |
| 2026-02-19 | In 1d | In 1d | ✓ |
| 2026-02-20 | In 2d | In 2d | ✓ |
| 2026-02-25 | In 7d | In 7d | ✓ |
| 2026-02-17 | Overdue | Overdue | ✓ |

## Files Modified

1. **`/apps/frontend/src/pages/PlannedPaymentsPage.tsx`**
   - Updated `dueBadge()` function (lines 22-52)
   - Updated `upcoming` calculation in useMemo (lines 92-108)

2. **`/apps/frontend/src/components/planned/PlannedPaymentForm.tsx`**
   - Fixed date conversion in form submission (lines 73-77)
   - Replaced `.toISOString()` with local component extraction

## Technical Details

### Why `.toISOString()` Fails

When you have a Date object in local timezone (e.g., CET +01:00):
```javascript
const date = new Date(2026, 1, 19); // Feb 19, 2026 in local time
// Internally: 2026-02-19T00:00:00+01:00 (CET)

date.toISOString(); // Returns: "2026-02-18T23:00:00.000Z"
// Converts to UTC by subtracting 1 hour → goes back to Feb 18!

date.toISOString().split("T")[0]; // "2026-02-18" ❌ WRONG!
```

### Why Local Components Work

```javascript
const date = new Date(2026, 1, 19); // Feb 19, 2026
const year = date.getFullYear();     // 2026
const month = date.getMonth() + 1;   // 2 (February, +1 because 0-indexed)
const day = date.getDate();          // 19

const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
// "2026-02-19" ✓ CORRECT!
```

## Impact

This fix resolves the complete date handling issue:
1. ✅ Dates are saved correctly when selected in the calendar
2. ✅ Dates are displayed correctly with accurate "days until" calculation
3. ✅ Works consistently across all timezones
4. ✅ No more off-by-one errors in date selection and display

## Notes

- This is a common pitfall when working with dates in JavaScript
- Always use local date methods (`.getFullYear()`, `.getMonth()`, `.getDate()`) when you want calendar dates
- Only use `.toISOString()` when you specifically need UTC timestamps
- The YYYY-MM-DD format in the database remains unchanged and correct

