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
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from database.models import Category
from repositories.category_repository import CategoryRepository
from repositories.recipient_repository import RecipientRepository


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
        updated = service.update(category.id, color="#FF5733")
    """

    def __init__(self, db_session: Session):
        """Initialize the category service with repositories.
        """
        self.category_repo = CategoryRepository(db_session)
        self.recipient_repo = RecipientRepository(db_session)

    # ==================== Category CRUD Methods ====================

    def get_all_flat(self, limit: int | None = None, offset: int | None = None) -> List[Category]:
        """Get all active categories in a flat list.

        Retrieves all active categories in a single flat list, sorted by
        general and detail names. This is useful for UI displays and exports.

        Args:
            limit: Max rows to return (None for all).
            offset: Rows to skip before returning results.

        Returns:
            List[Category]: List of all active categories sorted by general and detail.

        Example:
            service = CategoryService(db)
            all_categories = service.get_all_flat()
            for cat in all_categories:
                print(f"{cat.general}: {cat.detail}")

        Note:
            - Only includes active categories (is_active=True)
            - Returns empty list if no categories exist
            - Results are always sorted for consistent ordering
        """
        return self.category_repo.get_all_active(limit=limit, offset=offset)

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

    def get_or_create_category(
            self,
            general: str,
            detail: str,
            description: Optional[str] = None,
            color: Optional[str] = None
    ) -> Category:
        """Get an existing category or create a new one.

        Looks up a category by its general and detail names. If it doesn't exist,
        creates a new category with the provided details and returns it.

        This is an idempotent operation - calling it multiple times with the same
        general and detail names will return the same category object without
        creating duplicates.

        Args:
            general (str): General (parent) category name (e.g., "Groceries").
            detail (str): Detail (child) category name (e.g., "Food").
            description (str, optional): Optional category description.
            color (str, optional): Optional hex color code (e.g., "#FF5733").

        Returns:
            Category: The found or newly created Category object.

        Example:
            service = CategoryService(db)

            # Create new category
            cat = service.get_or_create_category("Groceries", "Food", color="#FF5733")

            # Get same category again (doesn't create duplicate)
            cat2 = service.get_or_create_category("Groceries", "Food")
            assert cat.id == cat2.id

        Note:
            - Idempotent operation - safe to call multiple times
            - Case-sensitive category matching
            - New categories are created as active (is_active=True)
            - Useful for transaction imports and batch operations
        """
        category = self.category_repo.get_by_general_detail(general, detail)

        if not category:
            category = Category(
                general=general,
                detail=detail,
                description=description,
                color=color,
                is_active=True
            )
            self.category_repo.create(category)

        return category

    def update(
            self,
            category_id: int,
            general: Optional[str] = None,
            detail: Optional[str] = None,
            description: Optional[str] = None,
            color: Optional[str] = None
    ) -> Optional[Category]:
        """Update a category with validation.

        Updates one or more properties of an existing category. Only provided
        parameters are updated; omitted parameters leave existing values unchanged.
        Validates that general and detail names are not empty.

        Args:
            category_id (int): The ID of the category to update.
            general (str, optional): New general category name. If provided,
                must not be empty after stripping whitespace.
            detail (str, optional): New detail category name. If provided,
                must not be empty after stripping whitespace.
            description (str, optional): New category description.
            color (str, optional): New hex color code.

        Returns:
            Optional[Category]: The updated Category object if found and modified,
                None if category not found.

        Raises:
            ValueError: If general or detail name is provided but empty after stripping.

        Example:
            service = CategoryService(db)

            # Update just the color
            updated = service.update(5, color="#FF5733")

            # Update multiple fields
            updated = service.update(5, general="New General", color="#00FF00")

            # Returns None if category doesn't exist
            updated = service.update(999)

        Note:
            - Partial updates are allowed (provide only fields to change)
            - Both general and detail are validated for non-empty values
            - Strings are stripped of leading/trailing whitespace
            - Transaction is committed if any fields are updated
            - Returns None without raising exception if category not found
        """
        category = self.category_repo.get_by_id(category_id)
        if not category:
            return None

        updated = False

        if general is not None:
            general = general.strip()
            if not general:
                raise ValueError("General name cannot be empty")
            category.general = general
            updated = True

        if detail is not None:
            detail = detail.strip()
            if not detail:
                raise ValueError("Detail name cannot be empty")
            category.detail = detail
            updated = True

        if description is not None:
            category.description = description
            updated = True

        if color is not None:
            category.color = color
            updated = True

        if updated:
            self.category_repo.update(category)

        return category

    def delete(self, category_id: int) -> bool:
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
            return False

        self.category_repo.soft_delete(category)
        return True

    def assign_category(
            self,
            recipient_ids: List[int],
            category: Category
    ) -> Dict[str, int]:
        """Assign a category to multiple recipients at once.

        Performs a bulk operation to assign the same default category to multiple
        recipients in a single operation. Creates the category if it doesn't exist.

        This is useful for setting default categories for groups of recipients
        that share the same transaction patterns.

        Args:
            recipient_ids (List[int]): List of recipient IDs to assign the category to.
            category (Category): The Category object to assign.

        Returns:
            Dict[str, int]: Dictionary containing:
                - 'updated' (int): Number of recipients successfully updated

        Example:
            service = CategoryService(db)

            # Assign same category to multiple recipients
            recipients = [1, 2, 3, 4, 5]
            result = service.bulk_assign_category(recipients, "Utilities:Electric")
            print(f"Updated {result['updated']} recipients")

        Note:
            - Non-existent recipients in the list are silently skipped
            - Creates the category if it doesn't exist
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

        return {'updated': updated}

    def get_by_general_detail(
            self,
            general: str,
            detail: str
    ) -> Optional[Category]:
        """Get a category by its general and detail names.

        Retrieves a single category identified by its general and detail names.

        Args:
            general (str): General (parent) category name.
            detail (str): Detail (child) category name.
        Returns:
            Optional[Category]: The Category object if found, None otherwise.
        Example:
            service = CategoryService(db)
            category = service.get_by_general_detail("Groceries", "Food")
            if category:
                print(f"Found category ID: {category.id}")
        """
        return self.category_repo.get_by_general_detail(general, detail)
