"""Repositories for bank-specific raw transaction data access.

This module provides data access layer for raw transaction tables.
Each repository handles CRUD operations for its specific bank's raw data.

Design Principles:
- Read-heavy operations (no updates to raw data)
- Deduplication checks before insert
- Batch insertion support
- Query by import batch
- Hash-based lookups
"""

from datetime import date
from typing import List, Optional, Dict, Any

from sqlalchemy import desc
from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.raw_transaction_models import (
    BelfiusRawTransaction,
    RevolutRawTransaction,
    KBCRawTransaction
)

logger = setup_logging(__name__)


class BelfiusRawTransactionRepository:
    """Repository for Belfius raw transaction data access."""

    def __init__(self, db_session: Session):
        """Initialise repository with database session.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db = db_session

    def create(self, raw_data: Dict[str, Any]) -> BelfiusRawTransaction:
        """Create a new Belfius raw transaction record.

        Args:
            raw_data: Dictionary containing all raw transaction fields

        Returns:
            Created BelfiusRawTransaction instance
        """
        raw_txn = BelfiusRawTransaction(**raw_data)
        self.db.add(raw_txn)
        self.db.flush()  # Get ID without committing
        return raw_txn

    def find_by_hash(self, deduplication_hash: str) -> Optional[BelfiusRawTransaction]:
        """Find raw transaction by deduplication hash.

        Args:
            deduplication_hash: SHA256 hash of raw CSV line

        Returns:
            BelfiusRawTransaction if found, None otherwise
        """
        return self.db.query(BelfiusRawTransaction).filter(
            BelfiusRawTransaction.deduplication_hash == deduplication_hash
        ).first()

    def exists_by_hash(self, deduplication_hash: str) -> bool:
        """Check if raw transaction exists by hash.

        Args:
            deduplication_hash: SHA256 hash to check

        Returns:
            True if exists, False otherwise
        """
        return self.db.query(BelfiusRawTransaction.id).filter(
            BelfiusRawTransaction.deduplication_hash == deduplication_hash
        ).first() is not None

    def find_by_batch(self, batch_id: int) -> List[BelfiusRawTransaction]:
        """Get all raw transactions for a specific import batch.

        Args:
            batch_id: Import batch identifier

        Returns:
            List of BelfiusRawTransaction instances
        """
        return self.db.query(BelfiusRawTransaction).filter(
            BelfiusRawTransaction.import_batch_id == batch_id
        ).order_by(BelfiusRawTransaction.transaction_date, BelfiusRawTransaction.id).all()

    def find_by_account_and_date_range(
            self,
            account_number: str,
            start_date: date,
            end_date: date
    ) -> List[BelfiusRawTransaction]:
        """Get raw transactions for account within date range.

        Args:
            account_number: IBAN account number
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            List of BelfiusRawTransaction instances ordered by date
        """
        return self.db.query(BelfiusRawTransaction).filter(
            BelfiusRawTransaction.account_number == account_number,
            BelfiusRawTransaction.transaction_date >= start_date,
            BelfiusRawTransaction.transaction_date <= end_date
        ).order_by(BelfiusRawTransaction.transaction_date, BelfiusRawTransaction.id).all()

    def get_latest_balance(self, account_number: str) -> Optional[float]:
        """Get the most recent balance for an account.

        Args:
            account_number: IBAN account number

        Returns:
            Latest balance as float, or None if no transactions exist
        """
        latest = self.db.query(BelfiusRawTransaction).filter(
            BelfiusRawTransaction.account_number == account_number,
            BelfiusRawTransaction.balance.isnot(None)
        ).order_by(
            desc(BelfiusRawTransaction.transaction_date),
            desc(BelfiusRawTransaction.id)
        ).first()

        return float(latest.balance) if latest and latest.balance else None


class RevolutRawTransactionRepository:
    """Repository for Revolut raw transaction data access."""

    def __init__(self, db_session: Session):
        """Initialise repository with database session.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db = db_session

    def create(self, raw_data: Dict[str, Any]) -> RevolutRawTransaction:
        """Create a new Revolut raw transaction record.

        Args:
            raw_data: Dictionary containing all raw transaction fields

        Returns:
            Created RevolutRawTransaction instance
        """
        raw_txn = RevolutRawTransaction(**raw_data)
        self.db.add(raw_txn)
        self.db.flush()  # Get ID without committing
        return raw_txn

    def find_by_hash(self, deduplication_hash: str) -> Optional[RevolutRawTransaction]:
        """Find raw transaction by deduplication hash.

        Args:
            deduplication_hash: SHA256 hash of raw CSV line

        Returns:
            RevolutRawTransaction if found, None otherwise
        """
        return self.db.query(RevolutRawTransaction).filter(
            RevolutRawTransaction.deduplication_hash == deduplication_hash
        ).first()

    def exists_by_hash(self, deduplication_hash: str) -> bool:
        """Check if raw transaction exists by hash.

        Args:
            deduplication_hash: SHA256 hash to check

        Returns:
            True if exists, False otherwise
        """
        return self.db.query(RevolutRawTransaction.id).filter(
            RevolutRawTransaction.deduplication_hash == deduplication_hash
        ).first() is not None

    def find_by_batch(self, batch_id: int) -> List[RevolutRawTransaction]:
        """Get all raw transactions for a specific import batch.

        Args:
            batch_id: Import batch identifier

        Returns:
            List of RevolutRawTransaction instances
        """
        return self.db.query(RevolutRawTransaction).filter(
            RevolutRawTransaction.import_batch_id == batch_id
        ).order_by(RevolutRawTransaction.completed_date, RevolutRawTransaction.id).all()

    def find_by_product_and_date_range(
            self,
            product: str,
            start_date: date,
            end_date: date
    ) -> List[RevolutRawTransaction]:
        """Get raw transactions for product within date range.

        Args:
            product: Product type (e.g., 'Current', 'Savings')
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            List of RevolutRawTransaction instances ordered by date
        """
        return self.db.query(RevolutRawTransaction).filter(
            RevolutRawTransaction.product == product,
            RevolutRawTransaction.completed_date >= start_date,
            RevolutRawTransaction.completed_date <= end_date,
            RevolutRawTransaction.state == 'COMPLETED'
        ).order_by(RevolutRawTransaction.completed_date, RevolutRawTransaction.id).all()

    def get_latest_balance(self, product: str) -> Optional[float]:
        """Get the most recent balance for a product account.

        Args:
            product: Product type (e.g., 'Current', 'Savings')

        Returns:
            Latest balance as float, or None if no transactions exist
        """
        latest = self.db.query(RevolutRawTransaction).filter(
            RevolutRawTransaction.product == product,
            RevolutRawTransaction.state == 'COMPLETED',
            RevolutRawTransaction.balance.isnot(None)
        ).order_by(
            desc(RevolutRawTransaction.completed_date),
            desc(RevolutRawTransaction.id)
        ).first()

        return float(latest.balance) if latest and latest.balance else None


