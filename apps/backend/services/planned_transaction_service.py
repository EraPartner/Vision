"""Planned Transaction Service module.

This module provides high-level business logic for planned transaction management operations.
It handles planned transaction lifecycle operations such as creation, updates, deletions,
and conversion to actual transactions.

The service layer is responsible for:
- Planned transaction creation
- Planned transaction deletion (soft and hard)
- Planned transaction lifecycle management
- Business rule enforcement
- Logging and monitoring planned transaction operations
- Converting planned transactions to actual transactions
"""
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import PlannedTransaction, PlannedTransactionExecution, Transaction
from repositories.planned_transaction_repository import PlannedTransactionRepository
from services.recurrence_service import RecurrenceService

logger = setup_logging(__name__)


class PlannedTransactionService:
    """Service for managing planned transaction lifecycle operations.

    Provides high-level business logic for planned transaction management operations,
    coordinating with the repository layer and enforcing business rules.

    Attributes:
        db (Session): SQLAlchemy database session.
        planned_txn_repo (PlannedTransactionRepository): Repository for planned transaction data access.
    """

    def __init__(self, db: Session):
        """Initialise the planned transaction service with a database session.

        Args:
            db (Session): SQLAlchemy database session for repository operations.
        """
        self.db = db
        self.planned_txn_repo = PlannedTransactionRepository(db)

    def create(
            self,
            planned_date: date,
            bank_account: str,
            recipient_id: int,
            amount: float,
            memo: Optional[str] = None,
            currency: Optional[str] = None,
            category_id: Optional[int] = None,
            comment: Optional[str] = None,
            url: Optional[str] = None,
            is_recurring: bool = False,
            recurrence_pattern: Optional[str] = None
    ) -> PlannedTransaction:
        """Create a new planned transaction with validation.

        Creates a new planned financial transaction with all required and optional fields.
        Validates business rules and ensures data integrity before persisting.

        Args:
            planned_date (date): Planned transaction date (required).
            bank_account (str): Bank account name (required).
            recipient_id (int): Recipient ID - must reference existing recipient (required).
            amount (float): Transaction amount (required).
            memo (Optional[str]): Transaction memo/note.
            currency (Optional[str]): Currency code (EUR, USD, etc.), max 3 characters.
            category_id (Optional[int]): Category ID - must reference existing category if provided.
            comment (Optional[str]): Additional comment.
            url (Optional[str]): URL associated with the transaction.
            is_recurring (bool): Whether this is a recurring transaction (default: False).
            recurrence_pattern (Optional[str]): Recurrence pattern (e.g., 'monthly', 'weekly').

        Returns:
            PlannedTransaction: The newly created planned transaction with database-generated fields.

        Raises:
            ValueError: If validation fails (invalid recipient_id, category_id, etc.).

        Example:
            service = PlannedTransactionService(db)

            # Create a basic planned transaction
            planned_txn = service.create(
                planned_date=date(2026, 3, 15),
                bank_account="Revolut",
                recipient_id=5,
                amount=25.50
            )

            # Create a recurring planned transaction
            planned_txn = service.create(
                planned_date=date(2026, 3, 1),
                bank_account="KBC",
                recipient_id=10,
                amount=150.00,
                is_recurring=True,
                recurrence_pattern="monthly"
            )
        """
        logger.info(
            f"Creating planned transaction: planned_date={planned_date}, "
            f"recipient_id={recipient_id}, amount={amount}, recurring={is_recurring}"
        )

        # Create planned transaction model
        planned_transaction = PlannedTransaction(
            planned_date=planned_date,
            bank_account=bank_account,
            recipient_id=recipient_id,
            amount=amount,
            memo=memo,
            currency=currency,
            category_id=category_id,
            comment=comment,
            url=url,
            is_recurring=is_recurring,
            recurrence_pattern=recurrence_pattern,
            is_executed=False,
            is_active=True
        )

        # Create in database
        created = self.planned_txn_repo.create(planned_transaction)

        logger.info(f"Successfully created planned transaction ID {created.id}")
        return created

    def delete_planned_transaction(self, planned_transaction_id: int, soft: bool = True) -> bool:
        """Delete a planned transaction (soft or hard delete).

        Removes a planned transaction from the system. By default performs a soft delete
        (sets is_active=False), preserving data for audit purposes. Hard delete
        permanently removes the record from the database.

        Args:
            planned_transaction_id (int): ID of the planned transaction to delete.
            soft (bool): If True, perform soft delete (default). If False, perform hard delete.

        Returns:
            bool: True if deletion was successful, False if planned transaction not found.

        Example:
            service = PlannedTransactionService(db)

            # Soft delete (recommended)
            success = service.delete_planned_transaction(123, soft=True)

            # Hard delete (permanent)
            success = service.delete_planned_transaction(123, soft=False)
        """
        logger.info(f"Deleting planned transaction ID {planned_transaction_id}, soft={soft}")

        if soft:
            result = self.planned_txn_repo.delete_soft(planned_transaction_id)
        else:
            result = self.planned_txn_repo.delete_hard(planned_transaction_id)

        if result:
            logger.info(f"Successfully deleted planned transaction ID {planned_transaction_id}")
        else:
            logger.warning(f"Planned transaction ID {planned_transaction_id} not found for deletion")

        return result

    def execute_planned_transaction(
            self,
            planned_transaction_id: int,
            executed_transaction_id: int,
            execution_date: Optional[date] = None
    ) -> Optional[PlannedTransaction]:
        """Execute a planned transaction by linking it to an actual transaction.

        This method handles both one-time and recurring planned transactions:
        - For one-time transactions: marks as executed permanently
        - For recurring transactions: creates execution record, resets is_executed to False,
          and updates planned_date to the next occurrence

        Args:
            planned_transaction_id (int): ID of the planned transaction to execute.
            executed_transaction_id (int): ID of the actual transaction that was created.
            execution_date (Optional[date]): Date of execution (defaults to today).

        Returns:
            Optional[PlannedTransaction]: Updated planned transaction if successful, None otherwise.

        Raises:
            ValueError: If planned transaction is already executed or transaction doesn't exist.

        Example:
            service = PlannedTransactionService(db)

            # Execute a planned transaction
            planned_txn = service.execute_planned_transaction(
                planned_transaction_id=123,
                executed_transaction_id=456
            )
        """
        if execution_date is None:
            execution_date = date.today()

        logger.info(
            f"Executing planned transaction ID {planned_transaction_id} "
            f"with transaction ID {executed_transaction_id}"
        )

        # Fetch planned transaction
        planned_transaction = self.planned_txn_repo.get_by_id(planned_transaction_id)
        if not planned_transaction:
            logger.warning(f"Planned transaction ID {planned_transaction_id} not found")
            return None

        # Validate that it's not already executed
        if planned_transaction.is_executed:
            raise ValueError(
                f"Planned transaction ID {planned_transaction_id} is already executed. "
                f"Cannot execute until reset."
            )

        # Verify the executed transaction exists
        executed_transaction = self.db.query(Transaction).filter(
            Transaction.id == executed_transaction_id
        ).first()
        if not executed_transaction:
            raise ValueError(
                f"Transaction ID {executed_transaction_id} not found. "
                f"Cannot link to non-existent transaction."
            )

        # Create execution record
        execution_record = PlannedTransactionExecution(
            planned_transaction_id=planned_transaction_id,
            executed_transaction_id=executed_transaction_id,
            execution_date=execution_date
        )
        self.db.add(execution_record)

        # Update planned transaction
        planned_transaction.last_executed_date = execution_date

        # Handle recurring vs one-time transactions
        if planned_transaction.is_recurring and planned_transaction.recurrence_pattern:
            # Calculate next occurrence date based on the original planned_date
            # (not execution_date, to maintain consistent billing dates)
            next_date = RecurrenceService.calculate_next_date(
                planned_transaction.planned_date,
                planned_transaction.recurrence_pattern
            )

            if next_date:
                planned_transaction.planned_date = next_date
                planned_transaction.is_executed = False  # Reset for next occurrence
                logger.info(
                    f"Recurring transaction ID {planned_transaction_id} reset. "
                    f"Next occurrence: {next_date}"
                )
            else:
                logger.warning(
                    f"Could not calculate next date for pattern '{planned_transaction.recurrence_pattern}'. "
                    f"Marking as executed."
                )
                planned_transaction.is_executed = True
        else:
            # One-time transaction - mark as executed permanently
            planned_transaction.is_executed = True
            logger.info(f"One-time planned transaction ID {planned_transaction_id} marked as executed")

        # Persist changes
        self.db.commit()
        self.db.refresh(planned_transaction)

        logger.info(f"Successfully executed planned transaction ID {planned_transaction_id}")
        return planned_transaction

    def mark_as_executed(
            self,
            planned_transaction_id: int,
            executed_transaction_id: Optional[int] = None
    ) -> Optional[PlannedTransaction]:
        """Mark a planned transaction as executed (deprecated - use execute_planned_transaction).

        This method is maintained for backward compatibility but is deprecated.
        Use execute_planned_transaction() instead for proper recurring transaction handling.

        Args:
            planned_transaction_id (int): ID of the planned transaction.
            executed_transaction_id (Optional[int]): ID of the created actual transaction (ignored).

        Returns:
            Optional[PlannedTransaction]: Updated planned transaction if found, None otherwise.
        """
        logger.warning(
            "mark_as_executed() is deprecated. Use execute_planned_transaction() instead."
        )

        planned_transaction = self.planned_txn_repo.get_by_id(planned_transaction_id)
        if not planned_transaction:
            logger.warning(f"Planned transaction ID {planned_transaction_id} not found")
            return None

        planned_transaction.is_executed = True

        updated = self.planned_txn_repo.update(planned_transaction)
        logger.info(f"Successfully marked planned transaction ID {planned_transaction_id} as executed")
        return updated
