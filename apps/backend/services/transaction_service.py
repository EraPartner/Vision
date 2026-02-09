"""Transaction Service module.

This module provides high-level business logic for transaction management operations.
It complements the TransactionQueryService by handling transaction lifecycle operations
such as updates and deletions.

The service layer is responsible for:
- Transaction deletion (soft and hard)
- Transaction lifecycle management
- Business rule enforcement
- Logging and monitoring transaction operations

Classes:
    TransactionService: Main service class for transaction management.
"""
from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from repositories.transaction_repository import TransactionRepository

logger = setup_logging(__name__)


class TransactionService:
    """Service for managing transaction lifecycle operations.

    Provides high-level business logic for transaction management operations,
    coordinating with the repository layer and enforcing business rules. This
    service layer separates business logic from data access for better
    testability and maintainability.

    The service handles:
    - Transaction deletion (soft and hard)
    - Transaction lifecycle management
    - Business rule validation
    - Operation logging and audit trail

    Attributes:
        db (Session): SQLAlchemy database session.
        txn_repo (TransactionRepository): Repository for transaction data access.

    Example:
        service = TransactionService(db_session)
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

    def soft_delete(self, transaction_id: int) -> bool:
        """Perform a soft delete on a transaction.

        For transactions, soft delete is equivalent to hard delete as the
        Transaction model does not have an is_active field. This method
        exists for interface consistency with other services and future
        extensibility.

        Args:
            transaction_id (int): The ID of the transaction to delete.

        Returns:
            bool: True if transaction was found and deleted, False if not found.

        Example:
            service = TransactionService(db)

            # Soft delete a transaction (performs hard delete for transactions)
            success = service.soft_delete(123)
            if success:
                print("Transaction deleted")

            # Returns False if transaction doesn't exist
            success = service.soft_delete(999)  # False

        Note:
            - Transaction is permanently removed from database
            - Use with caution in production environments
            - All deletions are logged for audit purposes
            - Consider archiving transactions instead of deletion
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
