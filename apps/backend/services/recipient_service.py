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
        self.db_session = db_session

    # ==================== Basic CRUD Operations ====================

    def create_or_get_recipient(
            self,
            name: str,
            account_number: Optional[str] = None,
            address: Optional[str] = None,
            bank_name: Optional[str] = None
    ) -> tuple[Recipient, bool]:
        """Create a new recipient or return existing one using normalized name matching.

        This method implements intelligent recipient matching to prevent duplicates when
        banks format names differently (e.g., "JOHN SMITH" vs "SMITH JOHN"):

        Priority:
        1. **Account Number Match** (if provided): Look up existing bank account, return linked recipient
        2. **Normalized Name Match**: Use canonical name form to find recipient despite word order variations
        3. **Create New**: If no matches found, create new recipient with bank account

        Key Features:
        - Prevents duplicates: "JOHN SMITH" and "SMITH JOHN" map to same recipient
        - Family-safe: "JOHN SMITH" and "JANE SMITH" remain separate (different full names)
        - Multi-account support: Same recipient can have multiple bank accounts
        - Address tracking: Each bank account can have its own address

        Args:
            name (str): Recipient name (will be normalized automatically).
            account_number (Optional[str]): Bank account number. If provided, creates/links bank account.
            address (Optional[str]): Physical address (stored with bank account, not recipient).
            bank_name (Optional[str]): Name of the bank (e.g., "BELFIUS", "KBC").

        Returns:
            tuple[Recipient, bool]: A tuple containing:
                - Recipient object (found or created)
                - Boolean indicating if newly created (True) or already existed (False)

        Example:
            service = RecipientService(db)

            # Create new recipient with bank account
            recipient, created = service.create_or_get_recipient(
                "john smith",
                "BE61734041478017",
                "123 Main St",
                "BELFIUS"
            )
            print(recipient.name)           # "JOHN SMITH"
            print(recipient.normalized_name) # "JOHN SMITH" (sorted tokens)
            print(created)                  # True

            # Same person, name in different order - finds existing!
            recipient2, created2 = service.create_or_get_recipient(
                "SMITH JOHN",  # Different order
                "NL91ABNA0417164300",  # Different account
                bank_name="ING"
            )
            assert recipient.id == recipient2.id  # Same recipient found!
            print(created2)                       # False
            print(len(recipient2.bank_accounts))  # 2 accounts now

            # Different person with same last name - creates separate recipient
            recipient3, created3 = service.create_or_get_recipient("JANE SMITH")
            assert recipient3.id != recipient.id  # Different recipient!

        Note:
            - Normalized name matching prevents duplicates from word order variations
            - Account numbers are stored in separate bank_accounts table
            - Each bank account can have its own address
            - First bank account for a recipient is automatically set as primary
            - Idempotent: safe to call multiple times with same data
        """
        from services.recipient_bank_account_service import RecipientBankAccountService
        from services.text_normalization_service import TextNormalizationService

        bank_account_service = RecipientBankAccountService(self.db_session)
        recipient = None

        # PRIORITY 1: Try account number lookup first (most reliable)
        if account_number:
            bank_account = bank_account_service.get_by_account_number(account_number)
            if bank_account:
                recipient = bank_account.recipient

                # Keep the original recipient name - do not update it
                # This ensures consistency across imports where the same recipient
                # may appear with different name formats
                logger.debug(
                    "Found existing recipient by account number",
                    extra={
                        "operation": "find_recipient",
                        "resource_type": "recipient",
                        "resource_id": recipient.id,
                        "recipient_name": recipient.name,
                        "incoming_name": name,
                        "account_number": account_number
                    }
                )

                # Update bank account address if provided and different
                if address:
                    normalized_new = TextNormalizationService.normalize_recipient_name(address)
                    normalized_current = bank_account.address if bank_account.address else None

                    if normalized_current != normalized_new:
                        logger.info(
                            "Updating bank account address",
                            extra={
                                "operation": "enrich_bank_account",
                                "resource_type": "recipient_bank_account",
                                "resource_id": bank_account.id,
                                "old_address": bank_account.address,
                                "new_address": address
                            }
                        )
                        bank_account.address = address
                        bank_account_service.bank_account_repo.update(bank_account)

                return recipient, False

        # PRIORITY 2: Try normalized name lookup (handles word order variations)
        if not recipient:
            normalized_name = TextNormalizationService.normalize_name_for_matching(name)
            recipient = self.recipient_repo.get_by_normalized_name(normalized_name)

        # Found by normalized name - link the new bank account if provided
        if recipient:
            if account_number:
                # Create/link the bank account to this recipient
                bank_account, bank_created = bank_account_service.create_or_get_bank_account(
                    recipient_id=recipient.id,
                    account_number=account_number,
                    bank_name=bank_name,
                    address=address
                )

                if bank_created:
                    logger.info(
                        "Linked new bank account to existing recipient",
                        extra={
                            "operation": "link_bank_account",
                            "resource_type": "recipient",
                            "resource_id": recipient.id,
                            "account_number": account_number,
                            "bank_name": bank_name
                        }
                    )

            # Keep the original recipient name - do not update it
            # This ensures the first imported name format is retained consistently
            logger.debug(
                "Found existing recipient by normalized name match",
                extra={
                    "operation": "find_recipient",
                    "resource_type": "recipient",
                    "resource_id": recipient.id,
                    "recipient_name": recipient.name,
                    "incoming_name": name
                }
            )

            return recipient, False

        # PRIORITY 3: Create new recipient (no matches found)
        recipient = Recipient(
            name=name,
            # normalized_name is set automatically by SQLAlchemy event listener
            is_active=True
        )
        self.recipient_repo.create(recipient)

        # Create associated bank account if account number provided
        if account_number:
            bank_account_service.create_or_get_bank_account(
                recipient_id=recipient.id,
                account_number=account_number,
                bank_name=bank_name,
                address=address,
                set_as_primary=True
            )

        logger.info(
            "Created new recipient with normalized name matching",
            extra={
                "operation": "create_recipient",
                "resource_type": "recipient",
                "resource_id": recipient.id,
                "recipient_name": name,
                "normalized_name": recipient.normalized_name,
                "has_account_number": account_number is not None,
                "bank_name": bank_name
            }
        )

        return recipient, True

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

    def get_by_account_number(self, account_number: str) -> Optional[Recipient]:
        """Get a recipient by exact account number match.

        Retrieves a single recipient by its exact account number. This is the most
        reliable way to identify recipients since account numbers are unique and
        don't change over time, unlike names which may have variations.

        Account numbers provide the best recipient matching because:
        - They are unique (enforced by database constraint)
        - They are immutable (don't change over time)
        - They are standardized (bank-issued identifiers)
        - They avoid name variation issues (e.g., "John Smith" vs "SMITH JOHN")

        Args:
            account_number (str): The exact account number of the recipient to retrieve.

        Returns:
            Optional[Recipient]: The Recipient object if found, None if not found or account number is empty.

        Example:
            service = RecipientService(db)

            # Find by account number
            recipient = service.get_by_account_number("BE61734041478017")
            if recipient:
                print(f"Found: {recipient.name} (ID: {recipient.id})")

            # Empty account number returns None
            recipient = service.get_by_account_number("")  # Returns None

        Note:
            - Search is exact match on account number
            - Returns both active and inactive recipients
            - Returns None if account_number is empty or None
            - Most reliable method for recipient identification during imports
            - Preferred over name-based lookups when account number is available
        """
        if not account_number:
            return None
        return self.recipient_repo.get_by_account_number(account_number)

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
        if default_category_id is not None:
            recipient.default_category_id = default_category_id
        if notes is not None:
            recipient.notes = notes
        if address is not None:
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
        recipient, _ = self.create_or_get_recipient(name=name, account_number=account_number)
        return recipient

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
