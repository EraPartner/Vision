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
            offset: int = 0,
            active: bool = True
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
            active (bool): Filter by active status. True for active only (default), False for all.

        Returns:
            List[Transaction]: List of transactions matching the filters, ordered by date descending.

        Example:
            repo = TransactionRepository(db)

            # Get recent active transactions for a specific bank account
            transactions = repo.get_transactions(
                bank_account="Revolut",
                start_date=date(2024, 1, 1),
                limit=50
            )

            # Get all transactions including inactive ones
            transactions = repo.get_transactions(active=False)

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
            - By default, only active transactions are returned
        """
        query = self.db.query(Transaction).options(
            joinedload(Transaction.recipient),
            joinedload(Transaction.category)
        )

        # Filter by active status
        if active:
            query = query.filter(Transaction.is_active == True)

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

    def find_duplicate_by_bank_reference(
            self,
            bank_reference: str,
            bank_account: Optional[str] = None
    ) -> Optional[Transaction]:
        """Find a duplicate transaction by bank reference.

        Searches for an existing transaction with the same bank reference.
        Optionally filters by bank account for more precise matching when
        the same reference might exist across different accounts.

        Args:
            bank_reference (str): The bank's transaction reference/ID to search for.
            bank_account (Optional[str]): Optional bank account filter for more precise matching.

        Returns:
            Optional[Transaction]: The matching transaction if found, None otherwise.

        Example:
            repo = TransactionRepository(db)

            # Check for duplicate by bank reference only
            duplicate = repo.find_duplicate_by_bank_reference("TXN-2026-001234")

            # Check for duplicate with bank account filter
            duplicate = repo.find_duplicate_by_bank_reference(
                bank_reference="TXN-2026-001234",
                bank_account="Revolut"
            )

            if duplicate:
                print(f"Duplicate found: Transaction ID {duplicate.id}")

        Note:
            - Returns the first match found
            - Case-sensitive search for bank_reference
            - Useful for preventing duplicate imports
            - All lookups are logged for audit purposes
        """
        query = self.db.query(Transaction).filter(
            Transaction.bank_reference == bank_reference
        )

        if bank_account:
            query = query.filter(Transaction.bank_account == bank_account)

        result = query.first()

        logger.debug(
            "Duplicate check by bank reference",
            extra={
                "operation": "find_duplicate_by_bank_reference",
                "resource_type": "transaction",
                "bank_reference": bank_reference,
                "bank_account": bank_account,
                "found": result is not None
            }
        )

        return result

    def find_duplicate_by_raw_data(
            self,
            original_raw_data: str,
            bank_account: Optional[str] = None
    ) -> Optional[Transaction]:
        """Find a duplicate transaction by original raw data.

        Searches for an existing transaction with the same original raw data
        (typically the raw CSV row). Optionally filters by bank account for
        more precise matching.

        Args:
            original_raw_data (str): The original raw data string to search for.
            bank_account (Optional[str]): Optional bank account filter for more precise matching.

        Returns:
            Optional[Transaction]: The matching transaction if found, None otherwise.

        Example:
            repo = TransactionRepository(db)

            # Check for duplicate by raw data
            raw_csv = "2026-02-16,Coffee Shop,4.50,EUR,..."
            duplicate = repo.find_duplicate_by_raw_data(raw_csv)

            # Check with bank account filter
            duplicate = repo.find_duplicate_by_raw_data(
                original_raw_data=raw_csv,
                bank_account="Revolut"
            )

            if duplicate:
                print(f"Duplicate import detected: Transaction ID {duplicate.id}")

        Note:
            - Returns the first match found
            - Exact string match required for original_raw_data
            - Useful for preventing duplicate CSV imports
            - All lookups are logged for audit purposes
        """
        query = self.db.query(Transaction).filter(
            Transaction.original_raw_data == original_raw_data
        )

        if bank_account:
            query = query.filter(Transaction.bank_account == bank_account)

        result = query.first()

        logger.debug(
            "Duplicate check by original raw data",
            extra={
                "operation": "find_duplicate_by_raw_data",
                "resource_type": "transaction",
                "raw_data_length": len(original_raw_data) if original_raw_data else 0,
                "bank_account": bank_account,
                "found": result is not None
            }
        )

        return result

    def find_duplicate(
            self,
            bank_reference: Optional[str] = None,
            original_raw_data: Optional[str] = None,
            bank_account: Optional[str] = None
    ) -> Optional[Transaction]:
        """Find a duplicate transaction using bank reference or original raw data.

        Comprehensive duplicate detection that checks both bank reference and
        original raw data. Checks bank_reference first (if provided), then falls
        back to original_raw_data. Optionally filters by bank account.

        Args:
            bank_reference (Optional[str]): The bank's transaction reference/ID.
            original_raw_data (Optional[str]): The original raw data string.
            bank_account (Optional[str]): Optional bank account filter for more precise matching.

        Returns:
            Optional[Transaction]: The matching transaction if found, None otherwise.

        Example:
            repo = TransactionRepository(db)

            # Check for duplicate with both identifiers
            duplicate = repo.find_duplicate(
                bank_reference="TXN-2026-001234",
                original_raw_data="2026-02-16,Coffee Shop,4.50,...",
                bank_account="Revolut"
            )

            # Check with only bank reference
            duplicate = repo.find_duplicate(bank_reference="TXN-2026-001234")

            # Check with only raw data
            duplicate = repo.find_duplicate(original_raw_data="raw,csv,data,...")

            if duplicate:
                print(f"Duplicate found: Transaction ID {duplicate.id}")
            else:
                print("No duplicate, safe to import")

        Note:
            - Priority order: bank_reference > original_raw_data
            - Returns None if neither identifier is provided
            - Useful for bulk import duplicate prevention
            - All lookups are logged for audit purposes
        """
        # Check bank_reference first (most reliable)
        if bank_reference:
            result = self.find_duplicate_by_bank_reference(bank_reference, bank_account)
            if result:
                logger.debug(
                    "Duplicate found by bank reference",
                    extra={
                        "operation": "find_duplicate",
                        "resource_type": "transaction",
                        "duplicate_id": result.id,
                        "match_type": "bank_reference"
                    }
                )
                return result

        # Fall back to original_raw_data
        if original_raw_data:
            result = self.find_duplicate_by_raw_data(original_raw_data, bank_account)
            if result:
                logger.debug(
                    "Duplicate found by original raw data",
                    extra={
                        "operation": "find_duplicate",
                        "resource_type": "transaction",
                        "duplicate_id": result.id,
                        "match_type": "original_raw_data"
                    }
                )
                return result

        logger.debug(
            "No duplicate found",
            extra={
                "operation": "find_duplicate",
                "resource_type": "transaction",
                "bank_reference": bank_reference is not None,
                "original_raw_data": original_raw_data is not None,
                "bank_account": bank_account
            }
        )

        return None

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
        """Soft delete a transaction by setting is_active to False.

        Marks the transaction as inactive instead of removing it from the database,
        allowing for data recovery and maintaining audit trails. This is the preferred
        deletion method for financial transactions to maintain data integrity.

        Args:
            txn (Transaction): Transaction entity to soft delete.

        Example:
            repo = TransactionRepository(db)
            txn = repo.get_by_id(123)
            repo.soft_delete(txn)
            # Transaction still exists but is_active = False

            # Transaction won't appear in default queries
            transactions = repo.get_transactions()  # Won't include deleted transaction

            # Can still retrieve deleted transactions explicitly
            transactions = repo.get_transactions(active=False)  # Includes deleted

        Note:
            - Sets is_active to False
            - Transaction remains in database for audit purposes
            - Automatically commits the change
            - Preferred over hard_delete for financial data
        """
        txn.is_active = False
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
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: Total number of transactions matching the active filter.

        Example:
            repo = TransactionRepository(db)

            # Count only active transactions
            active_count = repo.get_total_count(active=True)

            # Count all transactions including deleted
            total_count = repo.get_total_count(active=False)
        """
        query = self.db.query(Transaction)
        if active:
            query = query.filter(Transaction.is_active == True)
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
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: Count of transactions matching the filters.

        Example:
            repo = TransactionRepository(db)

            # Count active transactions for a bank account
            count = repo.get_filtered_count(
                bank_account="Revolut",
                active=True
            )

            # Count all transactions including deleted
            total = repo.get_filtered_count(active=False)
        """
        query = self.db.query(Transaction)

        if active:
            query = query.filter(Transaction.is_active == True)
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
