"""Recipient Repository module.

This module centralises all SQLAlchemy database operations for recipients.
It provides a clean interface for CRUD operations and recipient queries without
exposing raw SQL or ORM implementation details to the rest of the application.

The repository pattern separates data access logic from business logic, making
the code more testable and maintainable. This is particularly important for
financial applications where data integrity and audit trails are critical.

Classes:
    RecipientRepository: Main repository class for recipient data access.
"""
from typing import Optional, List, cast

from sqlalchemy.orm import Session, joinedload

from config.logging_config import setup_logging
from database.models import Recipient

# Setup logging
logger = setup_logging(__name__)


class RecipientRepository:
    """Repository for recipient data access and manipulation.

    Provides a clean interface for all database operations related to recipients,
    including querying, creating, updating, and deleting (soft delete) recipients.
    Recipients represent transaction payees or parties involved in financial
    transactions.

    This class encapsulates SQLAlchemy operations and provides methods that return
    domain objects rather than raw query objects, keeping data access logic separate
    from business logic. All operations include proper audit logging for financial
    compliance requirements.

    Attributes:
        db (Session): SQLAlchemy database session for executing queries.

    Example:
        repo = RecipientRepository(db_session)
        recipient = repo.get_by_id(1)
        all_recipients = repo.get_all_active(limit=50, offset=0)
    """

    def __init__(self, db: Session):
        """Initialise the repository with a database session.

        Args:
            db (Session): SQLAlchemy database session for executing queries.
        """
        self.db = db

    def get_all_active(self,
                       limit: Optional[int] = None,
                       offset: Optional[int] = None,
                       name: Optional[str] = None,
                       account_number: Optional[str] = None,
                       default_category_id: Optional[int] = None,
                       active: bool = True) -> List[Recipient]:
        """Get all recipients with optional filtering and pagination.

        Retrieves recipients ordered by name for consistent results.
        Supports pagination and filtering by name, account number, default
        category, and active status. All filters are combined using AND logic.

        Args:
            limit (int | None): Maximum number of rows to return. If None, returns all.
            offset (int | None): Number of rows to skip before returning results.
            name (str | None): Filter by partial name match (case-insensitive).
            account_number (str | None): Filter by partial account number match (case-insensitive).
            default_category_id (int | None): Filter by exact default category ID.
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            List[Recipient]: Recipients matching the filters, sorted by name.

        Example:
            # Get first 10 active recipients
            recipients = repo.get_all_active(limit=10, offset=0)

            # Filter by name containing "smith"
            recipients = repo.get_all_active(name="smith")

            # Get recipients with specific default category
            recipients = repo.get_all_active(default_category_id=5)

            # Get all recipients including inactive ones
            all_recipients = repo.get_all_active(active=False)

        Note:
            - By default, only active recipients are returned (active=True)
            - When active=False, both active and inactive recipients are returned
            - Name and account number filtering is case-insensitive and partial match
            - Results are ordered by name for consistent pagination
            - Empty list is returned if no matching recipients exist
            - All database operations are logged for audit purposes
        """
        query = self.db.query(Recipient).options(
            joinedload(Recipient.default_category)
        ).order_by(Recipient.id)

        # Apply active filter
        if active:
            query = query.filter(Recipient.is_active)

        # Apply filters if provided
        if name:
            query = query.filter(Recipient.name.ilike(f"%{name}%"))
        if account_number:
            query = query.filter(Recipient.account_number.ilike(f"%{account_number}%"))
        if default_category_id:
            query = query.filter(Recipient.default_category_id == default_category_id)

        # Apply pagination if provided
        if offset is not None:
            query = query.offset(offset)
        if limit is not None:
            query = query.limit(limit)

        results = query.all()
        logger.debug(
            "Retrieved active recipients from database",
            extra={
                "operation": "get_all_active",
                "resource_type": "recipient",
                "count": len(results),
                "limit": limit,
                "offset": offset,
                "filters": {
                    "name": name,
                    "account_number": account_number,
                    "default_category_id": default_category_id
                }
            }
        )
        return cast(List[Recipient], results)

    def get_by_id(self, recipient_id: int) -> Optional[Recipient]:
        """Get a recipient by its primary key ID.

        Retrieves a single recipient identified by its unique ID, regardless of
        whether it's active or inactive. This method is commonly used for
        lookups when the recipient ID is known.

        Args:
            recipient_id (int): The unique identifier of the recipient to retrieve.

        Returns:
            Optional[Recipient]: The Recipient object if found, None otherwise.

        Example:
            recipient = repo.get_by_id(5)
            if recipient:
                print(f"Found: {recipient.name} ({recipient.account_number})")
            else:
                print("Recipient not found")

        Note:
            - Returns both active and inactive recipients
            - Returns None if recipient doesn't exist
            - Does not raise exceptions on missing recipients
            - All lookups are logged for audit purposes
        """
        result = self.db.query(Recipient).filter(Recipient.id == recipient_id).first()
        logger.debug(
            "Recipient lookup by ID",
            extra={
                "operation": "get_by_id",
                "resource_type": "recipient",
                "resource_id": recipient_id,
                "found": result is not None
            }
        )
        return result

    def get_by_name(self, name: str) -> Optional[Recipient]:
        """Get a recipient by exact name match.

        Retrieves a single recipient by its exact name. This method performs
        a case-sensitive exact match lookup, useful for finding specific recipients
        when the exact name is known.

        Args:
            name (str): The exact name of the recipient to retrieve.

        Returns:
            Optional[Recipient]: The Recipient object if found, None otherwise.

        Example:
            recipient = repo.get_by_name("JOHN SMITH")
            if recipient:
                print(f"Found recipient ID: {recipient.id}")

        Note:
            - Search is case-sensitive and requires exact match
            - Returns both active and inactive recipients
            - Returns None if no recipient has the exact name
            - For partial name searches, use get_all_active(name="partial")
            - All lookups are logged for audit purposes
        """
        result = self.db.query(Recipient).options(
            joinedload(Recipient.default_category)
        ).filter(Recipient.name == name).first()
        logger.debug(
            "Recipient lookup by name",
            extra={
                "operation": "get_by_name",
                "resource_type": "recipient",
                "name": name,
                "found": result is not None
            }
        )
        return result

    def get_by_normalized_name(self, normalized_name: str) -> Optional[Recipient]:
        """Get a recipient by normalized name.

        Retrieves a recipient using the normalized name field, which handles
        word order variations (e.g., "JOHN SMITH" vs "SMITH JOHN"). This enables
        intelligent recipient matching that prevents duplicates when banks format
        names differently.

        Args:
            normalized_name (str): The normalized name (canonical form with sorted tokens).

        Returns:
            Optional[Recipient]: The Recipient object if found, None otherwise.

        Example:
            from services.text_normalization_service import TextNormalizationService

            # Both of these will find the same recipient
            normalized1 = TextNormalizationService.normalize_name_for_matching("JOHN SMITH")
            recipient1 = repo.get_by_normalized_name(normalized1)

            normalized2 = TextNormalizationService.normalize_name_for_matching("SMITH JOHN")
            recipient2 = repo.get_by_normalized_name(normalized2)

            assert recipient1.id == recipient2.id  # Same recipient!

        Note:
            - Handles word order variations in names
            - Prevents duplicate recipients with different name formats
            - Family members with same last name remain separate (different full names)
            - Returns both active and inactive recipients
            - All lookups are logged for audit purposes
        """
        if not normalized_name or not normalized_name.strip():
            return None

        result = self.db.query(Recipient).options(
            joinedload(Recipient.default_category)
        ).filter(Recipient.normalized_name == normalized_name.strip()).first()

        logger.debug(
            "Recipient lookup by normalized name",
            extra={
                "operation": "get_by_normalized_name",
                "resource_type": "recipient",
                "normalized_name": normalized_name,
                "found": result is not None
            }
        )
        return result

    def get_by_account_number(self, account_number: str) -> Optional[Recipient]:
        """Get a recipient by exact account number match.

        DEPRECATED: This method is kept for backward compatibility but should not be used
        for new code. Use RecipientBankAccountService.get_by_account_number() instead,
        which properly handles the many-to-many relationship between recipients and accounts.

        Retrieves a single recipient by its exact account number. This method performs
        an exact match lookup, which is highly reliable for identifying recipients
        since account numbers are unique and don't change over time.

        Account numbers are the most reliable way to identify recipients because:
        - They are unique (enforced by database constraint)
        - They don't change over time (unlike names which may have variations)
        - They are standardized (bank-issued identifiers)

        Args:
            account_number (str): The exact account number of the recipient to retrieve.

        Returns:
            Optional[Recipient]: The Recipient object if found, None otherwise.

        Example:
            recipient = repo.get_by_account_number("BE61734041478017")
            if recipient:
                print(f"Found: {recipient.name} (ID: {recipient.id})")

        Note:
            - Search is exact match on account number field
            - Returns both active and inactive recipients
            - Returns None if no recipient has the account number
            - Most reliable method for recipient identification
            - All lookups are logged for audit purposes
        """
        if not account_number or not account_number.strip():
            return None

        result = self.db.query(Recipient).options(
            joinedload(Recipient.default_category)
        ).filter(Recipient.account_number == account_number.strip()).first()

        logger.debug(
            "Recipient lookup by account number",
            extra={
                "operation": "get_by_account_number",
                "resource_type": "recipient",
                "account_number": account_number,
                "found": result is not None
            }
        )
        return result

    def create(self, recipient: Recipient) -> Recipient:
        """Create a new recipient in the database.

        Adds a new recipient to the database, commits the transaction, and returns
        the created recipient with the database-generated ID populated. This method
        handles all the database-specific operations for recipient creation.

        Args:
            recipient (Recipient): A Recipient object with name and other attributes
                already set. The object should NOT have an id assigned yet.

        Returns:
            Recipient: The created Recipient object with id and any other auto-generated
                fields populated from the database.

        Example:
            from database.models import Recipient

            new_recipient = Recipient(
                name="JOHN SMITH",
                account_number="12345678",
                notes="Regular business client"
            )
            created = repo.create(new_recipient)
            print(f"Created recipient with ID: {created.id}")

        Raises:
            SQLAlchemy exceptions: If the database operation fails (e.g., integrity
                constraints violated, database connection issues).

        Note:
            - Transaction is automatically committed
            - Object is refreshed from database after creation
            - Use service layer for business logic validation before calling this
            - Account numbers must be unique if provided
            - All create operations are logged for audit purposes
        """
        self.db.add(recipient)
        self.db.commit()
        self.db.refresh(recipient)
        logger.debug(
            "Recipient created in database",
            extra={
                "operation": "create_recipient",
                "resource_type": "recipient",
                "resource_id": recipient.id,
                "name": recipient.name
            }
        )
        return recipient

    def update(self, recipient: Recipient) -> Recipient:
        """Update an existing recipient in the database.

        Persists changes made to an existing recipient object. The recipient object
        must be tracked by the SQLAlchemy session (typically obtained from get_by_id).
        Any attribute changes made before calling this method will be saved to the database.

        Args:
            recipient (Recipient): An existing Recipient object (obtained from a query)
                with modified attributes. The object must have an id that exists
                in the database.

        Returns:
            Recipient: The updated Recipient object with changes persisted and refreshed
                from the database.

        Example:
            recipient = repo.get_by_id(5)
            recipient.notes = "Updated business relationship notes"
            recipient.default_category_id = 10
            updated = repo.update(recipient)

        Raises:
            SQLAlchemy exceptions: If the database operation fails.

        Note:
            - Transaction is automatically committed
            - Object is refreshed from database after update
            - Only works with tracked objects (from queries)
            - For creating new recipients, use create() instead
            - SQLAlchemy session must still be active
            - All update operations are logged for audit purposes
        """
        self.db.flush()
        self.db.refresh(recipient)
        logger.debug(
            "Recipient updated in database",
            extra={
                "operation": "update_recipient",
                "resource_type": "recipient",
                "resource_id": recipient.id
            }
        )
        return recipient

    def soft_delete(self, recipient: Recipient) -> None:
        """Soft delete a recipient (mark as inactive).

        Marks a recipient as inactive by setting is_active=False. The recipient record
        remains in the database for historical reference but won't appear in active
        recipient queries. This is the preferred deletion method for maintaining
        data integrity and audit trails.

        Args:
            recipient (Recipient): An existing Recipient object (obtained from a query)
                to mark as inactive. Must have an id that exists in the database.

        Returns:
            None

        Example:
            recipient = repo.get_by_id(5)
            repo.soft_delete(recipient)
            # Recipient is now inactive but still in the database

        Raises:
            SQLAlchemy exceptions: If the database operation fails.

        Note:
            - This is a soft delete - data is preserved in the database
            - Inactive recipients don't appear in get_all_active() results
            - Transaction is automatically committed
            - Use to maintain referential integrity with historical transactions
            - To restore a deleted recipient, set is_active=True and call update()
            - All delete operations are logged for audit purposes
        """
        recipient.is_active = False
        self.db.commit()
        logger.debug(
            "Recipient soft deleted in database",
            extra={
                "operation": "soft_delete_recipient",
                "resource_type": "recipient",
                "resource_id": recipient.id
            }
        )

    def hard_delete(self, recipient: Recipient) -> None:
        """Permanently delete a recipient from the database.

        Removes a recipient record entirely from the database. This operation is
        irreversible and should be used with extreme caution, especially in financial
        applications where audit trails are critical.

        Args:
            recipient (Recipient): An existing Recipient object (obtained from a query)
                to delete permanently. Must have an id that exists in the database.

        Returns:
            None

        Example:
            recipient = repo.get_by_id(5)
            repo.hard_delete(recipient)
            # Recipient is now permanently removed from the database

        Raises:
            SQLAlchemy exceptions: If the database operation fails, such as due to
                foreign key constraints from associated transactions.

        Note:
            - This is a hard delete - data is permanently removed
            - Use with extreme caution if other records reference this recipient
            - Transaction is automatically committed
            - Prefer soft_delete() for most use cases to preserve data integrity
            - May fail if transactions reference this recipient
            - All delete operations are logged with warning level for audit purposes
        """
        self.db.delete(recipient)
        self.db.commit()
        logger.warning(
            "Recipient hard deleted from database",
            extra={
                "operation": "hard_delete_recipient",
                "resource_type": "recipient",
                "resource_id": recipient.id
            }
        )

    def get_total_count(self, active: bool = True) -> int:
        """Get the total count of recipients in the database.

        Retrieves the total number of recipient records filtered by active status.
        This is useful for pagination calculations and dashboard statistics.

        Args:
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: The count of recipients matching the active filter.

        Example:
            # Count active recipients only
            active_count = repo.get_total_count()

            # Count all recipients including inactive
            total_count = repo.get_total_count(active=False)

        Note:
            - By default, only counts active recipients (active=True)
            - When active=False, counts both active and inactive recipients
            - Count operations are efficient and don't load full records
            - All count operations are logged for audit purposes
        """
        query = self.db.query(Recipient)
        if active:
            query = query.filter(Recipient.is_active)

        total = query.count()
        logger.debug(
            "Recipient total count retrieved",
            extra={
                "operation": "get_total_count",
                "resource_type": "recipient",
                "total": total,
                "active_filter": active
            }
        )
        return total

    def get_filtered_count(self,
                           name: Optional[str] = None,
                           account_number: Optional[str] = None,
                           default_category_id: Optional[int] = None,
                           active: bool = True) -> int:
        """Get the count of recipients matching the specified filters.

        Retrieves the total number of recipient records that match the
        provided name, account number, default category, and active status filters. This is useful
        for pagination calculations when filters are applied.

        Args:
            name (str | None): Filter by partial name match (case-insensitive).
            account_number (str | None): Filter by partial account number match (case-insensitive).
            default_category_id (int | None): Filter by exact default category ID.
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: The count of recipients matching the filters.

        Example:
            # Count all active recipients
            total = repo.get_filtered_count()

            # Count recipients with name containing "smith"
            smith_count = repo.get_filtered_count(name="smith")

            # Count with multiple filters
            specific_count = repo.get_filtered_count(name="john", default_category_id=5)

            # Count all recipients including inactive ones
            all_count = repo.get_filtered_count(active=False)

        Note:
            - By default, only counts active recipients (active=True)
            - When active=False, counts both active and inactive recipients
            - Name and account number filtering is case-insensitive and supports partial matches (except category_id)
            - Returns 0 if no matching recipients exist
            - Count operations are efficient and don't load full records
            - All count operations are logged for audit purposes
        """
        query = self.db.query(Recipient)

        # Apply active filter
        if active:
            query = query.filter(Recipient.is_active)

        # Apply same filters as get_all_active
        if name:
            query = query.filter(Recipient.name.ilike(f"%{name}%"))
        if account_number:
            query = query.filter(Recipient.account_number.ilike(f"%{account_number}%"))
        if default_category_id:
            query = query.filter(Recipient.default_category_id == default_category_id)

        total = query.count()
        logger.debug(
            "Recipient filtered count retrieved",
            extra={
                "operation": "get_filtered_count",
                "resource_type": "recipient",
                "total": total,
                "active_filter": active,
                "filters": {
                    "name": name,
                    "account_number": account_number,
                    "default_category_id": default_category_id
                }
            }
        )
        return total
