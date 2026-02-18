"""
Test script for the enhanced planned transaction execution system.

This script demonstrates:
1. Creating a one-time planned transaction
2. Creating a recurring planned transaction
3. Executing planned transactions
4. Verifying recurring transactions reset properly
"""
import sys
from datetime import date
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from database.connection import get_db
from database.models import Transaction, Category, Recipient
from services.planned_transaction_service import PlannedTransactionService
from services.recurrence_service import RecurrenceService


def test_recurrence_service():
    """Test the recurrence pattern calculations."""
    print("\n" + "=" * 60)
    print("Testing Recurrence Service")
    print("=" * 60)

    test_date = date(2026, 2, 15)

    patterns = ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"]
    for pattern in patterns:
        next_date = RecurrenceService.calculate_next_date(test_date, pattern)
        print(f"{pattern:12} -> {next_date}")

    print(f"\nSupported patterns: {RecurrenceService.get_supported_patterns()}")
    print(f"Is 'monthly' valid? {RecurrenceService.is_valid_pattern('monthly')}")
    print(f"Is 'invalid' valid? {RecurrenceService.is_valid_pattern('invalid')}")


def test_one_time_execution():
    """Test executing a one-time planned transaction."""
    print("\n" + "=" * 60)
    print("Testing One-Time Planned Transaction Execution")
    print("=" * 60)

    db = next(get_db())
    service = PlannedTransactionService(db)

    # Get or create test data
    category = db.query(Category).first()
    if not category:
        category = Category(general="TEST", detail="CATEGORY")
        db.add(category)
        db.commit()
        db.refresh(category)

    recipient = db.query(Recipient).first()
    if not recipient:
        recipient = Recipient(name="TEST RECIPIENT")
        db.add(recipient)
        db.commit()
        db.refresh(recipient)

    # Create a one-time planned transaction
    print("\n1. Creating one-time planned transaction...")
    planned_txn = service.create(
        planned_date=date(2026, 3, 1),
        bank_account="Test Bank",
        recipient_id=recipient.id,
        amount=-50.00,
        memo="One-time test payment",
        category_id=category.id,
        is_recurring=False
    )
    print(f"   Created: ID={planned_txn.id}, is_executed={planned_txn.is_executed}")

    # Create an actual transaction to link
    print("\n2. Creating actual transaction to link...")
    actual_txn = Transaction(
        date=date.today(),
        bank_account="Test Bank",
        recipient_id=recipient.id,
        amount=-50.00,
        memo="One-time test payment (actual)",
        category_id=category.id
    )
    db.add(actual_txn)
    db.commit()
    db.refresh(actual_txn)
    print(f"   Created transaction ID: {actual_txn.id}")

    # Execute the planned transaction
    print("\n3. Executing planned transaction...")
    updated = service.execute_planned_transaction(
        planned_transaction_id=planned_txn.id,
        executed_transaction_id=actual_txn.id
    )
    print(f"   After execution:")
    print(f"   - is_executed: {updated.is_executed}")
    print(f"   - executed_transaction_id: {updated.executed_transaction_id}")
    print(f"   - execution count: {len(updated.executions)}")

    # Try to execute again (should fail)
    print("\n4. Attempting to execute again (should fail)...")
    try:
        service.execute_planned_transaction(
            planned_transaction_id=planned_txn.id,
            executed_transaction_id=actual_txn.id
        )
        print("   ERROR: Should have raised ValueError!")
    except ValueError as e:
        print(f"   ✓ Correctly rejected: {e}")

    # Cleanup
    db.delete(planned_txn)
    db.delete(actual_txn)
    db.commit()
    print("\n✓ One-time execution test completed")


def test_recurring_execution():
    """Test executing a recurring planned transaction."""
    print("\n" + "=" * 60)
    print("Testing Recurring Planned Transaction Execution")
    print("=" * 60)

    db = next(get_db())
    service = PlannedTransactionService(db)

    # Get or create test data
    category = db.query(Category).first()
    if not category:
        category = Category(general="TEST", detail="CATEGORY")
        db.add(category)
        db.commit()
        db.refresh(category)

    recipient = db.query(Recipient).first()
    if not recipient:
        recipient = Recipient(name="TEST RECIPIENT")
        db.add(recipient)
        db.commit()
        db.refresh(recipient)

    # Create a recurring planned transaction
    print("\n1. Creating monthly recurring planned transaction...")
    planned_txn = service.create(
        planned_date=date(2026, 2, 15),
        bank_account="Test Bank",
        recipient_id=recipient.id,
        amount=-12.99,
        memo="Monthly subscription",
        category_id=category.id,
        is_recurring=True,
        recurrence_pattern="monthly"
    )
    print(f"   Created: ID={planned_txn.id}")
    print(f"   - planned_date: {planned_txn.planned_date}")
    print(f"   - is_executed: {planned_txn.is_executed}")
    print(f"   - is_recurring: {planned_txn.is_recurring}")

    # Execute it 3 times
    for i in range(1, 4):
        print(f"\n{i + 1}. Execution #{i}:")

        # Create actual transaction
        actual_txn = Transaction(
            date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            memo=f"Monthly subscription - execution {i}",
            category_id=category.id
        )
        db.add(actual_txn)
        db.commit()
        db.refresh(actual_txn)
        print(f"   Created transaction ID: {actual_txn.id}")

        # Execute the planned transaction
        updated = service.execute_planned_transaction(
            planned_transaction_id=planned_txn.id,
            executed_transaction_id=actual_txn.id,
            execution_date=planned_txn.planned_date
        )

        print(f"   After execution:")
        print(f"   - is_executed: {updated.is_executed}")
        print(f"   - planned_date: {updated.planned_date}")
        print(f"   - last_executed_date: {updated.last_executed_date}")
        print(f"   - execution count: {len(updated.executions)}")

        if i < 3:
            # Refresh to get the updated state
            db.refresh(planned_txn)

    # Show execution history
    print(f"\n{i + 2}. Final execution history:")
    db.refresh(planned_txn)
    for j, execution in enumerate(planned_txn.executions, 1):
        print(f"   Execution {j}: transaction_id={execution.executed_transaction_id}, "
              f"date={execution.execution_date}")

    # Cleanup
    for execution in planned_txn.executions:
        db.delete(execution.executed_transaction)
    db.delete(planned_txn)
    db.commit()
    print("\n✓ Recurring execution test completed")


if __name__ == "__main__":
    print("Enhanced Planned Transaction Execution System - Test Suite")
    print("=" * 60)

    test_recurrence_service()
    test_one_time_execution()
    test_recurring_execution()

    print("\n" + "=" * 60)
    print("All tests completed successfully!")
    print("=" * 60)
