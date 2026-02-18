"""
Quick test to verify the due date calculation fix.
Run this to ensure the recurrence calculation is working correctly.
"""
import os
import sys
from datetime import date

# Add parent directory to path to import the service
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.recurrence_service import RecurrenceService


def test_monthly_recurrence():
    """Test monthly recurrence maintains the same day of month."""
    print("Testing monthly recurrence...")

    # Test normal month
    current = date(2026, 2, 15)
    next_date = RecurrenceService.calculate_next_date(current, "monthly")
    assert next_date == date(2026, 3, 15), f"Expected 2026-03-15, got {next_date}"
    print(f"  ✓ Feb 15 → Mar 15: {next_date}")

    # Test month-end edge case
    current = date(2026, 1, 31)
    next_date = RecurrenceService.calculate_next_date(current, "monthly")
    # Feb doesn't have 31 days, should be Feb 28/29
    assert next_date.month == 2 and next_date.day in [28, 29], f"Expected Feb 28/29, got {next_date}"
    print(f"  ✓ Jan 31 → Feb {next_date.day}: {next_date}")

    print("Monthly recurrence: PASSED ✓\n")


def test_weekly_recurrence():
    """Test weekly recurrence adds 7 days."""
    print("Testing weekly recurrence...")

    current = date(2026, 2, 15)
    next_date = RecurrenceService.calculate_next_date(current, "weekly")
    assert next_date == date(2026, 2, 22), f"Expected 2026-02-22, got {next_date}"
    print(f"  ✓ Feb 15 → Feb 22: {next_date}")

    print("Weekly recurrence: PASSED ✓\n")


def test_custom_days():
    """Test custom day intervals."""
    print("Testing custom day intervals...")

    # Test "every 10 days"
    current = date(2026, 2, 15)
    next_date = RecurrenceService.calculate_next_date(current, "every 10 days")
    assert next_date == date(2026, 2, 25), f"Expected 2026-02-25, got {next_date}"
    print(f"  ✓ every 10 days: Feb 15 → Feb 25: {next_date}")

    # Test "every 1 day" (singular)
    next_date = RecurrenceService.calculate_next_date(current, "every 1 day")
    assert next_date == date(2026, 2, 16), f"Expected 2026-02-16, got {next_date}"
    print(f"  ✓ every 1 day: Feb 15 → Feb 16: {next_date}")

    # Test "every 45 days"
    next_date = RecurrenceService.calculate_next_date(current, "every 45 days")
    assert next_date == date(2026, 4, 1), f"Expected 2026-04-01, got {next_date}"
    print(f"  ✓ every 45 days: Feb 15 → Apr 1: {next_date}")

    print("Custom day intervals: PASSED ✓\n")


def test_all_patterns():
    """Test all standard patterns."""
    print("Testing all standard patterns...")

    current = date(2026, 2, 15)

    patterns = {
        "daily": date(2026, 2, 16),
        "weekly": date(2026, 2, 22),
        "biweekly": date(2026, 3, 1),
        "monthly": date(2026, 3, 15),
        "quarterly": date(2026, 5, 15),
        "yearly": date(2026, 2, 15) + (date(2027, 2, 15) - date(2026, 2, 15)),
    }

    for pattern, expected in patterns.items():
        next_date = RecurrenceService.calculate_next_date(current, pattern)
        assert next_date == expected, f"{pattern}: Expected {expected}, got {next_date}"
        print(f"  ✓ {pattern}: {current} → {next_date}")

    print("All standard patterns: PASSED ✓\n")


if __name__ == "__main__":
    print("=" * 60)
    print("Due Date Calculation Fix - Verification Tests")
    print("=" * 60)
    print()

    try:
        test_monthly_recurrence()
        test_weekly_recurrence()
        test_custom_days()
        test_all_patterns()

        print("=" * 60)
        print("ALL TESTS PASSED ✓✓✓")
        print("=" * 60)

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
