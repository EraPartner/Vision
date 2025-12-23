"""
Category Management Service

Handles hierarchical categories with General:Detail structure
"""
from typing import Dict, List, Optional, Tuple, Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from database.models import Category, Recipient, Transaction
from repositories.category_repository import CategoryRepository
from repositories.recipient_repository import RecipientRepository


class CategoryService:
    """Service for managing hierarchical categories"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.category_repo = CategoryRepository(db_session)
        self.recipient_repo = RecipientRepository(db_session)

    # ==================== Parsing and Validation ====================

    def parse_category_path(self, category_path: str) -> Tuple[str, str]:
        """
        Parse category path in format "General:Detail"

        Args:
            category_path: Path in "General:Detail" format

        Returns:
            Tuple of (general, detail)

        Raises:
            ValueError: If format is invalid
        """
        if ':' not in category_path:
            raise ValueError(f"Category must be in 'General:Detail' format. Got: '{category_path}'")

        parts = category_path.split(':', 1)
        general = parts[0].strip()
        detail = parts[1].strip()

        if not general or not detail:
            raise ValueError(f"Category must have non-empty general and detail parts. Got: '{category_path}'")

        return general, detail

    # ==================== Category CRUD Methods ====================

    def get_all_flat(self) -> List[Category]:
        """Get all active categories in flat list"""
        return self.category_repo.get_all_active()

    def get_by_id(self, category_id: int) -> Optional[Category]:
        """Get a category by ID"""
        return self.category_repo.get_by_id(category_id)

    def get_or_create_category(
            self,
            category_path: str,
            description: Optional[str] = None,
            color: Optional[str] = None
    ) -> Category:
        """
        Get or create a category from path like "Food:Groceries"

        Args:
            category_path: Path in "General:Detail" format
            description: Optional description
            color: Optional hex color code

        Returns:
            The Category object (existing or newly created)

        Raises:
            ValueError: If path format is invalid
        """
        general, detail = self.parse_category_path(category_path)

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
        """
        Update a category.

        Args:
            category_id: The ID of the category to update
            general: New general name (if provided)
            detail: New detail name (if provided)
            description: New description (if provided)
            color: New color (if provided)

        Returns:
            The updated Category object if found, None otherwise
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
        """
        Delete a category (soft delete - mark as inactive).

        Args:
            category_id: The ID of the category to delete

        Returns:
            True if category was deleted, False if not found
        """
        category = self.category_repo.get_by_id(category_id)
        if not category:
            return False

        self.category_repo.soft_delete(category)
        return True

    def apply_recipient_categories_to_transactions(
            self,
            recipient_id: Optional[int] = None,
            overwrite_existing: bool = False
    ) -> Dict[str, int]:
        """
        Apply default recipient categories to transactions

        Args:
            recipient_id: If specified, only update transactions for this recipient
            overwrite_existing: If True, overwrite transactions that already have categories

        Returns:
            Dictionary with update statistics
        """
        query = self.db.query(Transaction).join(Recipient)

        if recipient_id:
            query = query.filter(Recipient.id == recipient_id)

        if not overwrite_existing:
            query = query.filter(Transaction.category_id.is_(None))

        # Only update where recipient has a default category
        query = query.filter(Recipient.default_category_id.isnot(None))

        transactions = query.all()

        updated = 0
        for transaction in transactions:
            transaction.category_id = transaction.recipient.default_category_id
            updated += 1

        self.db.commit()

        return {
            'updated': updated,
            'total_checked': len(transactions)
        }

    def get_uncategorized_recipients(self) -> List[Recipient]:
        """Get all recipients without a default category"""
        return self.recipient_repo.get_uncategorized()

    def get_category_statistics(self) -> Dict[str, Any]:
        """Get statistics about categories"""
        total_categories = self.db.query(func.count(Category.id)).filter(
            Category.is_active == True
        ).scalar() or 0

        from repositories.transaction_repository import TransactionRepository
        counts = TransactionRepository(self.db).count_categorized_vs_uncategorized()
        categorized_transactions = counts['categorized']
        uncategorized_transactions = counts['uncategorized']

        categorized_recipients = self.db.query(func.count(Recipient.id)).filter(
            Recipient.default_category_id.isnot(None)
        ).scalar() or 0
        uncategorized_recipients = self.db.query(func.count(Recipient.id)).filter(
            Recipient.default_category_id.is_(None)
        ).scalar() or 0

        return {
            'total_categories': int(total_categories),
            'categorized_transactions': int(categorized_transactions),
            'uncategorized_transactions': int(uncategorized_transactions),
            'categorized_recipients': int(categorized_recipients),
            'uncategorized_recipients': int(uncategorized_recipients)
        }

    def bulk_assign_category(
            self,
            recipient_ids: List[int],
            category_path: str
    ) -> Dict[str, int]:
        """
        Assign a category to multiple recipients at once
        """
        category = self.get_or_create_category(category_path)

        updated = 0
        for recipient_id in recipient_ids:
            recipient = self.recipient_repo.get_by_id(recipient_id)
            if recipient:
                recipient.default_category_id = category.id
                updated += 1

        self.db.commit()
        return {'updated': updated}
