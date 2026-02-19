"""Recipient Bank Account Service module.

This module provides high-level business logic for managing recipient bank accounts.
It uses the repository pattern to abstract database operations and enforces business rules
for bank account management.

The service layer is responsible for:
- Bank account CRUD operations with validation
- Managing the relationship between recipients and their accounts
- Setting primary accounts
- Handling bank account metadata (bank name, labels, addresses)

Classes:
    RecipientBankAccountService: Main service class for bank account management.
"""
from typing import Optional, List

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import RecipientBankAccount
from repositories.recipient_bank_account_repository import RecipientBankAccountRepository

# Setup logging
logger = setup_logging(__name__)


class RecipientBankAccountService:
    """Service for managing recipient bank accounts.

    Provides high-level business logic for bank account operations, coordinating
    between repositories and enforcing business rules. This service layer separates
    business logic from data access, making the code more testable and maintainable.

    The service handles:
    - Getting, creating, updating, and deleting bank accounts
    - Managing primary account designation
    - Linking bank accounts to recipients
    - Enriching existing accounts with additional metadata

    Attributes:
        bank_account_repo (RecipientBankAccountRepository): Repository for bank account data access.

    Example:
        service = RecipientBankAccountService(db_session)
        account = service.create_or_get_bank_account(
            recipient_id=1,
            account_number="BE61734041478017",
            bank_name="BELFIUS"
        )
    """

    def __init__(self, db_session: Session):
        self.bank_account_repo = RecipientBankAccountRepository(db_session)

    def create_or_get_bank_account(
            self,
            recipient_id: int,
            account_number: str,
            bank_name: Optional[str] = None,
            address: Optional[str] = None,
            account_label: Optional[str] = None,
            set_as_primary: bool = False
    ) -> tuple[RecipientBankAccount, bool]:
        """Create a new bank account or return existing one, enriching with metadata.

        If the account number already exists, the existing account is returned and
        optionally enriched with any missing metadata (bank name, address, label).

        Args:
            recipient_id (int): The recipient's unique identifier.
            account_number (str): The bank account number (will be normalized).
            bank_name (Optional[str]): Name of the bank (e.g., "BELFIUS", "KBC").
            address (Optional[str]): Physical address associated with this account.
            account_label (Optional[str]): User-friendly label (e.g., "Personal Checking").
            set_as_primary (bool): Whether to set this as the primary account.

        Returns:
            tuple[RecipientBankAccount, bool]: A tuple containing:
                - RecipientBankAccount object (found or created)
                - Boolean indicating if newly created (True) or already existed (False)

        Example:
            # Create new bank account
            account, created = service.create_or_get_bank_account(
                recipient_id=1,
                account_number="BE61734041478017",
                bank_name="BELFIUS",
                set_as_primary=True
            )
            print(created)  # True

            # Get existing account (idempotent)
            account2, created2 = service.create_or_get_bank_account(
                recipient_id=1,
                account_number="BE61734041478017",
                bank_name="BELFIUS"
            )
            assert account.id == account2.id
            print(created2)  # False
        """
        if not account_number:
            raise ValueError("Account number is required")

        # Try to find existing account by account number
        existing_account = self.bank_account_repo.get_by_account_number(account_number)

        if existing_account:
            # Enrich existing account with missing metadata
            updated = False

            # Update bank name if missing
            if bank_name and not existing_account.bank_name:
                logger.info(
                    "Adding bank name to existing account",
                    extra={
                        "operation": "enrich_bank_account",
                        "resource_type": "recipient_bank_account",
                        "resource_id": existing_account.id,
                        "bank_name": bank_name
                    }
                )
                existing_account.bank_name = bank_name
                updated = True

            # Update address if provided and different
            if address:
                from services.text_normalization_service import TextNormalizationService
                normalized_new_address = TextNormalizationService.normalize_recipient_name(address)
                normalized_current_address = existing_account.address if existing_account.address else None

                if normalized_current_address != normalized_new_address:
                    logger.info(
                        "Updating bank account address",
                        extra={
                            "operation": "enrich_bank_account",
                            "resource_type": "recipient_bank_account",
                            "resource_id": existing_account.id,
                            "old_address": existing_account.address,
                            "new_address": address
                        }
                    )
                    existing_account.address = address
                    updated = True

            # Update account label if missing
            if account_label and not existing_account.account_label:
                existing_account.account_label = account_label
                updated = True

            # Update primary status if requested
            if set_as_primary and not existing_account.is_primary:
                self.bank_account_repo.set_primary(existing_account.id, existing_account.recipient_id)
                updated = True

            if updated:
                self.bank_account_repo.update(existing_account)

            return existing_account, False

        # Create new bank account
        # Check if this should be the primary (first account for recipient)
        existing_accounts = self.bank_account_repo.get_by_recipient_id(recipient_id)
        is_first_account = len(existing_accounts) == 0

        bank_account = RecipientBankAccount(
            recipient_id=recipient_id,
            account_number=account_number,
            bank_name=bank_name,
            address=address,
            account_label=account_label,
            is_primary=set_as_primary or is_first_account,  # First account is auto-primary
            is_active=True
        )
        created_account = self.bank_account_repo.create(bank_account)

        # If setting as primary, ensure no other accounts are primary
        if created_account.is_primary and not is_first_account:
            self.bank_account_repo.set_primary(created_account.id, recipient_id)

        logger.info(
            "Created new bank account",
            extra={
                "operation": "create_bank_account",
                "resource_type": "recipient_bank_account",
                "resource_id": created_account.id,
                "recipient_id": recipient_id,
                "account_number": account_number,
                "is_primary": created_account.is_primary
            }
        )
        return created_account, True

    def get_by_account_number(self, account_number: str) -> Optional[RecipientBankAccount]:
        """Get a bank account by account number.

        Args:
            account_number (str): The account number to search for.

        Returns:
            Optional[RecipientBankAccount]: The bank account if found, None otherwise.
        """
        return self.bank_account_repo.get_by_account_number(account_number)

    def get_by_recipient_id(self, recipient_id: int, active_only: bool = True) -> List[RecipientBankAccount]:
        """Get all bank accounts for a specific recipient.

        Args:
            recipient_id (int): The recipient's unique identifier.
            active_only (bool): If True, only return active accounts. Default True.

        Returns:
            List[RecipientBankAccount]: List of bank accounts for the recipient.
        """
        return self.bank_account_repo.get_by_recipient_id(recipient_id, active_only)

    def get_primary_account(self, recipient_id: int) -> Optional[RecipientBankAccount]:
        """Get the primary bank account for a recipient.

        Args:
            recipient_id (int): The recipient's unique identifier.

        Returns:
            Optional[RecipientBankAccount]: The primary bank account if exists, None otherwise.
        """
        return self.bank_account_repo.get_primary_account(recipient_id)

    def set_primary(self, bank_account_id: int, recipient_id: int) -> bool:
        """Set a bank account as primary for a recipient.

        Args:
            bank_account_id (int): The ID of the bank account to set as primary.
            recipient_id (int): The recipient's ID (for validation).

        Returns:
            bool: True if successful, False if bank account not found.
        """
        return self.bank_account_repo.set_primary(bank_account_id, recipient_id)

    def update_label(self, bank_account_id: int, label: str) -> bool:
        """Update the label for a bank account.

        Args:
            bank_account_id (int): The ID of the bank account to update.
            label (str): The new label for the account.

        Returns:
            bool: True if successful, False if bank account not found.
        """
        bank_account = self.bank_account_repo.get_by_id(bank_account_id)
        if not bank_account:
            return False

        bank_account.account_label = label
        self.bank_account_repo.update(bank_account)
        return True

    def deactivate(self, bank_account_id: int) -> bool:
        """Deactivate a bank account (soft delete).

        Args:
            bank_account_id (int): The ID of the bank account to deactivate.

        Returns:
            bool: True if successful, False if bank account not found.
        """
        return self.bank_account_repo.delete(bank_account_id)
