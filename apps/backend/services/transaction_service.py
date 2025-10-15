import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional, Dict, Any

import pandas as pd
from sqlalchemy import and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database.models import Transaction, Recipient, ImportBatch
from services.bank_adapters import BankAdapterFactory, TransactionData


class TransactionImportService:
    """Service for importing and managing financial transactions"""

    def __init__(self, db_session: Session):
        self.db = db_session

    def import_csv(
            self,
            file_path: str,
            bank_name: str,
            custom_config: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """Import transactions from CSV file"""

        # Create import batch record
        batch = ImportBatch(
            filename=file_path.split('/')[-1],
            bank_name=bank_name,
            config_used=json.dumps(custom_config) if custom_config else None,
            status="processing"
        )
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)

        try:
            # Get bank adapter
            if custom_config:
                adapter = BankAdapterFactory.create_adapter(bank_name, custom_config)
            else:
                adapter = BankAdapterFactory.create_adapter(bank_name)

            # Parse CSV file using the adapter
            transaction_data_list = adapter.parse_csv(file_path)

            # Process transactions
            results = self._process_transactions(transaction_data_list, batch.id)

            # Update batch with results
            batch.total_processed = results['total_processed']
            batch.imported_count = results['imported']
            batch.duplicate_count = results['duplicates']
            batch.error_count = results['errors']
            batch.status = "completed" if results['errors'] == 0 else "completed_with_errors"
            batch.completed_at = datetime.now(timezone.utc)

            self.db.commit()

            return {
                'batch_id': batch.id,
                'total_processed': results['total_processed'],
                'imported': results['imported'],
                'duplicates': results['duplicates'],
                'errors': results['errors'],
                'status': batch.status
            }

        except Exception as e:
            # Update batch with error
            batch.status = "failed"
            batch.error_message = str(e)
            batch.completed_at = datetime.now(timezone.utc)
            self.db.commit()

            return {
                'batch_id': batch.id,
                'total_processed': 0,
                'imported': 0,
                'duplicates': 0,
                'errors': 1,
                'status': 'failed',
                'error_message': str(e)
            }

    def _process_transactions(self, transaction_data_list: List[TransactionData], batch_id: int) -> Dict[str, int]:
        """Process TransactionData objects into Transaction records"""
        results = {
            'total_processed': len(transaction_data_list),
            'imported': 0,
            'duplicates': 0,
            'errors': 0
        }

        for transaction_data in transaction_data_list:
            try:
                # Create hash for duplicate detection
                transaction_hash = self._create_transaction_hash(transaction_data)

                # Check for exact duplicates using hash
                if self._is_duplicate_transaction(transaction_hash):
                    results['duplicates'] += 1
                    continue

                # Get or create recipient (with account number if available)
                recipient = self._get_or_create_recipient(
                    transaction_data.recipient,
                    transaction_data.recipient_account
                )

                # Create transaction
                transaction = Transaction(
                    date=transaction_data.date,
                    amount=Decimal(str(transaction_data.amount)),
                    memo=transaction_data.memo or '',
                    comment=transaction_data.comment,
                    bank_account=transaction_data.bank_account,  # Store the bank/account name
                    recipient_id=recipient.id,  # Set the recipient_id
                    batch_id=batch_id,
                    original_raw_data=transaction_data.raw_data,
                    bank_reference=self._generate_bank_reference(transaction_data)
                )

                self.db.add(transaction)
                results['imported'] += 1

            except Exception as e:
                print(f"Error processing transaction: {e}")
                results['errors'] += 1

        self.db.commit()
        return results

    def _create_transaction_hash(self, transaction_data: TransactionData) -> str:
        """Create a unique hash for the transaction to detect exact duplicates"""
        # Create a hash based on the raw CSV data to ensure exact duplicate detection
        raw_data = transaction_data.raw_data
        if not raw_data:
            # Fallback: create hash from key fields if raw_data is not available
            hash_string = f"{transaction_data.date.isoformat()}|{transaction_data.amount}|{transaction_data.recipient}|{transaction_data.memo or ''}"
            raw_data = hash_string

        return hashlib.sha256(raw_data.encode('utf-8')).hexdigest()

    def _is_duplicate_transaction(self, transaction_hash: str) -> bool:
        """Check if a transaction with this exact hash already exists"""
        # For now, we'll store the hash in the bank_reference field
        # In a production system, you might want a separate hash field
        existing = self.db.query(Transaction).filter(
            Transaction.bank_reference == transaction_hash
        ).first()

        return existing is not None

    def _get_or_create_recipient(self, name: str, account_number: Optional[str] = None) -> Recipient:
        """Get existing recipient or create a new one with account number"""
        # First, try to find by exact name match
        recipient = self.db.query(Recipient).filter(Recipient.name == name).first()

        if recipient:
            # Update account number if provided and not already set
            if account_number and not recipient.account_number:
                recipient.account_number = account_number
                self.db.commit()
            return recipient

        # Create new recipient
        recipient = Recipient(
            name=name,
            account_number=account_number,
            is_active=True
        )
        self.db.add(recipient)
        self.db.commit()
        self.db.refresh(recipient)

        return recipient

    def _generate_bank_reference(self, transaction_data: TransactionData) -> str:
        """Generate a bank reference/hash for the transaction"""
        return self._create_transaction_hash(transaction_data)

    def get_recipients_with_account_numbers(self) -> List[Recipient]:
        """Get all recipients that have account numbers"""
        return self.db.query(Recipient).filter(
            Recipient.account_number.isnot(None)
        ).all()

    def update_recipient_category(self, recipient_id: int, category_id: Optional[int]) -> bool:
        """Update the default category for a recipient (for future use)"""
        recipient = self.db.query(Recipient).filter(Recipient.id == recipient_id).first()
        if recipient:
            recipient.default_category_id = category_id
            self.db.commit()
            return True
        return False

    def get_transactions(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None,
            category_id: Optional[int] = None,
            limit: int = 100,
            offset: int = 0
    ) -> List[Transaction]:
        """Get transactions with optional filters"""

        query = self.db.query(Transaction)

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        if category_id:
            query = query.filter(Transaction.category_id == category_id)

        return query.order_by(Transaction.date.desc()).offset(offset).limit(limit).all()

    def get_transaction_summary(
            self,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """Get summary statistics for transactions"""

        query = self.db.query(Transaction)

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        transactions = query.all()

        if not transactions:
            return {
                "total_transactions": 0,
                "total_amount": 0,
                "average_amount": 0,
                "date_range": None
            }

        amounts = [float(t.amount) for t in transactions]
        dates = [t.date for t in transactions]

        return {
            "total_transactions": len(transactions),
            "total_amount": sum(amounts),
            "average_amount": sum(amounts) / len(amounts),
            "min_amount": min(amounts),
            "max_amount": max(amounts),
            "date_range": {
                "start": min(dates),
                "end": max(dates)
            }
        }

    def update_transaction_category(self, transaction_id: int, category_id: int) -> bool:
        """Update category for a transaction"""
        transaction = self.db.query(Transaction).filter(Transaction.id == transaction_id).first()

        if not transaction:
            return False

        transaction.category_id = category_id
        transaction.updated_at = datetime.now(timezone.utc)

        try:
            self.db.commit()
            return True
        except Exception:
            self.db.rollback()
            return False
