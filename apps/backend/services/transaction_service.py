import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional, Dict, Any

from sqlalchemy.orm import Session

from database.models import Transaction, Recipient, ImportBatch
from repositories.category_repository import CategoryRepository
from repositories.import_batch_repository import ImportBatchRepository
from repositories.transaction_repository import TransactionRepository
from services.bank_adapters import BankAdapterFactory, TransactionData
from services.deduplication_service import DeduplicationService
from services.recipient_service import RecipientService


def _create_transaction_hash(transaction_data: TransactionData) -> str:
    """Create a unique hash for the transaction to detect exact duplicates"""
    # Create a hash based on the raw CSV data to ensure exact duplicate detection
    raw_data = transaction_data.raw_data
    if not raw_data:
        # Fallback: create hash from key fields if raw_data is not available
        hash_string = f"{transaction_data.date.isoformat()}|{transaction_data.amount}|{transaction_data.recipient}|{transaction_data.memo or ''}"
        raw_data = hash_string

    return hashlib.sha256(raw_data.encode('utf-8')).hexdigest()


class TransactionImportService:
    """Service for importing and managing financial transactions"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)
        self.batch_repo = ImportBatchRepository(db_session)
        self.category_repo = CategoryRepository(db_session)
        # Inject dependencies for separated concerns
        self.dedup_service = DeduplicationService(db_session)
        self.recipient_service = RecipientService(db_session)

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
                # Check for duplicates using dedicated deduplication service
                if self.dedup_service.is_duplicate_by_data(transaction_data):
                    results['duplicates'] += 1
                    continue

                # Get or create recipient using dedicated recipient service
                recipient = self.recipient_service.get_or_create_recipient(
                    transaction_data.recipient,
                    transaction_data.recipient_account
                )

                # Create transaction
                transaction = Transaction(
                    date=transaction_data.date,
                    amount=Decimal(str(transaction_data.amount)),
                    currency=transaction_data.currency,
                    balance=Decimal(str(transaction_data.balance)) if transaction_data.balance is not None else None,
                    memo=transaction_data.memo or '',
                    comment=transaction_data.comment,
                    bank_account=transaction_data.bank_account,
                    recipient_id=recipient.id,
                    batch_id=batch_id,
                    original_raw_data=transaction_data.raw_data,
                    bank_reference=self.dedup_service.get_hash_for_data(transaction_data)
                )

                self.db.add(transaction)
                results['imported'] += 1

            except Exception as e:
                print(f"Error processing transaction: {e}")
                results['errors'] += 1

        self.db.commit()
        return results

    def get_recipients_with_account_numbers(self) -> List[Recipient]:
        """Get all recipients that have account numbers"""
        return self.recipient_service.get_with_account_numbers()

    def update_recipient_category(self, recipient_id: int, category_id: Optional[int]) -> bool:
        """Update the default category for a recipient"""
        return self.recipient_service.update_category(recipient_id, category_id)
