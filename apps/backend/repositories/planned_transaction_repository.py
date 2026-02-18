"""Planned Transaction Repository module.

This module provides data access operations for planned transactions.
Follows the repository pattern for separation of concerns between
data access and business logic.
"""
from datetime import date
from typing import Optional, List

from sqlalchemy.orm import Session, joinedload

from config.logging_config import setup_logging
from database.models import PlannedTransaction

logger = setup_logging(__name__)


class PlannedTransactionRepository:
    """Repository for planned transaction data access operations.

    Provides methods for CRUD operations and queries on planned transactions.
    Handles database interactions and query construction.

    Attributes:
        db (Session): SQLAlchemy database session.
    """

    def __init__(self, db: Session):
        """Initialise the planned transaction repository.

        Args:
            db (Session): SQLAlchemy database session.
        """
        self.db = db

    def get_by_id(self, planned_transaction_id: int) -> Optional[PlannedTransaction]:
        """Retrieve a planned transaction by ID with eager loading of relationships.

        Args:
            planned_transaction_id (int): Planned transaction ID.

        Returns:
            Optional[PlannedTransaction]: Planned transaction if found, None otherwise.
        """
        return self.db.query(PlannedTransaction).options(
            joinedload(PlannedTransaction.recipient),
            joinedload(PlannedTransaction.category)
        ).filter(PlannedTransaction.id == planned_transaction_id).first()

    def get_all(
            self,
            limit: int = 50,
            offset: int = 0,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None,
            bank_account: Optional[str] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            is_recurring: Optional[bool] = None,
            is_executed: Optional[bool] = None,
            active: bool = True
    ) -> tuple[List[PlannedTransaction], int]:
        """Retrieve all planned transactions with pagination and filtering.

        Args:
            limit (int): Maximum number of results to return.
            offset (int): Number of results to skip.
            start_date (Optional[date]): Start date filter (inclusive).
            end_date (Optional[date]): End date filter (inclusive).
            bank_account (Optional[str]): Filter by bank account (partial match).
            category_id (Optional[int]): Filter by category ID.
            recipient_id (Optional[int]): Filter by recipient ID.
            is_recurring (Optional[bool]): Filter by recurring status.
            is_executed (Optional[bool]): Filter by execution status.
            active (bool): Filter by active status.

        Returns:
            tuple[List[PlannedTransaction], int]: Tuple of (planned transactions, total count).
        """
        query = self.db.query(PlannedTransaction).options(
            joinedload(PlannedTransaction.recipient),
            joinedload(PlannedTransaction.category)
        )

        # Apply filters
        if active:
            query = query.filter(PlannedTransaction.is_active == True)

        if start_date:
            query = query.filter(PlannedTransaction.planned_date >= start_date)

        if end_date:
            query = query.filter(PlannedTransaction.planned_date <= end_date)

        if bank_account:
            query = query.filter(PlannedTransaction.bank_account.ilike(f"%{bank_account}%"))

        if category_id is not None:
            query = query.filter(PlannedTransaction.category_id == category_id)

        if recipient_id is not None:
            query = query.filter(PlannedTransaction.recipient_id == recipient_id)

        if is_recurring is not None:
            query = query.filter(PlannedTransaction.is_recurring == is_recurring)

        if is_executed is not None:
            query = query.filter(PlannedTransaction.is_executed == is_executed)

        # Get total count
        total = query.count()

        # Apply pagination and ordering
        planned_transactions = query.order_by(PlannedTransaction.planned_date.desc()).limit(limit).offset(
            offset).all()

        return planned_transactions, total

    def create(self, planned_transaction: PlannedTransaction) -> PlannedTransaction:
        """Create a new planned transaction.

        Args:
            planned_transaction (PlannedTransaction): Planned transaction to create.

        Returns:
            PlannedTransaction: Created planned transaction with database-generated fields.
        """
        self.db.add(planned_transaction)
        self.db.commit()
        self.db.refresh(planned_transaction)
        logger.info(f"Created planned transaction ID {planned_transaction.id}")
        return planned_transaction

    def update(self, planned_transaction: PlannedTransaction) -> PlannedTransaction:
        """Update an existing planned transaction.

        Args:
            planned_transaction (PlannedTransaction): Planned transaction with updated fields.

        Returns:
            PlannedTransaction: Updated planned transaction.
        """
        self.db.commit()
        self.db.refresh(planned_transaction)
        logger.info(f"Updated planned transaction ID {planned_transaction.id}")
        return planned_transaction

    def delete_soft(self, planned_transaction_id: int) -> bool:
        """Soft delete a planned transaction by setting is_active to False.

        Args:
            planned_transaction_id (int): Planned transaction ID to soft delete.

        Returns:
            bool: True if deleted, False if not found.
        """
        planned_transaction = self.get_by_id(planned_transaction_id)
        if not planned_transaction:
            return False

        planned_transaction.is_active = False
        self.db.commit()
        logger.info(f"Soft deleted planned transaction ID {planned_transaction_id}")
        return True

    def delete_hard(self, planned_transaction_id: int) -> bool:
        """Hard delete a planned transaction from the database.

        Args:
            planned_transaction_id (int): Planned transaction ID to hard delete.

        Returns:
            bool: True if deleted, False if not found.
        """
        planned_transaction = self.get_by_id(planned_transaction_id)
        if not planned_transaction:
            return False

        self.db.delete(planned_transaction)
        self.db.commit()
        logger.info(f"Hard deleted planned transaction ID {planned_transaction_id}")
        return True
