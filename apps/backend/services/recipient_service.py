"""
Recipient Service

Centralized service for all recipient operations.
This is the single Information Expert for recipient management.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from database.models import Recipient
from repositories.recipient_repository import RecipientRepository


class RecipientService:
    """Service for managing recipients and their properties"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.recipient_repo = RecipientRepository(db_session)

    # Basic CRUD
    def create(self, name: str, account_number: Optional[str] = None) -> Recipient:
        """Create a new recipient"""
        if not name or not name.strip():
            raise ValueError("Recipient name is required")
        recipient = Recipient(name=name.strip(), account_number=account_number, is_active=True)
        return self.recipient_repo.create(recipient)

    def get_by_id(self, recipient_id: int) -> Optional[Recipient]:
        """Get recipient by ID"""
        return self.recipient_repo.get_by_id(recipient_id)

    def get_by_name(self, name: str) -> Optional[Recipient]:
        """Get recipient by name"""
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
            is_active: Optional[bool] = None,
    ) -> Optional[Recipient]:
        """Update recipient fields (supports partial updates)"""
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            return None
        if name is not None:
            recipient.name = name.strip() if name else recipient.name
        if account_number is not None:
            recipient.account_number = account_number
        if default_category_id is not None or default_category_id is None:
            recipient.default_category_id = default_category_id
        if notes is not None or notes is None:
            recipient.notes = notes
        if is_active is not None:
            recipient.is_active = is_active
        return self.recipient_repo.update(recipient)

    def delete(self, recipient_id: int) -> bool:
        """Soft delete (or hard delete if repo enforces) a recipient"""
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            return False
        # If soft delete is preferred, set is_active=False; otherwise use repo.delete
        # Here we choose hard delete via repository to match existing pattern.
        self.recipient_repo.delete(recipient)
        return True

    def get_all(self) -> List[Recipient]:
        """Get all recipients"""
        return self.recipient_repo.get_all()

    # Import-related helpers
    def get_or_create_recipient(
            self,
            name: str,
            account_number: Optional[str] = None
    ) -> Recipient:
        """
        Get existing recipient or create a new one.
        Updates missing account number if provided.
        """
        recipient = self.recipient_repo.get_by_name(name)
        if recipient:
            if account_number and not recipient.account_number:
                recipient.account_number = account_number
                recipient = self.recipient_repo.update(recipient)
            return recipient
        return self.create(name=name, account_number=account_number)

    def get_with_account_numbers(self) -> List[Recipient]:
        """Get all recipients that have account numbers"""
        return self.db.query(Recipient).filter(Recipient.account_number.isnot(None)).all()

    def update_category(self, recipient_id: int, category_id: Optional[int]) -> bool:
        """Update the default category for a recipient"""
        recipient = self.recipient_repo.get_by_id(recipient_id)
        if not recipient:
            return False
        recipient.default_category_id = category_id
        self.recipient_repo.update(recipient)
        return True
