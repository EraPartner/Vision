"""Transaction Service module.

This module provides high-level business logic for transaction management operations.
It complements the TransactionQueryService by handling transaction lifecycle operations
such as creation, updates and deletions.

The service layer is responsible for:
- Transaction creation
- Transaction deletion (soft and hard)
- Transaction lifecycle management
- Business rule enforcement
- Logging and monitoring transaction operations

Classes:
    TransactionService: Main service class for transaction management.
"""
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Transaction
from repositories.transaction_repository import TransactionRepository

logger = setup_logging(__name__)


class TransactionService:
    """Service for managing transaction lifecycle operations.

    Provides high-level business logic for transaction management operations,
    coordinating with the repository layer and enforcing business rules. This
    service layer separates business logic from data access for better
    testability and maintainability.

    The service handles:
    - Transaction creation
    - Transaction deletion (soft and hard)
    - Transaction lifecycle management
    - Business rule validation
    - Operation logging and audit trail

    Attributes:
        db (Session): SQLAlchemy database session.
        txn_repo (TransactionRepository): Repository for transaction data access.

    Example:
        service = TransactionService(db_session)

        # Create a new transaction
        transaction = service.create(
            transaction_date=date.today(),
            bank_account="Revolut",
            recipient_id=5,
            amount=25.50
        )

        # Delete a transaction
        success = service.delete_transaction(transaction_id=123, soft=True)
        if success:
            print("Transaction deleted successfully")
    """

    def __init__(self, db: Session):
        """Initialise the transaction service with a database session.

        Args:
            db (Session): SQLAlchemy database session for repository operations.
        """
        self.db = db
        self.txn_repo = TransactionRepository(db)

    def create(
            self,
            transaction_date: date,
            bank_account: str,
            recipient_id: int,
            amount: float,
            memo: Optional[str] = None,
            currency: Optional[str] = None,
            balance: Optional[float] = None,
            category_id: Optional[int] = None,
            comment: Optional[str] = None,
            original_raw_data: Optional[str] = None,
            bank_reference: Optional[str] = None,
            skip_duplicate_check: bool = False
    ) -> Transaction:
        """Create a new transaction with comprehensive validation and duplicate checking.

        Creates a new financial transaction with all required and optional fields.
        Validates business rules, checks for duplicates using bank_reference and
        original_raw_data, and ensures data integrity before persisting.

        Transactions are automatically classified:
        - Transactions created via import service with raw data are imports
        - Transactions created directly via API are custom entries

        Args:
            transaction_date (date): Transaction date (required).
            bank_account (str): Bank account name (required).
            recipient_id (int): Recipient ID - must reference existing recipient (required).
            amount (float): Transaction amount (required).
            memo (Optional[str]): Transaction memo/note.
            currency (Optional[str]): Currency code (EUR, USD, etc.), max 3 characters.
            balance (Optional[float]): Account balance after transaction.
            category_id (Optional[int]): Category ID - must reference existing category if provided.
            comment (Optional[str]): Additional comment for bank-specific data.
            original_raw_data (Optional[str]): Original CSV row for audit trail and duplicate detection.
            bank_reference (Optional[str]): Bank's transaction ID for duplicate detection.
            skip_duplicate_check (bool): Skip duplicate checking (default: False). Use with caution.

        Returns:
            Transaction: The newly created transaction with database-generated fields.

        Raises:
            ValueError: If validation fails (invalid recipient_id, category_id, duplicate found, etc.).

        Example:
            service = TransactionService(db)

            # Create a custom user transaction
            transaction = service.create(
                transaction_date=date(2026, 2, 16),
                bank_account="Revolut",
                recipient_id=5,
                amount=25.50
            )

            # Create from bank import with duplicate detection
            transaction = service.create(
                transaction_date=date(2026, 2, 16),
                bank_account="Revolut",
                recipient_id=10,
                amount=150.75,
                bank_reference="TXN-2026-001234",
                original_raw_data="2026-02-16,Coffee Shop,4.50,EUR,..."
            )  # Raises ValueError if duplicate found

        Note:
            - Automatically sets created_at timestamp
            - Duplicate checking uses bank_reference first, then original_raw_data
            - Recipient must exist in database
            - Category must exist if category_id is provided
            - All creations are logged for audit purposes
            - Duplicates are logged and rejected by default
        """
        # Check for duplicates before creating
        if not skip_duplicate_check and (bank_reference or original_raw_data):
            duplicate = self.txn_repo.find_duplicate(
                bank_reference=bank_reference,
                original_raw_data=original_raw_data,
                bank_account=bank_account
            )

            if duplicate:
                logger.warning(
                    "Duplicate transaction detected",
                    extra={
                        "operation": "create_transaction",
                        "resource_type": "transaction",
                        "duplicate_id": duplicate.id,
                        "bank_reference": bank_reference,
                        "has_raw_data": original_raw_data is not None,
                        "bank_account": bank_account
                    }
                )
                raise ValueError(
                    f"Duplicate transaction found (ID: {duplicate.id}). "
                    f"A transaction with the same "
                    f"{'bank reference' if bank_reference else 'raw data'} "
                    f"already exists for {bank_account}."
                )

        # Validate recipient exists
        from repositories.recipient_repository import RecipientRepository
        recipient_repo = RecipientRepository(self.db)
        recipient = recipient_repo.get_by_id(recipient_id)
        if not recipient:
            logger.error(
                "Invalid recipient_id for transaction creation",
                extra={
                    "operation": "create_transaction",
                    "resource_type": "transaction",
                    "recipient_id": recipient_id
                }
            )
            raise ValueError(f"Recipient with ID {recipient_id} does not exist")

        # Validate category if provided
        if category_id is not None:
            from repositories.category_repository import CategoryRepository
            category_repo = CategoryRepository(self.db)
            category = category_repo.get_by_id(category_id)
            if not category:
                logger.error(
                    "Invalid category_id for transaction creation",
                    extra={
                        "operation": "create_transaction",
                        "resource_type": "transaction",
                        "category_id": category_id
                    }
                )
                raise ValueError(f"Category with ID {category_id} does not exist")

        # Create transaction entity
        new_transaction = Transaction(
            date=transaction_date,
            bank_account=bank_account,
            recipient_id=recipient_id,
            amount=amount,
            memo=memo,
            currency=currency,
            balance=balance,
            category_id=category_id,
            comment=comment
        )

        # Persist to database
        created_transaction = self.txn_repo.create(new_transaction)

        logger.info(
            "Transaction created successfully",
            extra={
                "operation": "create_transaction",
                "resource_type": "transaction",
                "resource_id": created_transaction.id,
                "bank_account": bank_account,
                "recipient_id": recipient_id,
                "amount": amount,
                "category_id": category_id,
                "has_bank_reference": bank_reference is not None,
                "has_raw_data": original_raw_data is not None
            }
        )

        return created_transaction

    def update(
            self,
            transaction_id: int,
            transaction_date: Optional[date] = None,
            bank_account: Optional[str] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            amount: Optional[float] = None,
            memo: Optional[str] = None,
            currency: Optional[str] = None,
            balance: Optional[float] = None,
            category_id: Optional[int] = None,
            category_name: Optional[str] = None,
            comment: Optional[str] = None,
            is_active: Optional[bool] = None
    ) -> Transaction:
        """Update an existing transaction with name-to-ID translation support.

        Updates one or more fields of an existing transaction. Supports updating
        recipients and categories by either ID or name. When names are provided,
        they are automatically resolved to IDs before updating.

        Args:
            transaction_id (int): The ID of the transaction to update (required).
            transaction_date (Optional[date]): New transaction date.
            bank_account (Optional[str]): New bank account name.
            recipient_id (Optional[int]): New recipient ID.
            recipient_name (Optional[str]): New recipient name (resolved to ID).
                Normalized to uppercase automatically.
            amount (Optional[float]): New transaction amount.
            memo (Optional[str]): New transaction memo/note.
            currency (Optional[str]): New currency code (EUR, USD, etc.).
            balance (Optional[float]): New account balance after transaction.
            category_id (Optional[int]): New category ID.
            category_name (Optional[str]): New category name in 'General:Detail' format
                (resolved to ID). Normalized to uppercase automatically.
            comment (Optional[str]): New additional comment.
            is_active (Optional[bool]): New active status (True/False).

        Returns:
            Transaction: The updated transaction with all changes applied.

        Raises:
            ValueError: If transaction not found, recipient name not found,
                category name not found, or name format is invalid.

        Example:
            service = TransactionService(db)

            # Update by ID
            transaction = service.update(
                transaction_id=123,
                amount=35.00,
                category_id=5
            )

            # Update by name
            transaction = service.update(
                transaction_id=123,
                recipient_name="Coffee Shop",
                category_name="FOOD:BEVERAGES"
            )

            # Mix of ID and name (ID takes precedence if both provided)
            transaction = service.update(
                transaction_id=123,
                recipient_id=10,  # This will be used
                recipient_name="Coffee Shop",  # This will be ignored
                amount=25.50
            )

        Note:
            - If both ID and name are provided for recipient/category, ID takes precedence
            - Recipient and category names are normalized to uppercase
            - Category name must be in 'General:Detail' format (e.g., 'FOOD:BEVERAGES')
            - All updates are logged for audit purposes
            - Only provided fields are updated; others remain unchanged
        """
        # Retrieve existing transaction
        transaction = self.txn_repo.get_by_id(transaction_id)
        if not transaction:
            logger.error(
                "Transaction not found for update",
                extra={
                    "operation": "update_transaction",
                    "resource_type": "transaction",
                    "resource_id": transaction_id
                }
            )
            raise ValueError(f"Transaction with ID {transaction_id} does not exist")

        # Resolve recipient_name to recipient_id if provided and recipient_id is not
        if recipient_name is not None and recipient_id is None:
            from repositories.recipient_repository import RecipientRepository
            from services.text_normalization_service import TextNormalizationService

            # Normalize recipient name to uppercase
            normalized_recipient_name = TextNormalizationService.normalize_recipient_name(recipient_name)

            recipient_repo = RecipientRepository(self.db)
            recipient = recipient_repo.get_by_name(normalized_recipient_name)

            if not recipient:
                logger.error(
                    "Recipient name not found for transaction update",
                    extra={
                        "operation": "update_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "recipient_name": normalized_recipient_name
                    }
                )
                raise ValueError(f"Recipient with name '{normalized_recipient_name}' does not exist")

            recipient_id = recipient.id
            logger.debug(
                "Resolved recipient name to ID",
                extra={
                    "operation": "update_transaction",
                    "recipient_name": normalized_recipient_name,
                    "recipient_id": recipient_id
                }
            )

        # Resolve category_name to category_id if provided and category_id is not
        if category_name is not None and category_id is None:
            from repositories.category_repository import CategoryRepository
            from services.text_normalization_service import TextNormalizationService

            # Normalize category name to uppercase
            normalized_category_name = TextNormalizationService.normalize_category_name(category_name)

            # Parse category name (expected format: "General:Detail")
            if ":" not in normalized_category_name:
                logger.error(
                    "Invalid category name format for transaction update",
                    extra={
                        "operation": "update_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "category_name": normalized_category_name
                    }
                )
                raise ValueError(
                    f"Invalid category name format '{normalized_category_name}'. "
                    f"Expected format: 'General:Detail' (e.g., 'FOOD:BEVERAGES')"
                )

            parts = normalized_category_name.split(":", 1)
            general = parts[0].strip()
            detail = parts[1].strip()

            category_repo = CategoryRepository(self.db)
            category = category_repo.get_by_general_detail(general, detail)

            if not category:
                logger.error(
                    "Category name not found for transaction update",
                    extra={
                        "operation": "update_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "category_name": normalized_category_name,
                        "general": general,
                        "detail": detail
                    }
                )
                raise ValueError(
                    f"Category '{normalized_category_name}' does not exist. "
                    f"Please create it first or use an existing category."
                )

            category_id = category.id
            logger.debug(
                "Resolved category name to ID",
                extra={
                    "operation": "update_transaction",
                    "category_name": normalized_category_name,
                    "category_id": category_id
                }
            )

        # Validate recipient_id if provided
        if recipient_id is not None:
            from repositories.recipient_repository import RecipientRepository
            recipient_repo = RecipientRepository(self.db)
            recipient = recipient_repo.get_by_id(recipient_id)
            if not recipient:
                logger.error(
                    "Invalid recipient_id for transaction update",
                    extra={
                        "operation": "update_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "recipient_id": recipient_id
                    }
                )
                raise ValueError(f"Recipient with ID {recipient_id} does not exist")

        # Validate category_id if provided
        if category_id is not None:
            from repositories.category_repository import CategoryRepository
            category_repo = CategoryRepository(self.db)
            category = category_repo.get_by_id(category_id)
            if not category:
                logger.error(
                    "Invalid category_id for transaction update",
                    extra={
                        "operation": "update_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "category_id": category_id
                    }
                )
                raise ValueError(f"Category with ID {category_id} does not exist")

        # Track updated fields for logging
        updated_fields = []

        # Apply updates to transaction
        if transaction_date is not None:
            transaction.date = transaction_date
            updated_fields.append("date")
        if bank_account is not None:
            transaction.bank_account = bank_account
            updated_fields.append("bank_account")
        if recipient_id is not None:
            transaction.recipient_id = recipient_id
            updated_fields.append("recipient_id")
        if amount is not None:
            transaction.amount = amount
            updated_fields.append("amount")
        if memo is not None:
            transaction.memo = memo
            updated_fields.append("memo")
        if currency is not None:
            transaction.currency = currency
            updated_fields.append("currency")
        if balance is not None:
            transaction.balance = balance
            updated_fields.append("balance")
        if category_id is not None:
            transaction.category_id = category_id
            updated_fields.append("category_id")
        if comment is not None:
            transaction.comment = comment
            updated_fields.append("comment")
        if is_active is not None:
            transaction.is_active = is_active
            updated_fields.append("is_active")

        # Persist changes
        updated_transaction = self.txn_repo.update(transaction)

        logger.info(
            "Transaction updated successfully",
            extra={
                "operation": "update_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "updated_fields": updated_fields
            }
        )

        return updated_transaction

    def soft_delete(self, transaction_id: int) -> bool:
        """Perform a soft delete on a transaction.

        Marks the transaction as inactive (is_active = False) instead of removing
        it from the database. This preserves the transaction record for audit trail
        and reporting purposes while hiding it from normal queries.

        Args:
            transaction_id (int): The ID of the transaction to soft delete.

        Returns:
            bool: True if transaction was found and soft deleted, False if not found.

        Example:
            service = TransactionService(db)

            # Soft delete a transaction (sets is_active = False)
            success = service.soft_delete(123)
            if success:
                print("Transaction marked as inactive")

            # Returns False if transaction doesn't exist
            success = service.soft_delete(999)  # False

        Note:
            - Transaction remains in database but is_active = False
            - Can be reactivated by updating is_active = True
            - Preserves audit trail and financial history
            - All deletions are logged for audit purposes
            - Preferred over hard_delete for financial data
        """
        transaction = self.txn_repo.get_by_id(transaction_id)
        if not transaction:
            logger.warning(
                "Transaction not found for soft delete",
                extra={
                    "operation": "soft_delete_transaction",
                    "resource_type": "transaction",
                    "resource_id": transaction_id
                }
            )
            return False

        self.txn_repo.soft_delete(transaction)
        logger.info(
            "Transaction soft deleted successfully",
            extra={
                "operation": "soft_delete_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id
            }
        )
        return True

    def hard_delete(self, transaction_id: int) -> bool:
        """Permanently delete a transaction from the database.

        Removes the transaction record entirely from the database. This operation
        is irreversible and should be used with extreme caution in financial
        applications. Consider archiving transactions instead of deletion for
        audit trail purposes.

        Args:
            transaction_id (int): The ID of the transaction to permanently delete.

        Returns:
            bool: True if transaction was found and deleted, False if not found.

        Example:
            service = TransactionService(db)

            # Permanently delete a transaction
            success = service.hard_delete(123)
            if success:
                print("Transaction permanently deleted")

            # Transaction no longer exists
            from services.transaction_query_service import TransactionQueryService
            query_service = TransactionQueryService(db)
            transaction = query_service.get_transaction_by_id(123)  # Returns None

        Warning:
            - This is a hard delete - data is permanently removed
            - Cannot be undone - use with extreme caution
            - May violate financial audit requirements
            - Consider archiving instead of deletion
            - All deletions are logged for audit purposes

        Note:
            - Preferred approach is to archive transactions for financial data
            - Hard delete should only be used for data cleanup or testing
            - Ensure compliance with financial regulations before using
        """
        transaction = self.txn_repo.get_by_id(transaction_id)
        if not transaction:
            logger.warning(
                "Transaction not found for hard delete",
                extra={
                    "operation": "hard_delete_transaction",
                    "resource_type": "transaction",
                    "resource_id": transaction_id
                }
            )
            return False

        self.txn_repo.hard_delete(transaction)
        logger.info(
            "Transaction hard deleted successfully",
            extra={
                "operation": "hard_delete_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id
            }
        )
        return True

    def delete(self, transaction_id: int, soft: bool = True) -> bool:
        """Delete a transaction with configurable deletion type.

        Convenience method that delegates to either soft_delete or hard_delete
        based on the soft parameter. For transactions, both methods perform
        a hard delete as the Transaction model lacks an is_active field.

        Args:
            transaction_id (int): The ID of the transaction to delete.
            soft (bool): Deletion type flag (defaults to True). Note: For
                transactions, both soft and hard perform permanent deletion.

        Returns:
            bool: True if transaction was found and deleted, False if not found.

        Example:
            service = TransactionService(db)

            # Soft delete (default) - performs hard delete for transactions
            success = service.delete(123)

            # Explicit hard delete
            success = service.delete(123, soft=False)

        Note:
            - Both soft and hard delete perform permanent deletion for transactions
            - Maintained for interface consistency with other services
            - Consider using soft_delete() or hard_delete() explicitly for clarity
        """
        if soft:
            return self.soft_delete(transaction_id)
        else:
            return self.hard_delete(transaction_id)
