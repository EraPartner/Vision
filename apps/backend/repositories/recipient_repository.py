"""
Recipient Repository

Centralizes all SQLAlchemy operations for recipients.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from database.models import Recipient


class RecipientRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_all(self, search: Optional[str] = None, with_accounts: bool = False) -> List[Recipient]:
        query = self.db.query(Recipient).filter(Recipient.is_active == True)
        if search:
            query = query.filter(Recipient.name.ilike(f"%{search}%"))
        if with_accounts:
            query = query.filter(Recipient.account_number.isnot(None))
        return query.all()

    def get_by_id(self, recipient_id: int) -> Optional[Recipient]:
        return self.db.query(Recipient).filter(Recipient.id == recipient_id).first()

    def get_by_name(self, name: str) -> Optional[Recipient]:
        return self.db.query(Recipient).filter(Recipient.name == name).first()

    def create(self, recipient: Recipient) -> Recipient:
        self.db.add(recipient)
        self.db.commit()
        self.db.refresh(recipient)
        return recipient

    def update(self, recipient: Recipient) -> Recipient:
        self.db.commit()
        self.db.refresh(recipient)
        return recipient

    def soft_delete(self, recipient: Recipient) -> None:
        recipient.is_active = False
        self.db.commit()

    def get_uncategorized(self) -> List[Recipient]:
        return self.db.query(Recipient).filter(
            Recipient.default_category_id.is_(None),
            Recipient.is_active == True
        ).all()

    def find_similar_with_category(self, name_substring: str, limit: int = 5) -> List[Recipient]:
        return self.db.query(Recipient).filter(
            Recipient.name.ilike(f"%{name_substring}%"),
            Recipient.default_category_id.isnot(None)
        ).limit(limit).all()

    def find_similar_without_category(self, name_substring: str, limit: int = 5) -> List[Recipient]:
        return self.db.query(Recipient).filter(
            Recipient.name.ilike(f"%{name_substring}%"),
            Recipient.default_category_id.is_(None)
        ).limit(limit).all()

    def list_for_export(self, include_uncategorized: bool = False) -> List[Recipient]:
        query = self.db.query(Recipient)
        if not include_uncategorized:
            query = query.filter(Recipient.default_category_id.isnot(None))
        return query.order_by(Recipient.name).all()
