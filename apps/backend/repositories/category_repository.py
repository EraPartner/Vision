"""
Category Repository

Centralizes all SQLAlchemy operations for categories.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from database.models import Category


class CategoryRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_all_active(self) -> List[Category]:
        """Get all active categories in flat list"""
        return self.db.query(Category).filter(Category.is_active == True).order_by(Category.general,
                                                                                   Category.detail).all()

    def get_by_id(self, category_id: int) -> Optional[Category]:
        """Get a category by ID"""
        return self.db.query(Category).filter(Category.id == category_id).first()

    def get_by_general_detail(self, general: str, detail: str) -> Optional[Category]:
        """Get a category by general and detail names"""
        return self.db.query(Category).filter(
            Category.general == general,
            Category.detail == detail
        ).first()

    def get_by_general(self, general: str) -> List[Category]:
        """Get all detail categories under a general category"""
        return self.db.query(Category).filter(Category.general == general, Category.is_active == True).order_by(
            Category.detail).all()

    def get_general_categories(self) -> List[Category]:
        """Get all general (parent) categories with no parent"""
        return self.db.query(Category).filter(
            Category.parent_id.is_(None),
            Category.is_active == True
        ).order_by(Category.general).all()

    def create(self, category: Category) -> Category:
        """Create a new category"""
        self.db.add(category)
        self.db.commit()
        self.db.refresh(category)
        return category

    def update(self, category: Category) -> Category:
        """Update an existing category"""
        self.db.commit()
        self.db.refresh(category)
        return category

    def soft_delete(self, category: Category) -> None:
        """Soft delete a category (mark as inactive)"""
        category.is_active = False
        self.db.commit()
