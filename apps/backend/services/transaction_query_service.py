"""Transaction Query Service module.

This module provides high-level business logic for querying and retrieving transactions.
It uses the repository pattern to abstract database operations and separates query
concerns from import and export operations.

The service layer is responsible for:
- Transaction retrieval with complex filtering
- Uncategorised transaction identification
- Query orchestration and business logic
- Logging and monitoring query operations

Classes:
    TransactionQueryService: Main service class for transaction queries.
"""
from datetime import datetime
from typing import Optional, List

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Transaction
from repositories.transaction_repository import TransactionRepository

logger = setup_logging(__name__)


class TransactionQueryService:
    """Service for querying and retrieving transactions.

    Provides high-level business logic for transaction query operations, coordinating
    with the repository layer and enforcing business rules. This service layer separates
    business logic from data access for better testability and maintainability.

    The service handles:
    - Retrieving transactions with complex filtering
    - Identifying uncategorised transactions
    - Transaction lookup by ID
    - Query orchestration and validation

    Attributes:
        db (Session): SQLAlchemy database session.
        txn_repo (TransactionRepository): Repository for transaction data access.

    Example:
        service = TransactionQueryService(db_session)
        transactions = service.get_transactions(
            bank_account="Revolut",
            start_date=date(2024, 1, 1),
            limit=50
        )
    """

    def __init__(self, db_session: Session):
        """Initialize the transaction query service with a database session.

        Args:
            db_session (Session): SQLAlchemy database session for executing queries.
        """
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)

    def get_transactions(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            limit: int = 100,
            offset: int = 0,
    ) -> List[Transaction]:
        """Get transactions with optional filters.

        Retrieves transactions from the database with support for multiple filters
        and pagination. Delegates to the repository layer for data access.

        Args:
            bank_account (Optional[str]): Filter by bank account name (case-insensitive).
            start_date (Optional[datetime]): Filter by start date (inclusive).
            end_date (Optional[datetime]): Filter by end date (inclusive).
            category_id (Optional[int]): Filter by category ID.
            recipient_id (Optional[int]): Filter by recipient ID.
            recipient_name (Optional[str]): Filter by recipient name (case-insensitive).
            limit (int): Maximum results to return. Defaults to 100.
            offset (int): Pagination offset. Defaults to 0.

        Returns:
            List[Transaction]: List of transactions matching the filters,
                ordered by date descending.

        Example:
            service = TransactionQueryService(db)

            # Get recent transactions
            recent = service.get_transactions(limit=10)

            # Get transactions for specific bank account
            revolut_txns = service.get_transactions(
                bank_account="Revolut",
                start_date=datetime(2024, 1, 1)
            )

            # Get categorised transactions
            groceries = service.get_transactions(
                category_id=5,
                limit=50
            )

        Note:
            - All filters are optional and can be combined
            - Results are ordered by date descending (newest first)
            - Supports pagination via limit and offset
        """
        return self.txn_repo.get_transactions(
            bank_account=bank_account,
            start_date=start_date,
            end_date=end_date,
            category_id=category_id,
            recipient_id=recipient_id,
            recipient_name=recipient_name,
            limit=limit,
            offset=offset,
        )

    def get_uncategorised_transactions(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None,
            recipient_id: int = None,
            recipient_name: Optional[str] = None,
            limit: int = 100,
            offset: int = 0,
    ) -> List[Transaction]:
        """Get uncategorised transactions.

        Retrieves transactions where the recipient has no default category assigned.
        This is useful for identifying transactions that need manual categorisation.

        Args:
            bank_account (Optional[str]): Filter by bank account name (case-insensitive).
            start_date (Optional[datetime]): Filter by start date (inclusive).
            end_date (Optional[datetime]): Filter by end date (inclusive).
            recipient_id (Optional[int]): Filter by recipient ID.
            recipient_name (Optional[str]): Filter by recipient name (case-insensitive).
            limit (int): Maximum results to return. Defaults to 100.
            offset (int): Pagination offset. Defaults to 0.

        Returns:
            List[Transaction]: List of uncategorised transactions matching the filters,
                ordered by date descending.

        Example:
            service = TransactionQueryService(db)

            # Get all uncategorised transactions
            uncategorised = service.get_uncategorised_transactions()

            # Get uncategorised for specific bank account
            uncategorised = service.get_uncategorised_transactions(
                bank_account="Revolut",
                limit=50
            )

        Note:
            - Only returns transactions where recipient has no default_category_id
            - Useful for data quality checks and manual categorisation workflows
        """
        return self.txn_repo.get_uncategorised_transactions(
            bank_account=bank_account,
            start_date=start_date,
            end_date=end_date,
            recipient_id=recipient_id,
            recipient_name=recipient_name,
            limit=limit,
            offset=offset,
        )

    def get_transaction_by_id(self, transaction_id: int) -> Optional[Transaction]:
        """Get a single transaction by its ID.

        Retrieves a single transaction entity identified by its unique ID.

        Args:
            transaction_id (int): The unique identifier of the transaction.

        Returns:
            Optional[Transaction]: The Transaction object if found, None otherwise.

        Example:
            service = TransactionQueryService(db)
            txn = service.get_transaction_by_id(123)
            if txn:
                print(f"Found transaction: {txn.amount}")

        Note:
            - Returns both active and inactive transactions
            - Returns None if transaction doesn't exist
        """
        return self.txn_repo.get_by_id(transaction_id)

    def get_by_recipient(self, recipient_id: int) -> List[Transaction]:
        """Get all transactions for a specific recipient.

        Retrieves all transactions associated with a given recipient ID.

        Args:
            recipient_id (int): The unique identifier of the recipient.

        Returns:
            List[Transaction]: List of transactions for the recipient.

        Example:
            service = TransactionQueryService(db)
            recipient_txns = service.get_by_recipient(5)

        Note:
            - Returns transactions for both active and inactive recipients
            - Returns empty list if no transactions found
        """
        return self.txn_repo.get_transactions(recipient_id=recipient_id, limit=10000)

    def get_total_count(self, active: bool = True) -> int:
        """Get total count of transactions.

        Args:
            active (bool): If True, count only active transactions. If False, count all.

        Returns:
            int: Total number of transactions.
        """
        return self.txn_repo.get_total_count(active)

    def get_filtered_count(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            active: bool = True
    ) -> int:
        """Get count of transactions matching filters.

        Args:
            bank_account (Optional[str]): Filter by bank account name.
            start_date (Optional[datetime]): Filter by start date.
            end_date (Optional[datetime]): Filter by end date.
            category_id (Optional[int]): Filter by category ID.
            recipient_id (Optional[int]): Filter by recipient ID.
            recipient_name (Optional[str]): Filter by recipient name.
            active (bool): Filter by active status.

        Returns:
            int: Count of transactions matching the filters.
        """
        return self.txn_repo.get_filtered_count(
            bank_account=bank_account,
            start_date=start_date,
            end_date=end_date,
            category_id=category_id,
            recipient_id=recipient_id,
            recipient_name=recipient_name,
            active=active
        )
