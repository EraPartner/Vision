"""Category Repository module.

This module centralizes all SQLAlchemy database operations for categories.
It provides a clean interface for CRUD operations and category queries without
exposing raw SQL or ORM implementation details to the rest of the application.

The repository pattern separates data access logic from business logic, making
the code more testable and maintainable.

Classes:
    CategoryRepository: Main repository class for category data access.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Category
from services.text_normalization_service import TextNormalizationService

# Setup logging
logger = setup_logging(__name__)


class CategoryRepository:
    """Repository for category data access and manipulation.

    Provides a clean interface for all database operations related to categories,
    including querying, creating, updating, and deleting (soft delete) categories.

    This class encapsulates SQLAlchemy operations and provides methods that return
    domain objects rather than raw query objects, keeping data access logic separate
    from business logic.

    Attributes:
        db (Session): SQLAlchemy database session for executing queries.

    Example:
        repo = CategoryRepository(db_session)
        category = repo.get_by_id(1)
        all_categories = repo.get_all_active()
    """

    def __init__(self, db: Session):
        """Initialize the repository with a database session.

        Args:
            db (Session): SQLAlchemy database session.
        """
        self.db = db

    def get_all_active(self,
                       limit: Optional[int] = None,
                       offset: Optional[int] = None,
                       general: Optional[str] = None,
                       detail: Optional[str] = None,
                       active: bool = True) -> List[Category]:
        """Get all categories in a flat list ordered by general and detail.

        Retrieves categories ordered by general then detail. Optional limit
        and offset enable pagination directly in the query to avoid loading all
        rows into memory. Supports filtering by general and detail names, and
        by active status.

        General and detail names are stored in uppercase, but filtering is case-insensitive
        to provide a better user experience.

        Args:
            limit (int | None): Maximum number of rows to return. If None, returns all.
            offset (int | None): Number of rows to skip before returning results.
            general (str | None): Filter by partial general name match (case-insensitive).
            detail (str | None): Filter by partial detail name match (case-insensitive).
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            List[Category]: Categories matching the filters, sorted by general and detail.

        Example:
            categories = repo.get_all_active(limit=10, offset=20)
            for cat in categories:
                print(f"{cat.general}: {cat.detail}")

            # Filter by general name (case-insensitive)
            groceries = repo.get_all_active(general="groceries")  # Finds "GROCERIES"

            # Filter by both general and detail (case-insensitive)
            food_cats = repo.get_all_active(general="GROCERIES", detail="food")  # Finds "GROCERIES:FOOD"

            # Get all categories including inactive ones
            all_cats = repo.get_all_active(active=False)

        Note:
            - By default, only active categories are returned (active=True)
            - When active=False, both active and inactive categories are returned
            - Results are always sorted for consistent ordering
            - Empty list is returned if no categories exist
            - General and detail filtering is case-insensitive and supports partial matches
            - All database operations are logged for audit purposes
            - Categories are stored in uppercase but search is case-insensitive
        """
        query = self.db.query(Category).order_by(Category.id)

        # Apply active filter
        if active:
            query = query.filter(Category.is_active)

        # Apply filters if provided - normalize input for case-insensitive search
        if general:
            # Normalize search input to match uppercase stored values
            general_normalized = TextNormalizationService.normalize_category_name(general)
            query = query.filter(Category.general.ilike(f"%{general_normalized}%"))
        if detail:
            # Normalize search input to match uppercase stored values
            detail_normalized = TextNormalizationService.normalize_category_name(detail)
            query = query.filter(Category.detail.ilike(f"%{detail_normalized}%"))

        # Apply pagination if provided
        if offset is not None:
            query = query.offset(offset)
        if limit is not None:
            query = query.limit(limit)

        results = query.all()
        logger.debug(
            "Retrieved active categories from database",
            extra={
                "operation": "get_all_active",
                "resource_type": "category",
                "count": len(results),
                "limit": limit,
                "offset": offset,
                "filters": {
                    "general": general,
                    "detail": detail
                }
            }
        )
        return results

    def get_by_id(self, category_id: int) -> Optional[Category]:
        """Get a category by its primary key ID.

        Retrieves a single category identified by its unique ID, regardless of
        whether it's active or inactive.

        Args:
            category_id (int): The unique identifier of the category to retrieve.

        Returns:
            Optional[Category]: The Category object if found, None otherwise.

        Example:
            category = repo.get_by_id(5)
            if category:
                print(f"Found: {category.general}:{category.detail}")
            else:
                print("Category not found")

        Note:
            - Returns both active and inactive categories
            - Returns None if category doesn't exist
            - Does not raise exceptions on missing categories
        """
        result = self.db.query(Category).filter(Category.id == category_id).first()
        logger.debug(
            "Category lookup by ID",
            extra={
                "operation": "get_by_id",
                "resource_type": "category",
                "resource_id": category_id,
                "found": result is not None
            }
        )
        return result

    def get_by_general_detail(self, general: str, detail: str) -> Optional[Category]:
        """Get a category by general and detail names.

        Retrieves a single category by its hierarchical naming structure.
        For example, "Groceries:Food" has general="Groceries" and detail="Food".

        Args:
            general (str): The general (parent) category name.
            detail (str): The detail (child) category name.

        Returns:
            Optional[Category]: The Category object if found, None otherwise.

        Example:
            category = repo.get_by_general_detail("Groceries", "Food")
            if category:
                print(f"Category ID: {category.id}")

        Note:
            - Search is case-sensitive
            - Returns both active and inactive categories
            - Returns None if the category combination doesn't exist
            - Use for looking up categories by their hierarchical names
        """
        result = self.db.query(Category).filter(
            Category.general == general,
            Category.detail == detail
        ).first()

        logger.debug(
            "Category lookup by general:detail",
            extra={
                "operation": "get_by_general_detail",
                "resource_type": "category",
                "general": general,
                "detail": detail,
                "found": result is not None
            }
        )
        return result

    def create(self, category: Category) -> Category:
        """Create a new category in the database.

        Adds a new category to the database, commits the transaction, and returns
        the created category with the database-generated ID populated.

        Args:
            category (Category): A Category object with general and detail names and
                description already set. The object should NOT have
                an id assigned yet.

        Returns:
            Category: The created Category object with id and any other auto-generated
                fields populated from the database.

        Example:
            from database.models import Category

            new_cat = Category(general="Groceries", detail="Food")
            created = repo.create(new_cat)
            print(f"Created category with ID: {created.id}")

        Raises:
            SQLAlchemy exceptions: If the database operation fails (e.g., integrity
                constraints violated, database connection issues).

        Note:
            - Transaction is automatically committed
            - Object is refreshed from database after creation
            - Use service layer for business logic validation before calling this
        """
        self.db.add(category)
        self.db.commit()
        self.db.refresh(category)
        logger.debug(
            "Category created in database",
            extra={
                "operation": "create_category",
                "resource_type": "category",
                "resource_id": category.id
            }
        )
        return category

    def update(self, category: Category) -> Category:
        """Update an existing category in the database.

        Persists changes made to an existing category object. The category object
        must be tracked by the SQLAlchemy session (typically obtained from get_by_id).
        Any attribute changes made before calling this method will be saved to the database.

        Args:
            category (Category): An existing Category object (obtained from a query)
                with modified attributes. The object must have an id that exists
                in the database.

        Returns:
            Category: The updated Category object with changes persisted and refreshed
                from the database.

        Example:
            category = repo.get_by_id(5)
            category.description = "Updated description"
            updated = repo.update(category)

        Raises:
            SQLAlchemy exceptions: If the database operation fails.

        Note:
            - Transaction is automatically committed
            - Object is refreshed from database after update
            - Only works with tracked objects (from queries)
            - For creating new categories, use create() instead
            - SQLAlchemy session must still be active
        """
        self.db.commit()
        self.db.refresh(category)
        logger.debug(
            "Category updated in database",
            extra={
                "operation": "update_category",
                "resource_type": "category",
                "resource_id": category.id
            }
        )
        return category

    def soft_delete(self, category: Category) -> None:
        """Soft delete a category (mark as inactive).

        Marks a category as inactive by setting is_active=False. The category record
        remains in the database for historical reference but won't appear in active
        category queries.

        Args:
            category (Category): An existing Category object (obtained from a query)
                to mark as inactive. Must have an id that exists in the database.

        Returns:
            None

        Example:
            category = repo.get_by_id(5)
            repo.soft_delete(category)
            # Category is now inactive but still in the database

        Raises:
            SQLAlchemy exceptions: If the database operation fails.

        Note:
            - This is a soft delete - data is preserved in the database
            - Inactive categories don't appear in get_all_active() results
            - Transaction is automatically committed
            - Use to maintain referential integrity with historical transactions
            - To restore a deleted category, set is_active=True and call update()
        """
        category.is_active = False
        self.db.commit()
        logger.debug(
            "Category soft deleted in database",
            extra={
                "operation": "soft_delete_category",
                "resource_type": "category",
                "resource_id": category.id
            }
        )

    def hard_delete(self, category: Category) -> None:
        """Permanently delete a category from the database.

        Removes a category record entirely from the database. This operation is
        irreversible and should be used with caution, especially if there are
        foreign key dependencies.

        Args:
            category (Category): An existing Category object (obtained from a query)
                to delete permanently. Must have an id that exists in the database.
        Returns:
            None
        Example:
            category = repo.get_by_id(5)
            repo.delete(category)
            # Category is now permanently removed from the database
        Raises:
            SQLAlchemy exceptions: If the database operation fails, such as due to
                foreign key constraints.
        Note:
            - This is a hard delete - data is permanently removed
            - Use with caution if other records reference this category
            - Transaction is automatically committed
            - Prefer soft_delete() for most use cases to preserve data integrity
        """
        self.db.delete(category)
        self.db.commit()
        logger.warning(
            "Category hard deleted from database",
            extra={
                "operation": "hard_delete_category",
                "resource_type": "category",
                "resource_id": category.id
            }
        )

    def get_total_count(self, active: bool = True) -> int:
        """Get the total count of categories in the database.

        Retrieves the total number of category records filtered by active status.

        Args:
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: The count of categories matching the active filter.

        Example:
            # Count active categories only
            active_total = repo.get_total_count()

            # Count all categories including inactive
            total = repo.get_total_count(active=False)

        Note:
            - By default, only counts active categories (active=True)
            - When active=False, counts both active and inactive categories
            - Useful for pagination and reporting
        """
        query = self.db.query(Category)
        if active:
            query = query.filter(Category.is_active)

        total = query.count()
        logger.debug(
            "Category total count retrieved",
            extra={
                "operation": "get_total_count",
                "resource_type": "category",
                "total": total,
                "active_filter": active
            }
        )
        return total

    def get_filtered_count(self, general: Optional[str] = None, detail: Optional[str] = None,
                           active: bool = True) -> int:
        """Get the count of categories matching the specified filters.

        Retrieves the total number of category records that match the
        provided general and detail filters, and active status. This is useful for pagination
        calculations when filters are applied.

        General and detail names are stored in uppercase, but filtering is case-insensitive.

        Args:
            general (str | None): Filter by partial general name match (case-insensitive).
            detail (str | None): Filter by partial detail name match (case-insensitive).
            active (bool): Filter by active status. True for active only, False for all.

        Returns:
            int: The count of categories matching the filters.

        Example:
            # Count all active categories
            total = repo.get_filtered_count()

            # Count categories with general name containing "groceries" (case-insensitive)
            groceries_count = repo.get_filtered_count(general="groceries")  # Finds "GROCERIES"

            # Count with both filters (case-insensitive)
            specific_count = repo.get_filtered_count(general="groceries", detail="food")  # Finds "GROCERIES:FOOD"

            # Count all categories including inactive ones
            all_count = repo.get_filtered_count(active=False)

        Note:
            - By default, only counts active categories (active=True)
            - When active=False, counts both active and inactive categories
            - General and detail filtering is case-insensitive and supports partial matches
            - Returns 0 if no matching categories exist
            - Count operations are efficient and don't load full records
            - All count operations are logged for audit purposes
            - Categories are stored in uppercase but search is case-insensitive
        """
        query = self.db.query(Category)

        # Apply active filter
        if active:
            query = query.filter(Category.is_active)

        # Apply same filters as get_all_active - normalize input for case-insensitive search
        if general:
            # Normalize search input to match uppercase stored values
            general_normalized = TextNormalizationService.normalize_category_name(general)
            query = query.filter(Category.general.ilike(f"%{general_normalized}%"))
        if detail:
            # Normalize search input to match uppercase stored values
            detail_normalized = TextNormalizationService.normalize_category_name(detail)
            query = query.filter(Category.detail.ilike(f"%{detail_normalized}%"))

        total = query.count()
        logger.debug(
            "Category filtered count retrieved",
            extra={
                "operation": "get_filtered_count",
                "resource_type": "category",
                "total": total,
                "active_filter": active,
                "filters": {
                    "general": general,
                    "detail": detail
                }
            }
        )
        return total
