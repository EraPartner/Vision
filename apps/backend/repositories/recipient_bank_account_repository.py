"""Recipient Bank Account Repository module.

This module centralises all SQLAlchemy database operations for recipient bank accounts.
It provides a clean interface for CRUD operations and bank account queries without
exposing raw SQL or ORM implementation details to the rest of the application.

The repository pattern separates data access logic from business logic, making
the code more testable and maintainable. This is particularly important for
financial applications where data integrity and audit trails are critical.

Classes:
    RecipientBankAccountRepository: Main repository class for recipient bank account data access.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import RecipientBankAccount

# Setup logging
logger = setup_logging(__name__)


class RecipientBankAccountRepository:
    """Repository for recipient bank account data access and manipulation.

    Provides a clean interface for all database operations related to recipient bank accounts,
    including querying, creating, updating, and deleting bank account records.

    This repository manages the many-to-many relationship between recipients and their
    bank accounts, ensuring that the same person/entity can have multiple accounts
    across different banks.

    Attributes:
        db (Session): SQLAlchemy database session for executing queries.

    Example:
        repo = RecipientBankAccountRepository(db_session)
        bank_account = repo.get_by_account_number("BE61734041478017")
        all_accounts = repo.get_by_recipient_id(recipient_id=1)
    """

    def __init__(self, db: Session):
        """Initialise the repository with a database session.

        Args:
            db (Session): SQLAlchemy database session for executing queries.
        """
        self.db = db

    def get_by_id(self, bank_account_id: int) -> Optional[RecipientBankAccount]:
        """Get a bank account by its primary key ID.

        Args:
            bank_account_id (int): The unique identifier of the bank account.

        Returns:
            Optional[RecipientBankAccount]: The bank account if found, None otherwise.
        """
        result = self.db.query(RecipientBankAccount).filter(
            RecipientBankAccount.id == bank_account_id
        ).first()

        if result:
            logger.debug(
                "Retrieved bank account by ID",
                extra={
                    "operation": "get_by_id",
                    "resource_type": "recipient_bank_account",
                    "resource_id": bank_account_id
                }
            )
        return result

    def get_by_account_number(self, account_number: str) -> Optional[RecipientBankAccount]:
        """Get a bank account by its account number.

        Account numbers are unique across the system, so this returns at most one result.

        Args:
            account_number (str): The account number to search for.

        Returns:
            Optional[RecipientBankAccount]: The bank account if found, None otherwise.
        """
        if not account_number:
            return None

        result = self.db.query(RecipientBankAccount).filter(
            RecipientBankAccount.account_number == account_number.strip().upper()
        ).first()

        if result:
            logger.debug(
                "Retrieved bank account by account number",
                extra={
                    "operation": "get_by_account_number",
                    "resource_type": "recipient_bank_account",
                    "resource_id": result.id,
                    "account_number": account_number
                }
            )
        return result

    def get_by_recipient_id(self, recipient_id: int, active_only: bool = True) -> List[RecipientBankAccount]:
        """Get all bank accounts for a specific recipient.

        Args:
            recipient_id (int): The recipient's unique identifier.
            active_only (bool): If True, only return active accounts. Default True.

        Returns:
            List[RecipientBankAccount]: List of bank accounts for the recipient.
        """
        query = self.db.query(RecipientBankAccount).filter(
            RecipientBankAccount.recipient_id == recipient_id
        )

        if active_only:
            query = query.filter(RecipientBankAccount.is_active == True)

        results = query.order_by(
            RecipientBankAccount.is_primary.desc(),
            RecipientBankAccount.created_at
        ).all()

        logger.debug(
            "Retrieved bank accounts for recipient",
            extra={
                "operation": "get_by_recipient_id",
                "resource_type": "recipient_bank_account",
                "recipient_id": recipient_id,
                "count": len(results),
                "active_only": active_only
            }
        )
        return results

    def get_primary_account(self, recipient_id: int) -> Optional[RecipientBankAccount]:
        """Get the primary bank account for a recipient.

        Args:
            recipient_id (int): The recipient's unique identifier.

        Returns:
            Optional[RecipientBankAccount]: The primary bank account if one exists, None otherwise.
        """
        result = self.db.query(RecipientBankAccount).filter(
            RecipientBankAccount.recipient_id == recipient_id,
            RecipientBankAccount.is_primary == True,
            RecipientBankAccount.is_active == True
        ).first()

        return result

    def create(self, bank_account: RecipientBankAccount) -> RecipientBankAccount:
        """Create a new bank account record.

        Args:
            bank_account (RecipientBankAccount): The bank account object to create.

        Returns:
            RecipientBankAccount: The created bank account with ID populated.
        """
        self.db.add(bank_account)
        self.db.commit()
        self.db.refresh(bank_account)

        logger.info(
            "Created new bank account",
            extra={
                "operation": "create",
                "resource_type": "recipient_bank_account",
                "resource_id": bank_account.id,
                "recipient_id": bank_account.recipient_id,
                "account_number": bank_account.account_number
            }
        )
        return bank_account

    def update(self, bank_account: RecipientBankAccount) -> RecipientBankAccount:
        """Update an existing bank account record.

        Args:
            bank_account (RecipientBankAccount): The bank account object with updated fields.

        Returns:
            RecipientBankAccount: The updated bank account.
        """
        self.db.commit()
        self.db.refresh(bank_account)

        logger.info(
            "Updated bank account",
            extra={
                "operation": "update",
                "resource_type": "recipient_bank_account",
                "resource_id": bank_account.id,
                "recipient_id": bank_account.recipient_id
            }
        )
        return bank_account

    def delete(self, bank_account_id: int) -> bool:
        """Soft delete a bank account by marking it as inactive.

        Args:
            bank_account_id (int): The ID of the bank account to delete.

        Returns:
            bool: True if deleted successfully, False if not found.
        """
        bank_account = self.get_by_id(bank_account_id)
        if not bank_account:
            return False

        bank_account.is_active = False
        self.db.commit()

        logger.info(
            "Soft deleted bank account",
            extra={
                "operation": "delete",
                "resource_type": "recipient_bank_account",
                "resource_id": bank_account_id
            }
        )
        return True

    def set_primary(self, bank_account_id: int, recipient_id: int) -> bool:
        """Set a bank account as primary for a recipient.

        Unsets any existing primary account for the recipient first.

        Args:
            bank_account_id (int): The ID of the bank account to set as primary.
            recipient_id (int): The recipient's ID (for validation).

        Returns:
            bool: True if successful, False if bank account not found.
        """
        # First, unset any existing primary for this recipient
        self.db.query(RecipientBankAccount).filter(
            RecipientBankAccount.recipient_id == recipient_id,
            RecipientBankAccount.is_primary == True
        ).update({"is_primary": False})

        # Set the new primary
        bank_account = self.get_by_id(bank_account_id)
        if not bank_account or bank_account.recipient_id != recipient_id:
            return False

        bank_account.is_primary = True
        self.db.commit()

        logger.info(
            "Set primary bank account",
            extra={
                "operation": "set_primary",
                "resource_type": "recipient_bank_account",
                "resource_id": bank_account_id,
                "recipient_id": recipient_id
            }
        )
        return True
