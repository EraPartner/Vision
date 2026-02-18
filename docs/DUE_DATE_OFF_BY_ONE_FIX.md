# Due Date Off-by-One Error Fix

## Problem
When viewing planned payments in the browser, dates were showing as one day earlier than expected. For example:
- If today is the 18th and a payment is due on the 19th, it showed "Today" instead of "Tomorrow"
- If a payment is due on the 20th, it showed "Tomorrow" instead of "In 2d"

## Root Cause
JavaScript's `new Date(string)` constructor interprets date strings in ISO format (YYYY-MM-DD) as **UTC midnight**, not local time. 

For users in timezones behind UTC (like Americas), this causes:
```javascript
// When parsing "2026-02-19"
const date = new Date("2026-02-19");  // Interprets as 2026-02-19T00:00:00.000Z (UTC)

// In EST (UTC-5), this Date object represents:
// 2026-02-18T19:00:00.000 local time (still the 18th!)

date.getDate();  // Returns 18, not 19!
```

## Solution
Parse date strings explicitly in local time by using the Date constructor with year, month, and day parameters:

```typescript
function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);  // Local midnight
}
```

## Files Changed

### 1. PlannedPaymentForm.tsx
**Problem**: When editing a payment, the date was parsed as UTC, causing the wrong day to be selected in the calendar.

**Fix**: Added `parseLocalDate` helper and used it instead of `new Date(string)`:
```typescript
const [dueDate, setDueDate] = useState<Date | undefined>(
  initial?.due_date ? parseLocalDate(initial.due_date) : undefined
);
```

### 2. PlannedPaymentsPage.tsx
**Problem**: The `dueBadge` function was correctly normalized, but needed to ensure consistency.

**Current implementation**: Already correct - normalizes both today and due date to local midnight:
```typescript
function dueBadge(dateStr: string) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const today = new Date();
  const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
  const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);
  const days = differenceInDays(normalizedDue, normalizedToday);
  // ... rest of logic
}
```

## Testing
Run the browser test to verify the fix:
```bash
# Open in browser:
open browser_date_test.html
```

Expected results:
- Today's date → "Today" (0 days)
- Tomorrow's date → "Tomorrow" (1 day)
- Day after tomorrow → "In 2d" (2 days)

## Key Takeaways
1. **Never use `new Date(string)` for date-only values** - it always interprets as UTC
2. **Always parse YYYY-MM-DD strings explicitly** using the Date constructor with components
3. **Normalize to midnight** when comparing dates (hours, minutes, seconds, milliseconds = 0)
4. **Test in different timezones** to catch these issues early

## References
- [MDN: Date constructor](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/Date)
- [ISO 8601 date strings are interpreted as UTC](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#date_time_string_format)
