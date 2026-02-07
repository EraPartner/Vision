"""Category Management Service module.

This module provides high-level business logic for managing hierarchical categories
with a General:Detail structure. It uses the repository pattern to abstract database
operations and coordinates between multiple repositories to enforce business rules.

The service layer is responsible for:
- Category CRUD operations with validation
- Hierarchical category management
- Assigning categories to recipients and transactions
- Category statistics and reporting
- Bulk operations on categories

Classes:
    CategoryService: Main service class for category management.
"""
from typing import List, Optional

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Category
from repositories.category_repository import CategoryRepository
from repositories.recipient_repository import RecipientRepository
from services.text_normalization_service import TextNormalizationService

# Setup logging
logger = setup_logging(__name__)


class CategoryService:
    """Service for managing hierarchical categories.

    Provides high-level business logic for category operations, coordinating
    between repositories and enforcing business rules. This service layer separates
    business logic from data access, making the code more testable and maintainable.

    The service handles:
    - Getting, creating, updating, and deleting categories
    - Hierarchical General:Detail category structure
    - Assigning categories to recipients and transactions
    - Category statistics and reporting
    - Bulk operations

    Attributes:
        category_repo (CategoryRepository): Repository for category data access.
        recipient_repo (RecipientRepository): Repository for recipient data access.

    Example:
        service = CategoryService(db_session)
        category = service.get_or_create_category("Groceries", "Food")
        updated = service.update(category.id, detail="Groceries")
    """

    def __init__(self, db_session: Session):
        """Initialize the category service with repositories."""
        self.category_repo = CategoryRepository(db_session)
        self.recipient_repo = RecipientRepository(db_session)

    # ==================== Basic CRUD Operations ====================

    def get_all(
            self,
            limit: Optional[int] = None,
            offset: Optional[int] = None,
            general: Optional[str] = None,
            detail: Optional[str] = None,
            active: bool = True
    ) -> List[Category]:
        """Get all categories in a flat list.

        Retrieves all categories in a single flat list, sorted by
        general and detail names. This is useful for UI displays and exports.
        Supports filtering by general and detail names, and by active status.

        Args:
            limit: Max rows to return (None for all).
            offset: Rows to skip before returning results.
            general: Filter by partial general name match (case-insensitive).
            detail: Filter by partial detail name match (case-insensitive).
            active: Filter by active status. True for active only, False for all.

        Returns:
            List[Category]: List of categories matching the filters, sorted by general and detail.

        Example:
            service = CategoryService(db)
            all_categories = service.get_all_flat()
            for cat in all_categories:
                print(f"{cat.general}: {cat.detail}")

            # Filter by general name
            groceries = service.get_all_flat(general="GROCERIES")

            # Filter by both general and detail
            food_cats = service.get_all_flat(general="GROCERIES", detail="FOOD")

            # Get all categories including inactive ones
            all_including_inactive = service.get_all_flat(active=False)

        Note:
            - By default, only active categories are included (active=True)
            - When active=False, both active and inactive categories are returned
            - Returns empty list if no categories exist
            - Results are always sorted for consistent ordering
            - General and detail filtering is case-insensitive and supports partial matches
        """
        return self.category_repo.get_all_active(limit, offset, general, detail, active)

    def get_by_id(self, category_id: int) -> Optional[Category]:
        """Get a category by its ID.

        Retrieves a single category identified by its unique ID, regardless of
        whether it's active or inactive.

        Args:
            category_id (int): The unique identifier of the category to retrieve.

        Returns:
            Optional[Category]: The Category object if found, None otherwise.

        Example:
            service = CategoryService(db)
            category = service.get_by_id(5)
            if category:
                print(f"{category.general}: {category.detail}")

        Note:
            - Returns both active and inactive categories
            - Returns None if category doesn't exist
            - Does not raise exceptions on missing categories
        """
        return self.category_repo.get_by_id(category_id)

    def create_or_get_category(
            self,
            general: str,
            detail: str,
            description: Optional[str] = None,
    ) -> Category:
        """Get an existing category or create a new one.

        Looks up a category by its general and detail names. If it doesn't exist,
        creates a new category with the provided details and returns it.

        General and detail names are automatically normalized to uppercase by
        SQLAlchemy event handlers for consistent storage and display.

        This is an idempotent operation - calling it multiple times with the same
        general and detail names will return the same category object without
        creating duplicates.

        Args:
            general (str): General (parent) category name (e.g., "groceries" -> "GROCERIES").
            detail (str): Detail (child) category name (e.g., "food" -> "FOOD").
            description (str, optional): Optional category description.

        Returns:
            Category: The found or newly created Category object.

        Example:
            service = CategoryService(db)

            # Create new category (input will be normalized automatically)
            cat = service.create_or_get_category("groceries", "food")
            print(cat.general)  # "GROCERIES"
            print(cat.detail)   # "FOOD"

            # Get same category again (doesn't create duplicate)
            cat2 = service.create_or_get_category("GROCERIES", "FOOD")
            assert cat.id == cat2.id

        Note:
            - Idempotent operation - safe to call multiple times
            - General and detail names are automatically converted to uppercase
            - Case-insensitive matching for lookups
            - New categories are created as active (is_active=True)
            - Useful for transaction imports and batch operations
        """
        # Normalize input for lookup to match uppercase stored values
        general_normalized = TextNormalizationService.normalize_category_name(general) if general else ""
        detail_normalized = TextNormalizationService.normalize_category_name(detail) if detail else ""

        category = self.category_repo.get_by_general_detail(general_normalized, detail_normalized)

        if not category:
            # SQLAlchemy events will automatically normalize these to uppercase
            category = Category(
                general=general,  # Will be normalized automatically by SQLAlchemy events
                detail=detail,  # Will be normalized automatically by SQLAlchemy events
                description=description,
                is_active=True
            )
            self.category_repo.create(category)
            logger.info(
                "Category created successfully",
                extra={
                    "operation": "create_category",
                    "resource_type": "category",
                    "resource_id": category.id,
                    "general": category.general,  # Now uppercase due to events
                    "detail": category.detail  # Now uppercase due to events
                }
            )
        else:
            logger.debug(
                "Category already exists",
                extra={
                    "operation": "get_existing_category",
                    "resource_type": "category",
                    "resource_id": category.id,
                    "general": category.general,
                    "detail": category.detail
                }
            )

        return category

    def update(
            self,
            category_id: int,
            general: Optional[str] = None,
            detail: Optional[str] = None,
            description: Optional[str] = None,
    ) -> Optional[Category]:
        """Update a category with validation.

        Updates one or more properties of an existing category. Only provided
        parameters are updated; omitted parameters leave existing values unchanged.
        General and detail names are automatically normalized to uppercase.

        Args:
            category_id (int): The ID of the category to update.
            general (str, optional): New general category name. If provided,
                will be normalized to uppercase.
            detail (str, optional): New detail category name. If provided,
                will be normalized to uppercase.
            description (str, optional): New category description.

        Returns:
            Optional[Category]: The updated Category object if found and modified,
                None if category not found.

        Example:
            service = CategoryService(db)

            # Update category names (will be normalized to uppercase)
            updated = service.update(5, general="new general", detail="new detail")
            print(updated.general)  # "NEW GENERAL"
            print(updated.detail)   # "NEW DETAIL"

            # Returns None if category doesn't exist
            updated = service.update(999)

        Note:
            - Partial updates are allowed (provide only fields to change)
            - General and detail names are automatically converted to uppercase
            - Strings are stripped of leading/trailing whitespace
            - Transaction is committed if any fields are updated
            - Returns None without raising exception if category not found
        """
        category = self.category_repo.get_by_id(category_id)
        if not category:
            logger.debug(
                "Category not found for update",
                extra={
                    "operation": "update_category",
                    "resource_type": "category",
                    "resource_id": category_id,
                    "status": "not_found"
                }
            )
            return None

        updated = False

        if general is not None:
            # SQLAlchemy events will automatically normalize to uppercase
            category.general = general
            updated = True

        if detail is not None:
            # SQLAlchemy events will automatically normalize to uppercase
            category.detail = detail
            updated = True

        if description is not None:
            category.description = description
            updated = True

        if updated:
            self.category_repo.update(category)
            logger.info(
                "Category updated successfully",
                extra={
                    "operation": "update_category",
                    "resource_type": "category",
                    "resource_id": category_id,
                    "status": "success"
                }
            )

        return category

    def soft_delete(self, category_id: int) -> bool:
        """Delete a category (soft delete - mark as inactive).

        Performs a soft delete by marking the category as inactive. The category
        record remains in the database for historical reference and won't appear
        in active category queries.

        Args:
            category_id (int): The ID of the category to delete.

        Returns:
            bool: True if category was found and deleted, False if not found.

        Example:
            service = CategoryService(db)

            # Delete a category
            success = service.delete(5)
            if success:
                print("Category deleted")
            else:
                print("Category not found")

        Note:
            - This is a soft delete - data is preserved in the database
            - Deleted categories don't appear in get_all_flat() results
            - Historical transactions linked to deleted categories are preserved
            - To restore a deleted category, update is_active=True manually
        """
        category = self.category_repo.get_by_id(category_id)
        if not category:
            logger.debug(
                "Category not found for soft delete",
                extra={
                    "operation": "soft_delete_category",
                    "resource_type": "category",
                    "resource_id": category_id,
                    "status": "not_found"
                }
            )
            return False

        self.category_repo.soft_delete(category)
        logger.info(
            "Category soft deleted successfully",
            extra={
                "operation": "soft_delete_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "success"
            }
        )
        return True

    def hard_delete(self, category_id: int) -> bool:
        """Permanently delete a category from the database.

        This operation removes the category record entirely from the database.
        Use with caution, as this action is irreversible and may affect data integrity
        if other records reference this category.

        Args:
            category_id (int): The ID of the category to permanently delete.

        Returns:
            bool: True if category was found and deleted, False if not found.

        Example:
            service = CategoryService(db)

            # Permanently delete a category
            success = service.hard_delete(5)
            if success:
                print("Category permanently deleted")
            else:
                print("Category not found")

        Note:
            - This is a hard delete - data is permanently removed
            - Use with caution to avoid breaking data integrity
            - Consider soft deleting first to preserve historical data
        """
        category = self.category_repo.get_by_id(category_id)
        if not category:
            logger.debug(
                "Category not found for hard delete",
                extra={
                    "operation": "hard_delete_category",
                    "resource_type": "category",
                    "resource_id": category_id,
                    "status": "not_found"
                }
            )
            return False

        self.category_repo.hard_delete(category)
        logger.warning(
            "Category hard deleted permanently",
            extra={
                "operation": "hard_delete_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "success"
            }
        )
        return True

    def assign_category(
            self,
            recipient_ids: List[int],
            category: Category
    ) -> Optional[int]:
        """Assign a category to multiple recipients at once.

        Performs a bulk operation to assign the same default category to multiple
        recipients in a single operation.

        This is useful for setting default categories for groups of recipients
        that share the same transaction patterns.

        Args:
            recipient_ids (List[int] | None): List of recipient IDs to assign the category to.
            category (Category): The Category object to assign.

        Returns:
            int: Number of recipients successfully updated.

        Raises:
            ValueError: If recipient_ids is empty.

        Example:
            service = CategoryService(db)

            # Assign same category to multiple recipients
            recipients = [1, 2, 3, 4, 5]
            updated = service.assign_category(recipients, category)
            print(f"Updated {updated} recipients")

        Note:
            - Non-existent recipients in the list are silently skipped
            - Overwrites existing default category assignments
            - Transaction is committed after all updates
            - Useful for batch operations after recipient imports
        """
        updated = 0
        for recipient_id in recipient_ids:
            recipient = self.recipient_repo.get_by_id(recipient_id)
            if recipient:
                recipient.default_category_id = category.id
                updated += 1
                self.recipient_repo.update(recipient)
            else:
                logger.debug(f"Recipient not found: {recipient_id}")
                return None

        logger.info(
            "Category assigned to recipients",
            extra={
                "operation": "assign_category",
                "resource_type": "category",
                "resource_id": category.id,
                "count": updated,
                "recipient_count": len(recipient_ids)
            }
        )

        return updated

    def get_by_general_detail(
            self,
            general: str,
            detail: str
    ) -> Optional[Category]:
        """Get a category by its general and detail names.

        Retrieves a single category identified by its general and detail names.
        Input is automatically normalized to uppercase for case-insensitive lookup.

        Args:
            general (str): General (parent) category name (case-insensitive).
            detail (str): Detail (child) category name (case-insensitive).

        Returns:
            Optional[Category]: The Category object if found, None otherwise.

        Example:
            service = CategoryService(db)

            # These all find the same category:
            category = service.get_by_general_detail("groceries", "food")
            category = service.get_by_general_detail("GROCERIES", "FOOD")
            category = service.get_by_general_detail("Groceries", "Food")

            if category:
                print(f"Found category ID: {category.id}")
                print(f"Stored as: {category.general}:{category.detail}")  # Always uppercase
        """
        # Normalize input to uppercase for case-insensitive lookup against uppercase DB values
        general_normalized = TextNormalizationService.normalize_category_name(general) if general else ""
        detail_normalized = TextNormalizationService.normalize_category_name(detail) if detail else ""

        return self.category_repo.get_by_general_detail(general_normalized, detail_normalized)

    def get_total_count(self, active: bool = True) -> int:
        """Get the total count of categories in the database.

        Args:
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: Total number of categories matching the active filter.

        Example:
            service = CategoryService(db)
            active_total = service.get_total_count()
            all_total = service.get_total_count(active=False)
        """
        return self.category_repo.get_total_count(active)

    def get_filtered_count(self, general: Optional[str] = None, detail: Optional[str] = None,
                           active: bool = True) -> int:
        """Get the count of categories matching the specified filters.

        Returns the total number of categories that match the provided
        general and detail filters, and active status. This is useful for pagination calculations
        when filters are applied.

        Args:
            general: Filter by partial general name match (case-insensitive).
            detail: Filter by partial detail name match (case-insensitive).
            active: Filter by active status. True for active only, False for all.

        Returns:
            int: Count of categories matching the filters.

        Example:
            service = CategoryService(db)

            # Count all active categories
            total = service.get_filtered_count()

            # Count categories with general name containing "groceries"
            groceries_count = service.get_filtered_count(general="groceries")

            # Count all categories including inactive ones
            all_count = service.get_filtered_count(active=False)
        """
        return self.category_repo.get_filtered_count(general, detail, active)
