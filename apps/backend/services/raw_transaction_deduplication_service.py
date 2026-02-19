"""Raw Transaction Deduplication Service.

Centralized service for handling raw transaction deduplication logic.
Works at the bank-specific raw table level to prevent duplicate imports.

This service replaces the old deduplication service which operated on
normalized Transaction records. Now deduplication happens at the source
level before normalized transactions are created.
"""
import hashlib

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from repositories.raw_transaction_repositories import (
    BelfiusRawTransactionRepository,
    RevolutRawTransactionRepository,
    KBCRawTransactionRepository
)

logger = setup_logging(__name__)


class RawTransactionDeduplicationService:
    """Service for managing raw transaction deduplication at source level."""

    def __init__(self, db_session: Session):
        """Initialise service with database session and repositories.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db = db_session
        self.belfius_repo = BelfiusRawTransactionRepository(db_session)
        self.revolut_repo = RevolutRawTransactionRepository(db_session)
        self.kbc_repo = KBCRawTransactionRepository(db_session)

    @staticmethod
    def compute_hash(raw_csv_line: str) -> str:
        """Compute SHA256 hash of raw CSV line for deduplication.

        This is the single source of truth for hash generation.
        Ensures consistent duplicate detection across all raw tables.

        Args:
            raw_csv_line: The complete raw CSV line as string

        Returns:
            SHA256 hash as hexadecimal string (64 characters)
        """
        return hashlib.sha256(raw_csv_line.encode('utf-8')).hexdigest()

    def is_duplicate_belfius(self, raw_csv_line: str) -> bool:
        """Check if Belfius raw transaction is a duplicate.

        Args:
            raw_csv_line: Raw CSV line to check

        Returns:
            True if duplicate exists, False otherwise
        """
        hash_value = self.compute_hash(raw_csv_line)
        return self.belfius_repo.exists_by_hash(hash_value)

    def is_duplicate_revolut(self, raw_csv_line: str) -> bool:
        """Check if Revolut raw transaction is a duplicate.

        Args:
            raw_csv_line: Raw CSV line to check

        Returns:
            True if duplicate exists, False otherwise
        """
        hash_value = self.compute_hash(raw_csv_line)
        return self.revolut_repo.exists_by_hash(hash_value)

    def is_duplicate_kbc(self, raw_csv_line: str) -> bool:
        """Check if KBC raw transaction is a duplicate.

        Args:
            raw_csv_line: Raw CSV line to check

        Returns:
            True if duplicate exists, False otherwise
        """
        hash_value = self.compute_hash(raw_csv_line)
        return self.kbc_repo.exists_by_hash(hash_value)

    def is_duplicate(self, bank_type: str, raw_csv_line: str) -> bool:
        """Generic duplicate check for any bank type.

        Args:
            bank_type: Bank identifier ('belfius', 'revolut', 'kbc')
            raw_csv_line: Raw CSV line to check

        Returns:
            True if duplicate exists, False otherwise

        Raises:
            ValueError: If bank_type is not supported
        """
        bank_type_lower = bank_type.lower()

        if bank_type_lower == 'belfius':
            return self.is_duplicate_belfius(raw_csv_line)
        elif bank_type_lower == 'revolut':
            return self.is_duplicate_revolut(raw_csv_line)
        elif bank_type_lower == 'kbc':
            return self.is_duplicate_kbc(raw_csv_line)
        else:
            raise ValueError(f"Unsupported bank type: {bank_type}")

    def get_hash(self, raw_csv_line: str) -> str:
        """Get the hash for a given raw CSV line.

        Convenience method for external callers.

        Args:
            raw_csv_line: Raw CSV line to hash

        Returns:
            SHA256 hash as hexadecimal string
        """
        return self.compute_hash(raw_csv_line)
