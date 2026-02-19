"""Raw Transaction Import Service.

This module provides the refactored import logic that stores transactions
in bank-specific raw tables first, then creates normalized Transaction records.

The new architecture:
1. Parse CSV using bank adapters
2. Store raw data in bank-specific tables (with deduplication)
3. Create normalized Transaction records linked to raw data
4. Maintain audit trail and referential integrity

This replaces the old TransactionImportService which mixed raw and normalized data.
"""
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional, Dict, Any

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Transaction, ImportBatch
from database.raw_transaction_models import TransactionRawReference
from repositories.import_batch_repository import ImportBatchRepository
from repositories.raw_transaction_repositories import (
    BelfiusRawTransactionRepository,
    RevolutRawTransactionRepository,
    KBCRawTransactionRepository
)
from repositories.transaction_repository import TransactionRepository
from services.bank_adapters import BankAdapterFactory, TransactionData
from services.raw_transaction_deduplication_service import RawTransactionDeduplicationService
from services.recipient_service import RecipientService

logger = setup_logging(__name__)


class RawTransactionImportService:
    """Service for importing transactions with raw data preservation.

    Handles the complete import flow:
    - CSV parsing via bank adapters
    - Raw transaction storage with deduplication
    - Normalized transaction creation
    - Raw-to-normalized linking
    - Import batch tracking
    """

    def __init__(self, db_session: Session):
        """Initialise the import service with required dependencies.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)
        self.batch_repo = ImportBatchRepository(db_session)
        self.belfius_raw_repo = BelfiusRawTransactionRepository(db_session)
        self.revolut_raw_repo = RevolutRawTransactionRepository(db_session)
        self.kbc_raw_repo = KBCRawTransactionRepository(db_session)
        self.dedup_service = RawTransactionDeduplicationService(db_session)
        self.recipient_service = RecipientService(db_session)

    def import_csv(
            self,
            file_path: str,
            bank_name: str,
            custom_config: Optional[Dict] = None,
            account_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """Import transactions from CSV with raw data preservation.

        New flow:
        1. Create import batch
        2. Parse CSV file
        3. For each transaction:
           a. Check for duplicate in raw table
           b. Store in bank-specific raw table
           c. Create normalized Transaction
           d. Link normalized to raw
        4. Update batch results

        Args:
            file_path: Path to CSV file
            bank_name: Bank identifier
            custom_config: Optional custom CSV configuration
            account_type: Optional account type override

        Returns:
            Import results dictionary with statistics
        """
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

        logger.info(
            "Starting raw transaction CSV import",
            extra={
                "operation": "import_csv",
                "batch_id": batch.id,
                "file_name": batch.filename,
                "bank_name": bank_name,
                "account_type": account_type
            }
        )

        try:
            # Get bank adapter
            if custom_config:
                adapter = BankAdapterFactory.create_adapter(bank_name, custom_config)
            else:
                adapter = BankAdapterFactory.create_adapter(bank_name)

            # Parse CSV file
            transaction_data_list = adapter.parse_csv(file_path, account_type=account_type)

            logger.info(
                f"Parsed CSV file successfully",
                extra={
                    "operation": "parse_csv",
                    "batch_id": batch.id,
                    "transactions_parsed": len(transaction_data_list)
                }
            )

            # Determine bank type for routing
            bank_type = self._determine_bank_type(bank_name)

            # Process transactions with new architecture
            results = self._process_transactions_with_raw_storage(
                transaction_data_list,
                batch.id,
                bank_type
            )

            # Update batch with results
            batch.total_processed = results['total_processed']
            batch.imported_count = results['imported']
            batch.duplicate_count = results['duplicates']
            batch.error_count = results['errors']
            batch.status = "completed" if results['errors'] == 0 else "completed_with_errors"
            batch.completed_at = datetime.now(timezone.utc)

            self.db.commit()

            logger.info(
                "CSV import completed successfully",
                extra={
                    "operation": "import_csv",
                    "batch_id": batch.id,
                    "status": batch.status,
                    "imported": results['imported'],
                    "duplicates": results['duplicates'],
                    "errors": results['errors']
                }
            )

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

            logger.error(
                "CSV import failed",
                extra={
                    "operation": "import_csv",
                    "batch_id": batch.id,
                    "error": str(e)
                },
                exc_info=True
            )

            return {
                'batch_id': batch.id,
                'total_processed': 0,
                'imported': 0,
                'duplicates': 0,
                'errors': 1,
                'status': 'failed',
                'error_message': str(e)
            }

    def _determine_bank_type(self, bank_name: str) -> str:
        """Determine bank type from bank name.

        Args:
            bank_name: Bank name from import

        Returns:
            Lowercase bank type ('belfius', 'revolut', 'kbc')
        """
        bank_lower = bank_name.lower().strip()

        if 'belfius' in bank_lower:
            return 'belfius'
        elif 'revolut' in bank_lower:
            return 'revolut'
        elif 'kbc' in bank_lower:
            return 'kbc'
        else:
            # Default to generic - will need handling
            logger.warning(f"Unknown bank type: {bank_name}, defaulting to generic")
            return 'generic'

    def _process_transactions_with_raw_storage(
            self,
            transaction_data_list: List[TransactionData],
            batch_id: int,
            bank_type: str
    ) -> Dict[str, int]:
        """Process transactions with raw table storage first.

        New architecture flow:
        1. Check duplicate in raw table
        2. Store in bank-specific raw table
        3. Create normalized Transaction
        4. Create TransactionRawReference link

        Args:
            transaction_data_list: Parsed transaction data
            batch_id: Import batch ID
            bank_type: Bank type for routing

        Returns:
            Processing statistics dictionary
        """
        results = {
            'total_processed': len(transaction_data_list),
            'imported': 0,
            'duplicates': 0,
            'errors': 0
        }

        logger.debug(
            f"Processing {len(transaction_data_list)} transactions with raw storage",
            extra={
                "operation": "process_transactions",
                "batch_id": batch_id,
                "bank_type": bank_type
            }
        )

        for transaction_data in transaction_data_list:
            try:
                # Step 1: Check for duplicate in raw table
                if self.dedup_service.is_duplicate(bank_type, transaction_data.raw_data):
                    results['duplicates'] += 1
                    logger.debug(f"Skipping duplicate transaction: {transaction_data.raw_data[:100]}")
                    continue

                # Step 2: Store in bank-specific raw table
                raw_txn = self._store_raw_transaction(
                    transaction_data,
                    batch_id,
                    bank_type
                )

                if not raw_txn:
                    results['errors'] += 1
                    continue

                # Step 3: Get or create recipient
                recipient, _ = self.recipient_service.create_or_get_recipient(
                    transaction_data.recipient,
                    transaction_data.recipient_account,
                    transaction_data.recipient_address
                )

                # Step 4: Create normalized Transaction
                transaction = Transaction(
                    date=transaction_data.date,
                    amount=Decimal(str(transaction_data.amount)),
                    currency=transaction_data.currency,
                    balance=Decimal(str(transaction_data.balance)) if transaction_data.balance is not None else None,
                    memo=transaction_data.memo or '',
                    comment=transaction_data.comment,
                    bank_account=transaction_data.bank_account,
                    recipient_id=recipient.id,
                    batch_id=batch_id
                )

                self.db.add(transaction)
                self.db.flush()  # Get transaction ID

                # Step 5: Create link between normalized and raw
                raw_ref = TransactionRawReference(
                    transaction_id=transaction.id,
                    raw_source_type=bank_type,
                    raw_source_id=raw_txn.id
                )

                self.db.add(raw_ref)
                results['imported'] += 1

            except Exception as e:
                logger.warning(
                    f"Error processing transaction: {str(e)}",
                    extra={
                        "operation": "process_transaction",
                        "batch_id": batch_id,
                        "bank_type": bank_type,
                        "error": str(e)
                    },
                    exc_info=True
                )
                results['errors'] += 1

        self.db.commit()

        logger.info(
            "Transaction processing completed",
            extra={
                "operation": "process_transactions",
                "batch_id": batch_id,
                "imported": results['imported'],
                "duplicates": results['duplicates'],
                "errors": results['errors']
            }
        )

        return results

    def _store_raw_transaction(
            self,
            transaction_data: TransactionData,
            batch_id: int,
            bank_type: str
    ):
        """Store transaction in bank-specific raw table.

        Args:
            transaction_data: Parsed transaction data
            batch_id: Import batch ID
            bank_type: Bank type for routing

        Returns:
            Created raw transaction instance or None on error
        """
        try:
            # Compute deduplication hash
            dedup_hash = self.dedup_service.get_hash(transaction_data.raw_data)

            # Route to appropriate raw table based on bank type
            if bank_type == 'belfius':
                return self._store_belfius_raw(transaction_data, batch_id, dedup_hash)
            elif bank_type == 'revolut':
                return self._store_revolut_raw(transaction_data, batch_id, dedup_hash)
            elif bank_type == 'kbc':
                return self._store_kbc_raw(transaction_data, batch_id, dedup_hash)
            else:
                logger.error(f"Unsupported bank type for raw storage: {bank_type}")
                return None

        except Exception as e:
            logger.error(
                f"Error storing raw transaction: {str(e)}",
                extra={"bank_type": bank_type, "error": str(e)},
                exc_info=True
            )
            return None

    def _store_belfius_raw(
            self,
            transaction_data: TransactionData,
            batch_id: int,
            dedup_hash: str
    ):
        """Store Belfius raw transaction.

        Args:
            transaction_data: Parsed transaction data
            batch_id: Import batch ID
            dedup_hash: Deduplication hash

        Returns:
            Created BelfiusRawTransaction instance
        """
        # Parse comment field for Belfius-specific data
        comment_data = self._parse_belfius_comment(transaction_data.comment)

        raw_data = {
            'import_batch_id': batch_id,
            'deduplication_hash': dedup_hash,
            'account_number': comment_data.get('account_number', ''),
            'transaction_date': transaction_data.date.date() if hasattr(transaction_data.date,
                                                                        'date') else transaction_data.date,
            'statement_number': comment_data.get('statement'),
            'transaction_number': comment_data.get('transaction'),
            'recipient_account': transaction_data.recipient_account,
            'recipient_name': transaction_data.recipient,
            'recipient_street': comment_data.get('street'),
            'recipient_location': comment_data.get('location'),
            'recipient_bic': comment_data.get('bic'),
            'recipient_country': comment_data.get('country'),
            'transaction_description': transaction_data.memo,
            'value_date': comment_data.get('value_date'),
            'amount': float(transaction_data.amount),
            'currency': transaction_data.currency or 'EUR',
            'balance': float(transaction_data.balance) if transaction_data.balance is not None else None,
            'additional_message': comment_data.get('additional'),
            'raw_csv_line': transaction_data.raw_data
        }

        return self.belfius_raw_repo.create(raw_data)

    def _store_revolut_raw(
            self,
            transaction_data: TransactionData,
            batch_id: int,
            dedup_hash: str
    ):
        """Store Revolut raw transaction.

        Args:
            transaction_data: Parsed transaction data
            batch_id: Import batch ID
            dedup_hash: Deduplication hash

        Returns:
            Created RevolutRawTransaction instance
        """
        # Parse comment field for Revolut-specific data
        comment_data = self._parse_revolut_comment(transaction_data.comment)

        raw_data = {
            'import_batch_id': batch_id,
            'deduplication_hash': dedup_hash,
            'transaction_type': comment_data.get('type', ''),
            'product': comment_data.get('product', ''),
            'started_date': comment_data.get('started_date'),
            'completed_date': transaction_data.date,
            'description': transaction_data.recipient,
            'amount': float(transaction_data.amount),
            'fee': comment_data.get('fee', 0.0),
            'currency': transaction_data.currency or 'EUR',
            'state': comment_data.get('state', 'COMPLETED'),
            'balance': float(transaction_data.balance) if transaction_data.balance is not None else None,
            'raw_csv_line': transaction_data.raw_data
        }

        return self.revolut_raw_repo.create(raw_data)

    def _store_kbc_raw(
            self,
            transaction_data: TransactionData,
            batch_id: int,
            dedup_hash: str
    ):
        """Store KBC raw transaction.

        Args:
            transaction_data: Parsed transaction data
            batch_id: Import batch ID
            dedup_hash: Deduplication hash

        Returns:
            Created KBCRawTransaction instance
        """
        # Parse comment field for KBC-specific data
        comment_data = self._parse_kbc_comment(transaction_data.comment)

        raw_data = {
            'import_batch_id': batch_id,
            'deduplication_hash': dedup_hash,
            'account_number': comment_data.get('account_number', ''),
            'category_name': comment_data.get('category'),
            'account_holder_name': comment_data.get('holder'),
            'currency': transaction_data.currency or 'EUR',
            'statement_number': comment_data.get('statement'),
            'transaction_date': transaction_data.date.date() if hasattr(transaction_data.date,
                                                                        'date') else transaction_data.date,
            'value_date': comment_data.get('value_date'),
            'description': transaction_data.memo,
            'amount': float(transaction_data.amount),
            'balance': float(transaction_data.balance) if transaction_data.balance is not None else None,
            'credit_amount': comment_data.get('credit_amount'),
            'debit_amount': comment_data.get('debit_amount'),
            'counterparty_account': transaction_data.recipient_account,
            'counterparty_bic': comment_data.get('bic'),
            'counterparty_name': transaction_data.recipient,
            'counterparty_address': transaction_data.recipient_address,
            'structured_communication': comment_data.get('structured'),
            'free_communication': comment_data.get('free'),
            'raw_csv_line': transaction_data.raw_data
        }

        return self.kbc_raw_repo.create(raw_data)

    def _parse_belfius_comment(self, comment: Optional[str]) -> Dict[str, Any]:
        """Parse Belfius comment field for structured data.

        Comment format: "Statement: X | Transaction: Y | Value Date: Z | BIC: A | Country: B | C"
        """
        result = {}
        if not comment:
            return result

        parts = comment.split(' | ')
        for part in parts:
            if ':' in part:
                key, value = part.split(':', 1)
                key = key.strip().lower()
                value = value.strip()

                if key == 'statement':
                    result['statement'] = value
                elif key == 'transaction':
                    result['transaction'] = value
                elif key == 'value date':
                    try:
                        result['value_date'] = datetime.strptime(value, '%d/%m/%Y').date()
                    except ValueError:
                        pass
                elif key == 'bic':
                    result['bic'] = value
                elif key == 'country':
                    result['country'] = value
            else:
                # Additional message without key
                result['additional'] = part.strip()

        return result

    def _parse_revolut_comment(self, comment: Optional[str]) -> Dict[str, Any]:
        """Parse Revolut comment field for structured data.

        Comment format: "Type: X | Product: Y | Fee: Z | Started: A | Processing Time: B | State: C"
        """
        result = {}
        if not comment:
            return result

        parts = comment.split(' | ')
        for part in parts:
            if ':' in part:
                key, value = part.split(':', 1)
                key = key.strip().lower()
                value = value.strip()

                if key == 'type':
                    result['type'] = value
                elif key == 'product':
                    result['product'] = value
                elif key == 'fee':
                    try:
                        fee_amount = value.split()[0]
                        result['fee'] = float(fee_amount)
                    except (ValueError, IndexError):
                        pass
                elif key == 'started':
                    try:
                        result['started_date'] = datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
                    except ValueError:
                        pass
                elif key == 'state':
                    result['state'] = value

        return result

    def _parse_kbc_comment(self, comment: Optional[str]) -> Dict[str, Any]:
        """Parse KBC comment field for structured data.

        Comment format: "Statement: X | Type: Y | Value Date: Z | BIC: A | Structured: B | Free: C"
        """
        result = {}
        if not comment:
            return result

        parts = comment.split(' | ')
        for part in parts:
            if ':' in part:
                key, value = part.split(':', 1)
                key = key.strip().lower()
                value = value.strip()

                if key == 'statement':
                    result['statement'] = value
                elif key == 'type':
                    if value == 'CREDIT':
                        result['credit_amount'] = None  # Will be filled from amount
                    elif value == 'DEBIT':
                        result['debit_amount'] = None  # Will be filled from amount
                elif key == 'value date':
                    try:
                        result['value_date'] = datetime.strptime(value, '%d/%m/%Y').date()
                    except ValueError:
                        pass
                elif key == 'bic':
                    result['bic'] = value
                elif key == 'structured':
                    result['structured'] = value
                elif key == 'free':
                    result['free'] = value

        return result