class KBCRawTransactionRepository:
    """Repository for KBC raw transaction data access."""

    def __init__(self, db_session: Session):
        """Initialise repository with database session.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db = db_session

    def create(self, raw_data: Dict[str, Any]) -> KBCRawTransaction:
        """Create a new KBC raw transaction record.

        Args:
            raw_data: Dictionary containing all raw transaction fields

        Returns:
            Created KBCRawTransaction instance
        """
        raw_txn = KBCRawTransaction(**raw_data)
        self.db.add(raw_txn)
        self.db.flush()  # Get ID without committing
        return raw_txn

    def find_by_hash(self, deduplication_hash: str) -> Optional[KBCRawTransaction]:
        """Find raw transaction by deduplication hash.

        Args:
            deduplication_hash: SHA256 hash of raw CSV line

        Returns:
            KBCRawTransaction if found, None otherwise
        """
        return self.db.query(KBCRawTransaction).filter(
            KBCRawTransaction.deduplication_hash == deduplication_hash
        ).first()

    def exists_by_hash(self, deduplication_hash: str) -> bool:
        """Check if raw transaction exists by hash.

        Args:
            deduplication_hash: SHA256 hash to check

        Returns:
            True if exists, False otherwise
        """
        return self.db.query(KBCRawTransaction.id).filter(
            KBCRawTransaction.deduplication_hash == deduplication_hash
        ).first() is not None

    def find_by_batch(self, batch_id: int) -> List[KBCRawTransaction]:
        """Get all raw transactions for a specific import batch.

        Args:
            batch_id: Import batch identifier

        Returns:
            List of KBCRawTransaction instances
        """
        return self.db.query(KBCRawTransaction).filter(
            KBCRawTransaction.import_batch_id == batch_id
        ).order_by(KBCRawTransaction.transaction_date, KBCRawTransaction.id).all()

    def find_by_account_and_date_range(
            self,
            account_number: str,
            start_date: date,
            end_date: date
    ) -> List[KBCRawTransaction]:
        """Get raw transactions for account within date range.

        Args:
            account_number: IBAN account number
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            List of KBCRawTransaction instances ordered by date
        """
        return self.db.query(KBCRawTransaction).filter(
            KBCRawTransaction.account_number == account_number,
            KBCRawTransaction.transaction_date >= start_date,
            KBCRawTransaction.transaction_date <= end_date
        ).order_by(KBCRawTransaction.transaction_date, KBCRawTransaction.id).all()

    def get_latest_balance(self, account_number: str) -> Optional[float]:
        """Get the most recent balance for an account.

        Args:
            account_number: IBAN account number

        Returns:
            Latest balance as float, or None if no transactions exist
        """
        latest = self.db.query(KBCRawTransaction).filter(
            KBCRawTransaction.account_number == account_number,
            KBCRawTransaction.balance.isnot(None)
        ).order_by(
            desc(KBCRawTransaction.transaction_date),
            desc(KBCRawTransaction.id)
        ).first()

        return float(latest.balance) if latest and latest.balance else None
