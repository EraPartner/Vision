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

from database.models import Category


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

    def get_all_active(self, limit: int | None = None, offset: int | None = None) -> List[Category]:
        """Get all active categories in a flat list ordered by general and detail.

        Retrieves active categories ordered by general then detail. Optional limit
        and offset enable pagination directly in the query to avoid loading all
        rows into memory.

        Args:
            limit (int | None): Maximum number of rows to return. If None, returns all.
            offset (int | None): Number of rows to skip before returning results.

        Returns:
            List[Category]: Active categories sorted by general and detail.

        Example:
            categories = repo.get_all_active(limit=10, offset=20)
            for cat in categories:
                print(f"{cat.general}: {cat.detail}")

        Note:
            - Inactive categories are excluded
            - Results are always sorted for consistent ordering
            - Empty list is returned if no active categories exist
        """
        query = self.db.query(Category).filter(Category.is_active == True).order_by(
            Category.general, Category.detail
        )

        if offset is not None:
            query = query.offset(offset)
        if limit is not None:
            query = query.limit(limit)

        return query.all()

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
        return self.db.query(Category).filter(Category.id == category_id).first()

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
        return self.db.query(Category).filter(
            Category.general == general,
            Category.detail == detail
        ).first()

    def get_by_general(self, general: str) -> List[Category]:
        """Get all detail categories under a general category.

        Retrieves all active categories that belong to the specified general category.
        Results are sorted alphabetically by detail name.

        Args:
            general (str): The general (parent) category name to query.

        Returns:
            List[Category]: List of active Category objects matching the general name,
                sorted by detail name. Empty list if no matches found.

        Example:
            groceries = repo.get_by_general("Groceries")
            for item in groceries:
                print(f"  - {item.detail}")  # Prints: Food, Household, etc.

        Note:
            - Only returns active categories
            - Search is case-sensitive
            - Results are automatically sorted by detail name
            - Returns empty list if general category has no active sub-categories
        """
        return self.db.query(Category).filter(Category.general == general, Category.is_active == True).order_by(
            Category.detail).all()

    def get_general_categories(self) -> List[Category]:
        """Get all general (parent) categories with no parent.

        Retrieves all top-level (general) categories that don't have a parent category.
        These are the root categories under which detail categories are organized.
        Results are sorted alphabetically by general name.

        Returns:
            List[Category]: List of active general Category objects, sorted by name.
                Empty list if no general categories exist.

        Example:
            general_cats = repo.get_general_categories()
            for cat in general_cats:
                print(f"- {cat.general}")  # Prints: Groceries, Utilities, etc.

        Note:
            - Only returns active categories
            - Only includes categories where parent_id is None
            - Results are automatically sorted by general name
            - Useful for building category hierarchies in UI
        """
        return self.db.query(Category).filter(
            Category.parent_id.is_(None),
            Category.is_active == True
        ).order_by(Category.general).all()

    def create(self, category: Category) -> Category:
        """Create a new category in the database.

        Adds a new category to the database, commits the transaction, and returns
        the created category with the database-generated ID populated.

        Args:
            category (Category): A Category object with general and detail names,
                description, and color already set. The object should NOT have
                an id assigned yet.

        Returns:
            Category: The created Category object with id and any other auto-generated
                fields populated from the database.

        Example:
            from database.models import Category

            new_cat = Category(general="Groceries", detail="Food", color="#FF5733")
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
            category.color = "#FF5733"
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
