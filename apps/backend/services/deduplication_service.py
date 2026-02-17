"""
Deduplication Service

Centralized service for handling transaction deduplication logic.
Owns all responsibility for duplicate detection and hashing.
"""
import hashlib

from sqlalchemy.orm import Session

from repositories.transaction_repository import TransactionRepository
from services.bank_adapters import TransactionData


class DeduplicationService:
    """Service for managing transaction deduplication"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)

    @staticmethod
    def create_transaction_hash(transaction_data: TransactionData) -> str:
        """
        Create a unique hash for the transaction to detect exact duplicates.

        This is the single source of truth for hash generation.
        Ensures consistent duplicate detection across all layers.

        Args:
            transaction_data: The transaction data to hash

        Returns:
            SHA256 hash of the transaction
        """
        raw_data = transaction_data.raw_data
        if not raw_data:
            # Fallback: create hash from key fields if raw_data is not available
            hash_string = (
                f"{transaction_data.date.isoformat()}|"
                f"{transaction_data.amount}|"
                f"{transaction_data.recipient}|"
                f"{transaction_data.memo or ''}"
            )
            raw_data = hash_string

        return hashlib.sha256(raw_data.encode('utf-8')).hexdigest()

    def is_duplicate(self, transaction_hash: str) -> bool:
        """
        Check if a transaction with this exact hash already exists.

        Args:
            transaction_hash: The hash to check

        Returns:
            True if duplicate exists, False otherwise
        """
        existing = self.txn_repo.find_duplicate_by_bank_reference(transaction_hash)
        return existing is not None

    def is_duplicate_by_data(self, transaction_data: TransactionData) -> bool:
        """
        Check if a transaction (by data) is a duplicate.

        Args:
            transaction_data: The transaction data to check

        Returns:
            True if duplicate exists, False otherwise
        """
        transaction_hash = self.create_transaction_hash(transaction_data)
        return self.is_duplicate(transaction_hash)

    def get_hash_for_data(self, transaction_data: TransactionData) -> str:
        """
        Get the hash for a given transaction data.

        Args:
            transaction_data: The transaction data

        Returns:
            The hash for the transaction
        """
        return self.create_transaction_hash(transaction_data)
