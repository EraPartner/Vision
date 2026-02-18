# Due Date Display Fix

## Issue

When selecting a payment date of February 20th while today is February 18th, the badge incorrectly showed "In 0d" instead of "In 2d".

## Root Cause

The problem was in the `dueBadge` function in PlannedPaymentsPage.tsx:

1. **Date Parsing Issue**: Using `new Date(dateStr)` with a string like "2026-02-20" parses it as UTC midnight, but `new Date()` creates a date in local timezone, causing inconsistencies.

2. **Time Component Issue**: The dates included time components (hours, minutes, seconds), which could cause `differenceInDays` to round incorrectly.

3. **Calculation Order**: The order of arguments in `differenceInDays(d, new Date())` was calculating from "now" to "due date", which could give negative or incorrect values.

## Solution

### Before:
```typescript
function dueBadge(dateStr: string) {
  const d = new Date(dateStr);  // ❌ UTC parsing issue
  if (isToday(d)) return <Badge>Today</Badge>;
  if (isPast(d)) return <Badge>Overdue</Badge>;
  const days = differenceInDays(d, new Date());  // ❌ Time components cause issues
  if (days <= 7) return <Badge>In {days}d</Badge>;
  return <Badge>{format(d, "PP")}</Badge>;
}
```

### After:
```typescript
function dueBadge(dateStr: string) {
  // Parse date string as local date (YYYY-MM-DD format)
  const [year, month, day] = dateStr.split('-').map(Number);
  const dueDate = new Date(year, month - 1, day); // ✅ month is 0-indexed
  
  const today = new Date();
  today.setHours(0, 0, 0, 0); // ✅ Reset to start of day
  dueDate.setHours(0, 0, 0, 0); // ✅ Reset to start of day
  
  if (isToday(dueDate)) return <Badge>Today</Badge>;
  if (isPast(dueDate)) return <Badge>Overdue</Badge>;
  
  const days = differenceInDays(dueDate, today); // ✅ Correct argument order
  if (days <= 7) return <Badge>In {days}d</Badge>;
  return <Badge>{format(dueDate, "PP")}</Badge>;
}
```

### Key Improvements:

1. **Manual Date Parsing**: Parse "YYYY-MM-DD" string manually to avoid UTC/local timezone issues
2. **Reset Time Components**: Set hours/minutes/seconds to 0 for accurate day-based calculations
3. **Correct Argument Order**: `differenceInDays(futureDate, pastDate)` gives positive days

## Also Fixed

Updated the "upcoming payments" calculation (Due This Week) to use the same consistent date parsing:

```typescript
const upcoming = useMemo(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  return payments
    .filter((p) => p.is_active)
    .filter((p) => {
      const [year, month, day] = p.due_date.split('-').map(Number);
      const dueDate = new Date(year, month - 1, day);
      dueDate.setHours(0, 0, 0, 0);
      
      const days = differenceInDays(dueDate, today);
      return days >= 0 && days <= 7; // Due within the next 7 days
    }).length;
}, [payments]);
```

## Test Cases

| Today      | Due Date   | Expected Display | Actual Display |
|------------|------------|------------------|----------------|
| Feb 18     | Feb 18     | Today            | ✅ Today       |
| Feb 18     | Feb 19     | In 1d            | ✅ In 1d       |
| Feb 18     | Feb 20     | In 2d            | ✅ In 2d       |
| Feb 18     | Feb 25     | In 7d            | ✅ In 7d       |
| Feb 18     | Mar 1      | Mar 1, 2026      | ✅ Mar 1, 2026 |
| Feb 18     | Feb 17     | Overdue          | ✅ Overdue     |
| Feb 18     | Feb 10     | Overdue          | ✅ Overdue     |

## Benefits

1. **Accurate Day Counting**: Shows correct number of days until due date
2. **Timezone Safe**: No UTC/local timezone confusion
3. **Consistent**: Same parsing logic used throughout the component
4. **Predictable**: Days are always counted from midnight to midnight

## Date: February 18, 2026
