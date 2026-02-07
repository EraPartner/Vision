"""Transaction Repository module.

This module provides data access layer for transaction entities using the
repository pattern to abstract SQLAlchemy operations.

The repository layer is responsible for:
- Raw database operations for transactions
- Query building and filtering
- Pagination support
- Transaction lifecycle management (create, read, update, delete)

Classes:
    TransactionRepository: Repository class for transaction data access.
"""
from datetime import date, datetime
from typing import Optional, List

from sqlalchemy.orm import Session, joinedload

from config.logging_config import setup_logging
from database.models import Transaction, Recipient

logger = setup_logging(__name__)


class TransactionRepository:
    """Repository for transaction data access operations.

    Provides low-level database operations for transaction entities using SQLAlchemy.
    This repository layer abstracts database implementation details and provides
    clean interfaces for transaction data access.

    The repository handles:
    - CRUD operations for transactions
    - Complex query building with multiple filters
    - Pagination support
    - Transaction relationships (recipient, category, batch)
    - Soft and hard deletion

    Attributes:
        db (Session): SQLAlchemy database session.

    Example:
        repo = TransactionRepository(db_session)
        transactions = repo.get_transactions(bank_account="Revolut", limit=50)
    """

    def __init__(self, db: Session):
        """Initialize the transaction repository with a database session.

        Args:
            db (Session): SQLAlchemy database session for executing queries.
        """
        self.db = db

    def get_transactions(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime | date] = None,
            end_date: Optional[datetime | date] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            limit: int = 100,
            offset: int = 0
    ) -> List[Transaction]:
        """Get transactions with optional filtering and pagination.

        Retrieves transactions from the database with support for multiple filters
        and pagination. Results are ordered by transaction date in descending order
        (most recent first).

        Args:
            bank_account (Optional[str]): Filter by partial bank account name match (case-insensitive).
            start_date (Optional[datetime | date]): Filter transactions on or after this date.
            end_date (Optional[datetime | date]): Filter transactions on or before this date.
            category_id (Optional[int]): Filter by exact category ID.
            recipient_id (Optional[int]): Filter by exact recipient ID.
            recipient_name (Optional[str]): Filter by partial recipient name match (case-insensitive).
            limit (int): Maximum number of transactions to return. Defaults to 100.
            offset (int): Number of transactions to skip before returning results. Defaults to 0.

        Returns:
            List[Transaction]: List of transactions matching the filters, ordered by date descending.

        Example:
            repo = TransactionRepository(db)

            # Get recent transactions for a specific bank account
            transactions = repo.get_transactions(
                bank_account="Revolut",
                start_date=date(2024, 1, 1),
                limit=50
            )

            # Get transactions for a specific recipient
            transactions = repo.get_transactions(
                recipient_id=5,
                limit=100,
                offset=0
            )

            # Get transactions with date range and category
            transactions = repo.get_transactions(
                start_date=date(2024, 1, 1),
                end_date=date(2024, 12, 31),
                category_id=3
            )

        Note:
            - Results are always ordered by date descending (newest first)
            - All filters are optional and can be combined
            - Bank account and recipient name filters are case-insensitive
            - Joins with Recipient table only when filtering by recipient name
        """
        query = self.db.query(Transaction).options(
            joinedload(Transaction.recipient),
            joinedload(Transaction.category)
        )

        if bank_account:
            query = query.filter(Transaction.bank_account.ilike(f"%{bank_account}%"))
        if start_date:
            query = query.filter(Transaction.date >= start_date)
        if end_date:
            query = query.filter(Transaction.date <= end_date)
        if category_id:
            query = query.filter(Transaction.category_id == category_id)
        if recipient_id:
            query = query.filter(Transaction.recipient_id == recipient_id)
        if recipient_name:
            query = query.join(Recipient).filter(Recipient.name.ilike(f"%{recipient_name}%"))

        return query.order_by(Transaction.date.desc()).offset(offset).limit(limit).all()

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
        """Get uncategorised transactions where recipient has no default category.

        Retrieves transactions that are linked to recipients without a default category
        assigned. This is useful for identifying transactions that need manual categorisation
        or for data quality checks.

        Args:
            bank_account (Optional[str]): Filter by partial bank account name match (case-insensitive).
            start_date (Optional[datetime]): Filter transactions on or after this date.
            end_date (Optional[datetime]): Filter transactions on or before this date.
            recipient_id (Optional[int]): Filter by exact recipient ID.
            recipient_name (Optional[str]): Filter by partial recipient name match (case-insensitive).
            limit (int): Maximum number of transactions to return. Defaults to 100.
            offset (int): Number of transactions to skip before returning results. Defaults to 0.

        Returns:
            List[Transaction]: List of uncategorised transactions matching the filters,
                ordered by date descending.

        Example:
            repo = TransactionRepository(db)

            # Get all uncategorised transactions
            uncategorised = repo.get_uncategorised_transactions(limit=100)

            # Get uncategorised transactions for a specific bank account
            uncategorised = repo.get_uncategorised_transactions(
                bank_account="Revolut",
                start_date=datetime(2024, 1, 1)
            )

            # Get uncategorised transactions for a specific recipient
            uncategorised = repo.get_uncategorised_transactions(
                recipient_name="AMAZON"
            )

        Note:
            - Only returns transactions where recipient.default_category_id is None
            - Only returns transactions where transaction.category_id is None
            - Results are ordered by date descending
            - Always joins with Recipient table
        """
        query = self.db.query(Transaction).options(
            joinedload(Transaction.recipient),
            joinedload(Transaction.category)
        )
        query = query.join(Recipient).filter(Recipient.default_category_id == None).filter(
            Transaction.category_id == None)

        if bank_account:
            query = query.filter(Transaction.bank_account.ilike(f"%{bank_account}%"))
        if start_date:
            query = query.filter(Transaction.date >= start_date)
        if end_date:
            query = query.filter(Transaction.date <= end_date)
        if recipient_id:
            query = query.filter(Transaction.recipient_id == recipient_id)
        if recipient_name:
            query = query.filter(Recipient.name.ilike(f"%{recipient_name}%"))

        return query.order_by(Transaction.date.desc()).offset(offset).limit(limit).all()

    def create(self, txn: Transaction) -> Transaction:
        """Create a new transaction in the database.

        Persists a new transaction entity to the database, committing the transaction
        and refreshing the entity to load any database-generated values.

        Args:
            txn (Transaction): Transaction entity to create.

        Returns:
            Transaction: The created transaction with database-generated fields populated
                (id, created_at, etc.).

        Example:
            repo = TransactionRepository(db)
            new_txn = Transaction(
                date=date.today(),
                amount=25.50,
                bank_account="Revolut",
                recipient_id=5
            )
            created = repo.create(new_txn)
            print(f"Created transaction {created.id}")

        Note:
            - Automatically commits the transaction to the database
            - Refreshes the entity to load server-generated fields
            - Raises database exceptions if constraints are violated
        """
        self.db.add(txn)
        self.db.commit()
        self.db.refresh(txn)
        return txn

    def update(self, txn: Transaction) -> Transaction:
        """Update an existing transaction in the database.

        Commits pending changes to an existing transaction entity. The entity
        must already be tracked by the session.

        Args:
            txn (Transaction): Transaction entity with modified fields.

        Returns:
            Transaction: The updated transaction with refreshed database values.

        Example:
            repo = TransactionRepository(db)
            txn = repo.get_by_id(123)
            txn.amount = 30.00
            txn.category_id = 5
            updated = repo.update(txn)

        Note:
            - Entity must already exist in the database
            - Automatically commits the changes
            - Refreshes the entity after commit
            - updated_at timestamp is automatically set by the database
        """
        self.db.commit()
        self.db.refresh(txn)
        return txn

    def hard_delete(self, txn: Transaction) -> None:
        """Permanently delete a transaction from the database.

        Removes a transaction entity completely from the database. This operation
        is irreversible and should be used with caution.

        Args:
            txn (Transaction): Transaction entity to delete permanently.

        Example:
            repo = TransactionRepository(db)
            txn = repo.get_by_id(123)
            repo.hard_delete(txn)

        Warning:
            This is a permanent deletion. Consider using soft_delete() instead
            for better data integrity and audit trail.

        Note:
            - Permanently removes the record from the database
            - Cannot be undone
            - May fail if foreign key constraints prevent deletion
        """
        self.db.delete(txn)
        self.db.commit()

    def soft_delete(self, txn: Transaction) -> None:
        """Soft delete a transaction by removing it from database.

        Note: Transaction model doesn't have is_active field, so this performs
        a hard delete. Method name kept for interface consistency with other repositories.

        Args:
            txn (Transaction): Transaction entity to delete.

        Example:
            repo = TransactionRepository(db)
            txn = repo.get_by_id(123)
            repo.soft_delete(txn)

        Warning:
            This is a permanent deletion for Transaction entities.
        """
        self.db.delete(txn)
        self.db.commit()

    def get_by_id(self, transaction_id: int) -> Optional[Transaction]:
        """Get a single transaction by its ID.

        Retrieves a transaction entity identified by its unique ID.

        Args:
            transaction_id (int): The unique identifier of the transaction.

        Returns:
            Optional[Transaction]: The Transaction object if found, None otherwise.

        Example:
            repo = TransactionRepository(db)
            txn = repo.get_by_id(123)
            if txn:
                print(f"Amount: {txn.amount}, Date: {txn.date}")
            else:
                print("Transaction not found")

        Note:
            - Returns both active and inactive transactions
            - Returns None if transaction doesn't exist
            - Does not raise exceptions on missing transactions
        """
        return self.db.query(Transaction).options(
            joinedload(Transaction.recipient),
            joinedload(Transaction.category)
        ).filter(Transaction.id == transaction_id).first()

    def get_total_count(self, active: bool = True) -> int:
        """Get total count of transactions.

        Args:
            active (bool): Ignored for transactions (kept for interface consistency).

        Returns:
            int: Total number of transactions.
        """
        query = self.db.query(Transaction)
        return query.count()

    def get_filtered_count(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime | date] = None,
            end_date: Optional[datetime | date] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            active: bool = True
    ) -> int:
        """Get count of transactions matching filters.

        Args:
            bank_account (Optional[str]): Filter by partial bank account name match.
            start_date (Optional[datetime | date]): Filter transactions on or after this date.
            end_date (Optional[datetime | date]): Filter transactions on or before this date.
            category_id (Optional[int]): Filter by exact category ID.
            recipient_id (Optional[int]): Filter by exact recipient ID.
            recipient_name (Optional[str]): Filter by partial recipient name match.
            active (bool): Ignored for transactions (kept for interface consistency).

        Returns:
            int: Count of transactions matching the filters.
        """
        query = self.db.query(Transaction)

        if bank_account:
            query = query.filter(Transaction.bank_account.ilike(f"%{bank_account}%"))
        if start_date:
            query = query.filter(Transaction.date >= start_date)
        if end_date:
            query = query.filter(Transaction.date <= end_date)
        if category_id:
            query = query.filter(Transaction.category_id == category_id)
        if recipient_id:
            query = query.filter(Transaction.recipient_id == recipient_id)
        if recipient_name:
            query = query.join(Recipient).filter(Recipient.name.ilike(f"%{recipient_name}%"))

        return query.count()
