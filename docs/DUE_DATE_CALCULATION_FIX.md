# Due Date Calculation Fix for Recurring Planned Transactions

## Issue

The due date calculation for recurring planned transactions was incorrect. When executing a planned transaction, the next occurrence date was being calculated based on the `execution_date` instead of the original `planned_date`.

### Problem Example

If you had a monthly bill planned for the 15th of each month:
- **Planned Date**: February 15, 2026
- **Execution Date**: February 20, 2026 (executed 5 days late)
- **Incorrect Next Date**: March 20, 2026 (based on execution date)
- **Correct Next Date**: March 15, 2026 (based on planned date)

This caused the due dates to drift over time if payments were executed late or early.

## Root Cause

In `planned_transaction_service.py`, the `execute_planned_transaction` method was calling:

```python
next_date = RecurrenceService.calculate_next_date(
    execution_date,  # ❌ WRONG - uses when payment was marked executed
    planned_transaction.recurrence_pattern
)
```

## Solution

### 1. Fixed Date Calculation Logic (`planned_transaction_service.py`)

Updated to use the original `planned_date` instead of `execution_date`:

```python
next_date = RecurrenceService.calculate_next_date(
    planned_transaction.planned_date,  # ✅ CORRECT - maintains consistent billing dates
    planned_transaction.recurrence_pattern
)
```

**Rationale**: 
- Recurring bills should maintain consistent dates (e.g., always the 15th of each month)
- Execution timing should not affect when the next payment is due
- This matches real-world billing cycles (Netflix charges on the same day each month regardless of when you acknowledge the charge)

### 2. Added Custom Interval Support (`recurrence_service.py`)

Added support for custom day intervals like "every 10 days":

```python
elif pattern.startswith("every ") and "day" in pattern:
    # Handle custom patterns like "every 10 days"
    import re
    match = re.search(r'every\s+(\d+)\s+days?', pattern)
    if match:
        days = int(match.group(1))
        return current_date + timedelta(days=days)
```

**Why this was needed**:
- Frontend already supports custom intervals (e.g., "every 10 days")
- Backend was silently failing to calculate next dates for these patterns
- Transactions with custom patterns would be incorrectly marked as executed

## Behavior After Fix

### Standard Patterns (daily, weekly, biweekly, monthly, quarterly, yearly)

| Pattern    | Planned Date  | Execution Date | Next Planned Date |
|------------|---------------|----------------|-------------------|
| Monthly    | Feb 15, 2026  | Feb 20, 2026   | Mar 15, 2026      |
| Monthly    | Feb 15, 2026  | Feb 10, 2026   | Mar 15, 2026      |
| Weekly     | Feb 15, 2026  | Feb 20, 2026   | Feb 22, 2026      |
| Quarterly  | Feb 15, 2026  | Mar 1, 2026    | May 15, 2026      |

### Custom Patterns

| Pattern        | Planned Date  | Execution Date | Next Planned Date |
|----------------|---------------|----------------|-------------------|
| Every 10 days  | Feb 15, 2026  | Feb 20, 2026   | Feb 25, 2026      |
| Every 45 days  | Feb 15, 2026  | Feb 15, 2026   | Apr 1, 2026       |

## Edge Cases Handled

### Month-End Dates
The `relativedelta` library properly handles month-end edge cases:
- Jan 31 + 1 month = Feb 28/29 (not March 3)
- Feb 29 (leap year) + 1 month = Mar 29
- May 31 + 1 month = Jun 30

### Custom Pattern Parsing
- Pattern matching is case-insensitive
- Handles both singular and plural: "every 1 day" or "every 10 days"
- Robust regex parsing with error handling

## Testing Recommendations

1. **Test monthly recurring on 31st**:
   - Create planned transaction for Jan 31
   - Execute it
   - Verify next date is Feb 28/29 (not March 2/3)

2. **Test late execution**:
   - Create monthly transaction for the 15th
   - Execute it on the 25th
   - Verify next date is still the 15th of next month

3. **Test custom intervals**:
   - Create "every 10 days" recurring transaction
   - Execute and verify 10-day increment

4. **Test early execution**:
   - Create monthly transaction for the 15th  
   - Execute it on the 10th
   - Verify next date is still the 15th of next month

## Date: February 18, 2026
