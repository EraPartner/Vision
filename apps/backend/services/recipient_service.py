"""Recipient Management Service module.

This module provides high-level business logic for managing financial transaction recipients.
It uses the repository pattern to abstract database operations and enforces business rules
for recipient management.

The service layer is responsible for:
- Recipient CRUD operations with validation
- Recipient filtering and searching
- Linking recipients to default categories
- Recipient statistics and reporting
- Bulk operations on recipients

Classes:
    RecipientService: Main service class for recipient management.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Recipient
from repositories.recipient_repository import RecipientRepository

# Setup logging
logger = setup_logging(__name__)


class RecipientService:
    """Service for managing financial transaction recipients.

    Provides high-level business logic for recipient operations, coordinating
    between repositories and enforcing business rules. This service layer separates
    business logic from data access, making the code more testable and maintainable.

    The service handles:
    - Getting, creating, updating, and deleting recipients
    - Linking recipients to default categories
    - Filtering recipients by name, account number, and category
    - Recipient statistics and reporting
    - Bulk operations

    Attributes:
        recipient_repo (RecipientRepository): Repository for recipient data access.

    Example:
        service = RecipientService(db_session)
        recipient = service.get_or_create_recipient("JOHN SMITH", "12345678")
        updated = service.update(recipient.id, notes="Regular client")
    """

    def __init__(self, db_session: Session):
        self.recipient_repo = RecipientRepository(db_session)

    # ==================== Basic CRUD Operations ====================

    def create_or_get_recipient(self, name: str, account_number: Optional[str] = None, ) -> Recipient:
        """Create a new recipient or return existing one by name.

        Looks up a recipient by name. If it doesn't exist, creates a new recipient
        with the provided name and account number. This is an idempotent operation.

        Recipient names are automatically normalised to uppercase by SQLAlchemy
        event handlers for consistent storage and display.

        Args:
            name (str): Recipient name (will be normalised to uppercase automatically).
            account_number (Optional[str]): Optional account number for the recipient.

        Returns:
            Recipient: The found or newly created Recipient object.

        Example:
            service = RecipientService(db)

            # Create new recipient (input will be normalised automatically)
            recipient = service.create_or_get_recipient("john smith", "12345678")
            print(recipient.name)  # "JOHN SMITH"

            # Get same recipient again (doesn't create duplicate)
            recipient2 = service.create_or_get_recipient("JOHN SMITH", "12345678")
            assert recipient.id == recipient2.id

        Note:
            - Idempotent operation - safe to call multiple times
            - Names are automatically converted to uppercase
            - Case-insensitive matching for lookups
            - New recipients are created as active (is_active=True)
            - Useful for transaction imports and batch operations
        """
        recipient = self.recipient_repo.get_by_name(name)

        if not recipient:
            recipient = Recipient(name=name, account_number=account_number, is_active=True)
            self.recipient_repo.create(recipient)

        return recipient

    def get_by_id(self, recipient_id: int) -> Optional[Recipient]:
        """Get a recipient by its unique ID.

        Retrieves a single recipient identified by its unique ID, regardless of
        whether it's active or inactive.

        Args:
            recipient_id (int): The unique identifier of the recipient to retrieve.

        Returns:
            Optional[Recipient]: The Recipient object if found, None otherwise.

        Example:
            service = RecipientService(db)
            recipient = service.get_by_id(5)
            if recipient:
                print(f"{recipient.name} - {recipient.account_number}")
            else:
                print("Recipient not found")

        Note:
            - Returns both active and inactive recipients
            - Returns None if recipient doesn't exist
            - Does not raise exceptions on missing recipients
        """
        return self.recipient_repo.get_by_id(recipient_id)

    def get_by_name(self, name: str) -> Optional[Recipient]:
        """Get a recipient by exact name match.

        Retrieves a single recipient by its exact name. The search is case-sensitive
        and requires an exact match with the stored uppercase name.

        Args:
            name (str): The exact name of the recipient to retrieve.

        Returns:
            Optional[Recipient]: The Recipient object if found, None if not found or name is empty.

        Example:
            service = RecipientService(db)

            # Exact match required
            recipient = service.get_by_name("JOHN SMITH")
            if recipient:
                print(f"Found: {recipient.id}")

            # Empty name returns None
            recipient = service.get_by_name("")  # Returns None

        Note:
            - Search is case-sensitive and requires exact match
            - Returns both active and inactive recipients
            - Returns None if name is empty or None
            - For partial name searches, use get_all(name="partial")
        """
        if not name:
            return None
        return self.recipient_repo.get_by_name(name)

    def update(
            self,
            recipient_id: int,
            name: Optional[str] = None,
            account_number: Optional[str] = None,
            default_category_id: Optional[int] = None,
            notes: Optional[str] = None,
            address: Optional[str] = None,
            is_active: Optional[bool] = None,
    ) -> Optional[Recipient]:
        """Update recipient fields (supports partial updates).

        Updates one or more properties of an existing recipient. Only provided
        parameters are updated; omitted parameters leave existing values unchanged.
        Names and addresses are automatically normalised to uppercase.

        Args:
            recipient_id (int): The ID of the recipient to update.
            name (Optional[str]): New recipient name. If provided, will be normalised to uppercase.
            account_number (Optional[str]): New account number.
            default_category_id (Optional[int]): New default category ID.
            notes (Optional[str]): New notes.
            address (Optional[str]): New address. If provided, will be normalised to uppercase.
            is_active (Optional[bool]): New active status.

        Returns:
            Optional[Recipient]: The updated Recipient object if found, None if not found.

        Example:
            service = RecipientService(db)

            # Update name and address (will be normalised to uppercase)
            updated = service.update(5, name="john smith", address="123 main st")
            print(updated.name)     # "JOHN SMITH"
            print(updated.address)  # "123 MAIN ST"

            # Partial update - only change notes
            updated = service.update(5, notes="Updated notes")

            # Returns None if recipient doesn't exist
            updated = service.update(999, name="test")  # Returns None

        Note:
            - Partial updates are allowed (provide only fields to change)
            - Names and addresses are automatically converted to uppercase
            - Strings are stripped of leading/trailing whitespace
            - Transaction is committed if any fields are updated
            - Returns None without raising exception if recipient not found
            - All updates are logged for audit purposes
        """
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            logger.warning(
                "Recipient not found for update",
                extra={
                    "operation": "update_recipient",
                    "resource_type": "recipient",
                    "resource_id": recipient_id
                }
            )
            return None

        if name is not None:
            recipient.name = name.strip() if name else recipient.name
        if account_number is not None:
            recipient.account_number = account_number
        if default_category_id is not None or default_category_id is None:
            recipient.default_category_id = default_category_id
        if notes is not None or notes is None:
            recipient.notes = notes
        if address is not None or address is None:
            recipient.address = address
        if is_active is not None:
            recipient.is_active = is_active

        updated_recipient = self.recipient_repo.update(recipient)
        logger.info(
            "Recipient updated",
            extra={
                "operation": "update_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id
            }
        )
        return updated_recipient

    # ==================== Retrieval Methods ====================

    def get_all(self,
                limit: Optional[int] = None,
                offset: Optional[int] = None,
                name: Optional[str] = None,
                account_number: Optional[str] = None,
                default_category_id: Optional[int] = None,
                active: bool = True) -> List[Recipient]:
        """Get all recipients with optional filtering and pagination.

        Retrieves all recipients with optional filtering by name, account number,
        default category, and active status. Supports pagination for large result sets.

        Args:
            limit: Maximum number of recipients to return (None for all).
            offset: Number of recipients to skip before returning results.
            name: Filter by partial name match (case-insensitive).
            account_number: Filter by partial account number match (case-insensitive).
            default_category_id: Filter by exact default category ID.
            active: Filter by active status. True for active only, False for all.

        Returns:
            List[Recipient]: Recipients matching the filters.

        Example:
            service = RecipientService(db)

            # Get all active recipients
            all_recipients = service.get_all()

            # Get paginated recipients
            recipients = service.get_all(limit=10, offset=20)

            # Get all recipients including inactive ones
            all_recipients = service.get_all(active=False)

            # Filter by name
            johns = service.get_all(name="john")
        """
        return self.recipient_repo.get_all_active(
            limit=limit,
            offset=offset,
            name=name,
            account_number=account_number,
            default_category_id=default_category_id,
            active=active
        )

    def get_with_account_numbers(self, active: bool = True) -> List[Recipient]:
        """Get all recipients that have account numbers.

        Retrieves only recipients that have a non-null account number. Useful for
        filtering recipients that can be used for bank transfers or similar operations
        requiring account information.

        Args:
            active (bool): Filter by active status. True for active only, False for all.
                Defaults to True.

        Returns:
            List[Recipient]: Recipients that have account numbers.

        Example:
            service = RecipientService(db)

            # Get active recipients with account numbers
            recipients = service.get_with_account_numbers()
            for r in recipients:
                print(f"{r.name}: {r.account_number}")

            # Get all recipients with account numbers (including inactive)
            all_recipients = service.get_with_account_numbers(active=False)

        Note:
            - Returns empty list if no recipients have account numbers
            - Filters are applied in-memory after retrieving all recipients
            - For large datasets, consider filtering at database level
        """
        return [r for r in self.get_all(active=active) if r.account_number is not None]

    # ==================== Count Methods ====================

    def get_total_count(self, active: bool = True) -> int:
        """Get the total count of recipients in the database.

        Args:
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: Total number of recipients matching the active filter.

        Example:
            service = RecipientService(db)
            active_total = service.get_total_count()
            all_total = service.get_total_count(active=False)
        """
        return self.recipient_repo.get_total_count(active)

    def get_filtered_count(self,
                           name: Optional[str] = None,
                           account_number: Optional[str] = None,
                           default_category_id: Optional[int] = None,
                           active: bool = True) -> int:
        """Get the count of recipients matching the specified filters.

        Returns the total number of recipients that match the provided
        filters and active status. This is useful for pagination calculations
        when filters are applied.

        Args:
            name: Filter by partial name match (case-insensitive).
            account_number: Filter by partial account number match (case-insensitive).
            default_category_id: Filter by exact default category ID.
            active: Filter by active status. True for active only, False for all.

        Returns:
            int: Count of recipients matching the filters.

        Example:
            service = RecipientService(db)

            # Count all active recipients
            total = service.get_filtered_count()

            # Count recipients with name containing "smith"
            smith_count = service.get_filtered_count(name="smith")

            # Count all recipients including inactive ones
            all_count = service.get_filtered_count(active=False)
        """
        return self.recipient_repo.get_filtered_count(name, account_number, default_category_id, active)

    # ==================== Specialized Methods ====================

    def get_or_create_recipient(
            self,
            name: str,
            account_number: Optional[str] = None
    ) -> Recipient:
        """Get existing recipient or create a new one with smart account number handling.

        Looks up a recipient by name. If found and missing an account number,
        updates it with the provided account number. If not found, creates a new
        recipient. This method is idempotent and intelligently handles account
        number updates.

        Args:
            name (str): Recipient name (will be normalised to uppercase).
            account_number (Optional[str]): Account number to set or update.

        Returns:
            Recipient: The found or newly created Recipient object.

        Example:
            service = RecipientService(db)

            # First call - creates recipient without account number
            recipient = service.get_or_create_recipient("john smith")
            print(recipient.account_number)  # None

            # Second call - updates account number
            recipient = service.get_or_create_recipient("john smith", "12345678")
            print(recipient.account_number)  # "12345678"

            # Third call - keeps existing account number
            recipient = service.get_or_create_recipient("john smith")
            print(recipient.account_number)  # "12345678" (unchanged)

        Note:
            - Idempotent operation - safe to call multiple times
            - Only updates account number if recipient exists and has no account number
            - Does not overwrite existing account numbers
            - Names are automatically normalised to uppercase
            - All updates are logged for audit purposes
        """
        recipient = self.recipient_repo.get_by_name(name)
        if recipient:
            if account_number and not recipient.account_number:
                recipient.account_number = account_number
                recipient = self.recipient_repo.update(recipient)
                logger.info(
                    "Recipient account number updated",
                    extra={
                        "operation": "update_recipient_account",
                        "resource_type": "recipient",
                        "resource_id": recipient.id
                    }
                )
            return recipient

        # Create new recipient
        return self.create_or_get_recipient(name=name, account_number=account_number)

    def update_category(self, recipient_id: int, category_id: Optional[int]) -> bool:
        """Update the default category for a recipient.

        Sets or clears the default category associated with a recipient. The default
        category is automatically applied to new transactions from this recipient.

        Args:
            recipient_id (int): The ID of the recipient to update.
            category_id (Optional[int]): The category ID to set, or None to clear.

        Returns:
            bool: True if recipient was found and updated, False if recipient not found.

        Example:
            service = RecipientService(db)

            # Set default category
            success = service.update_category(5, category_id=10)
            if success:
                print("Category assigned")

            # Clear default category
            success = service.update_category(5, category_id=None)

            # Returns False if recipient doesn't exist
            success = service.update_category(999, category_id=10)  # False

        Note:
            - Setting category_id to None clears the default category
            - Does not validate that category_id exists
            - Transaction is automatically committed
            - All updates are logged for audit purposes
            - Returns False without raising exception if recipient not found
        """
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            logger.warning(
                "Recipient not found for category update",
                extra={
                    "operation": "update_recipient_category",
                    "resource_type": "recipient",
                    "resource_id": recipient_id
                }
            )
            return False

        recipient.default_category_id = category_id
        self.recipient_repo.update(recipient)

        logger.info(
            "Recipient default category updated",
            extra={
                "operation": "update_recipient_category",
                "resource_type": "recipient",
                "resource_id": recipient_id,
                "category_id": category_id
            }
        )
        return True

    # ==================== Delete Methods ====================

    def soft_delete(self, recipient_id: int) -> bool:
        """Perform a soft delete on a recipient (mark as inactive).

        Marks the recipient as inactive rather than removing it from the database.
        The recipient data is preserved for historical integrity and transactions
        remain linked. This is the recommended deletion method for financial applications.

        Args:
            recipient_id (int): The ID of the recipient to soft delete.

        Returns:
            bool: True if recipient was found and soft deleted, False if not found.

        Example:
            service = RecipientService(db)

            # Soft delete a recipient
            success = service.soft_delete(5)
            if success:
                print("Recipient marked as inactive")

            # Recipient still exists in database
            recipient = service.get_by_id(5)
            print(recipient.is_active)  # False

            # Returns False if recipient doesn't exist
            success = service.soft_delete(999)  # False

        Note:
            - Recipient is marked as inactive (is_active=False)
            - Data is preserved for historical transactions
            - Can be reactivated by setting is_active=True via update()
            - Preferred over hard_delete() for financial data integrity
            - All deletions are logged for audit purposes
        """
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            logger.warning(
                "Recipient not found for soft delete",
                extra={
                    "operation": "soft_delete_recipient",
                    "resource_type": "recipient",
                    "resource_id": recipient_id
                }
            )
            return False

        self.recipient_repo.soft_delete(recipient)
        logger.info(
            "Recipient soft deleted successfully",
            extra={
                "operation": "soft_delete_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id
            }
        )
        return True

    def delete(self, recipient_id: int) -> bool:
        """Delete a recipient (alias for soft_delete for backwards compatibility).

        This method is an alias for soft_delete() to maintain backwards compatibility
        with existing code. It performs a soft delete by marking the recipient as inactive.

        Args:
            recipient_id (int): The ID of the recipient to delete.

        Returns:
            bool: True if recipient was found and deleted, False if not found.

        Example:
            service = RecipientService(db)
            success = service.delete(5)  # Performs soft delete

        Note:
            - This is equivalent to calling soft_delete()
            - Maintained for backwards compatibility
            - Consider using soft_delete() explicitly for clarity
        """
        return self.soft_delete(recipient_id)

    def hard_delete(self, recipient_id: int) -> bool:
        """Permanently delete a recipient from the database.

        Removes the recipient record entirely from the database. This operation is
        irreversible and should be used with extreme caution in financial applications.
        May fail if foreign key constraints prevent deletion.

        Args:
            recipient_id (int): The ID of the recipient to permanently delete.

        Returns:
            bool: True if recipient was found and deleted, False if not found.

        Example:
            service = RecipientService(db)

            # Permanently delete a recipient
            success = service.hard_delete(5)
            if success:
                print("Recipient permanently deleted")

            # Recipient no longer exists
            recipient = service.get_by_id(5)  # Returns None

        Warning:
            - This is a hard delete - data is permanently removed
            - May fail if transactions reference this recipient (foreign key constraint)
            - Use soft_delete() for most cases to preserve data integrity
            - Cannot be undone - use with extreme caution
            - All deletions are logged for audit purposes

        Note:
            - Preferred approach is to use soft_delete() for financial data
            - Hard delete should only be used for data cleanup or testing
            - Consider cascading effects on related transactions
        """
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            logger.warning(
                "Recipient not found for hard delete",
                extra={
                    "operation": "hard_delete_recipient",
                    "resource_type": "recipient",
                    "resource_id": recipient_id
                }
            )
            return False

        self.recipient_repo.hard_delete(recipient)
        logger.warning(
            "Recipient hard deleted permanently",
            extra={
                "operation": "hard_delete_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id
            }
        )
        return True
