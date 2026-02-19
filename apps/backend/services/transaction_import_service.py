"""Transaction Import Service module.

This module provides high-level business logic for importing financial transactions
from various sources (CSV files, etc.). It orchestrates the import process by
coordinating between multiple services and repositories to parse, validate,
deduplicate, and persist transaction data.

The service layer is responsible for:
- CSV file import with bank-specific adapters
- Transaction parsing and validation
- Duplicate detection and handling
- Recipient creation and association
- Import batch tracking and reporting
- Error handling and recovery

Classes:
    TransactionImportService: Main service class for transaction import operations.
"""
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional, Dict, Any

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Transaction, Recipient, ImportBatch
from repositories.category_repository import CategoryRepository
from repositories.import_batch_repository import ImportBatchRepository
from repositories.transaction_repository import TransactionRepository
from services.bank_adapters import BankAdapterFactory, TransactionData
from services.deduplication_service import DeduplicationService
from services.recipient_service import RecipientService

logger = setup_logging(__name__)


class TransactionImportService:
    """Service for importing and managing financial transactions.

    Provides high-level business logic for importing transactions from various sources,
    with support for multiple bank formats and custom CSV configurations. Coordinates
    between multiple services and repositories to ensure data integrity, deduplication,
    and proper tracking of import operations.

    The service handles:
    - CSV file parsing using bank-specific adapters
    - Transaction validation and normalisation
    - Duplicate detection using hash-based deduplication
    - Automatic recipient creation and linking
    - Import batch creation and status tracking
    - Comprehensive error handling and reporting

    Attributes:
        db (Session): SQLAlchemy database session.
        txn_repo (TransactionRepository): Repository for transaction data access.
        batch_repo (ImportBatchRepository): Repository for import batch tracking.
        category_repo (CategoryRepository): Repository for category data access.
        dedup_service (DeduplicationService): Service for duplicate detection.
        recipient_service (RecipientService): Service for recipient management.

    Example:
        service = TransactionImportService(db_session)

        # Import with predefined bank adapter
        result = service.import_csv("transactions.csv", "Chase")
        print(f"Imported {result['imported']} transactions")

        # Import with custom configuration
        custom_config = {
            "date_format": "%d/%m/%Y",
            "date_column": "Transaction Date",
            "amount_column": "Amount"
        }
        result = service.import_csv("custom.csv", "CustomBank", custom_config)
    """

    def __init__(self, db_session: Session):
        """Initialise the transaction import service with required dependencies.

        Args:
            db_session (Session): SQLAlchemy database session for executing queries.
        """
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
            custom_config: Optional[Dict] = None,
            account_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """Import transactions from a CSV file with bank-specific or custom configuration.

        Orchestrates the complete import process: creating an import batch record,
        parsing the CSV file using the appropriate bank adapter, processing each
        transaction with deduplication and recipient linking, and updating the
        batch with final results.

        The import process:
        1. Creates an ImportBatch record to track the operation
        2. Retrieves or creates a bank adapter for CSV parsing
        3. Parses the CSV file into TransactionData objects
        4. Processes each transaction (deduplicate, link recipient, persist)
        5. Updates the batch with results and completion status
        6. Returns comprehensive import statistics

        Args:
            file_path (str): Absolute path to the CSV file to import.
            bank_name (str): Name of the bank (e.g., 'Chase', 'Belfius', 'Revolut').
                Used to select the appropriate bank adapter or identify custom configs.
            custom_config (Optional[Dict]): Custom CSV configuration for non-standard formats.
                If provided, creates a custom adapter instead of using predefined ones.
                Should include keys like: date_format, date_column, recipient_column,
                amount_column, memo_column, separator, encoding, skip_rows.
            account_type (Optional[str]): Account type override (e.g., 'Checking', 'Savings').
                If provided, this will be used instead of auto-detection by the adapter.
                Allows frontend to specify the account type explicitly.

        Returns:
            Dict[str, Any]: Import results containing:
                - batch_id (str): Unique identifier for the import batch
                - total_processed (int): Total number of transactions parsed from CSV
                - imported (int): Number of new transactions successfully imported
                - duplicates (int): Number of duplicate transactions skipped
                - errors (int): Number of transactions that failed to import
                - status (str): Overall import status ('completed', 'completed_with_errors', 'failed')
                - error_message (Optional[str]): Error description if status is 'failed'

        Raises:
            Exception: Various exceptions may be raised during import (CSV parsing errors,
                database errors, etc.). All exceptions are caught, logged, and the batch
                status is set to 'failed' with an error message.

        Example:
            service = TransactionImportService(db)

            # Import with predefined bank adapter
            result = service.import_csv(
                file_path="/tmp/chase_transactions.csv",
                bank_name="Chase"
            )
            print(f"Imported: {result['imported']}, Duplicates: {result['duplicates']}")

            # Import with custom configuration
            custom_config = {
                "date_format": "%d/%m/%Y",
                "date_column": "Transaction Date",
                "recipient_column": "Description",
                "amount_column": "Amount",
                "separator": ";",
                "encoding": "utf-8"
            }
            result = service.import_csv(
                file_path="/tmp/custom_bank.csv",
                bank_name="CustomBank",
                custom_config=custom_config
            )

        Note:
            - Import is transactional: all transactions in a batch are committed together
            - Duplicate detection uses hash-based deduplication service
            - Recipients are automatically created if they don't exist
            - Import batch status is always updated, even on failure
            - File path should be absolute and file must exist and be readable
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
            "Starting CSV import",
            extra={
                "operation": "import_csv",
                "batch_id": batch.id,
                "file_name": batch.filename,
                "bank_name": bank_name,
                "has_custom_config": custom_config is not None
            }
        )

        try:
            # Get bank adapter
            if custom_config:
                adapter = BankAdapterFactory.create_adapter(bank_name, custom_config)
                logger.debug(f"Using custom adapter for {bank_name}")
            else:
                adapter = BankAdapterFactory.create_adapter(bank_name)
                logger.debug(f"Using predefined adapter for {bank_name}")

            # Parse CSV file using the adapter, passing account_type if provided
            transaction_data_list = adapter.parse_csv(file_path, account_type=account_type)
            logger.info(
                f"Parsed CSV file successfully",
                extra={
                    "operation": "parse_csv",
                    "batch_id": batch.id,
                    "transactions_parsed": len(transaction_data_list),
                    "account_type": account_type
                }
            )

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

            logger.info(
                "CSV import completed successfully",
                extra={
                    "operation": "import_csv",
                    "batch_id": batch.id,
                    "status": batch.status,
                    "total_processed": results['total_processed'],
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
                    "error": str(e),
                    "bank_name": bank_name
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

    def _process_transactions(self, transaction_data_list: List[TransactionData], batch_id: int) -> Dict[str, int]:
        """Process parsed transaction data into database records.

        Iterates through each TransactionData object, performs duplicate detection,
        creates or retrieves recipients, and persists non-duplicate transactions
        to the database. Maintains detailed statistics about the import process.

        Processing steps for each transaction:
        1. Check for duplicates using hash-based deduplication
        2. Skip if duplicate, otherwise continue
        3. Get or create recipient entity
        4. Create Transaction entity with all fields
        5. Persist to database
        6. Track statistics (imported, duplicates, errors)

        Args:
            transaction_data_list (List[TransactionData]): List of parsed transaction data
                objects from the CSV file.
            batch_id (int): Import batch identifier to associate with transactions.

        Returns:
            Dict[str, int]: Processing statistics containing:
                - total_processed: Total number of transactions in the list
                - imported: Number of transactions successfully imported
                - duplicates: Number of duplicate transactions skipped
                - errors: Number of transactions that failed to process

        Example:
            service = TransactionImportService(db)
            transaction_data_list = [...]  # Parsed from CSV
            results = service._process_transactions(transaction_data_list, batch_id=1)
            print(f"Processed {results['total_processed']}, imported {results['imported']}")

        Note:
            - This is an internal method (private by convention)
            - Commits all changes at the end of processing
            - Individual transaction errors don't stop the entire batch
            - Duplicate detection uses the deduplication service
            - Recipients are created automatically if not found
        """
        results = {
            'total_processed': len(transaction_data_list),
            'imported': 0,
            'duplicates': 0,
            'errors': 0
        }

        logger.debug(
            f"Processing {len(transaction_data_list)} transactions",
            extra={
                "operation": "process_transactions",
                "batch_id": batch_id,
                "total_count": len(transaction_data_list)
            }
        )

        for transaction_data in transaction_data_list:
            try:
                # Check for duplicates using dedicated deduplication service
                if self.dedup_service.is_duplicate_by_data(transaction_data):
                    results['duplicates'] += 1
                    continue

                # Get or create recipient using dedicated recipient service
                recipient, _ = self.recipient_service.create_or_get_recipient(
                    transaction_data.recipient,
                    transaction_data.recipient_account,
                    transaction_data.recipient_address,
                    transaction_data.recipient_bank_name
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
                logger.warning(
                    f"Error processing individual transaction: {str(e)}",
                    extra={
                        "operation": "process_transaction",
                        "batch_id": batch_id,
                        "error": str(e),
                        "error_type": type(e).__name__,
                        "transaction_data": str(transaction_data)[:200]  # Truncate for logging
                    },
                    exc_info=True  # Include full traceback
                )
                results['errors'] += 1

        self.db.commit()

        logger.info(
            "Transaction processing completed",
            extra={
                "operation": "process_transactions",
                "batch_id": batch_id,
                "total_processed": results['total_processed'],
                "imported": results['imported'],
                "duplicates": results['duplicates'],
                "errors": results['errors']
            }
        )

        return results

    def get_recipients_with_account_numbers(self) -> List[Recipient]:
        """Retrieve all recipients that have account numbers assigned.

        Delegates to the recipient service to retrieve recipients with non-null
        account numbers. Useful for matching transactions with specific accounts.

        Returns:
            List[Recipient]: List of recipient entities that have account numbers.

        Example:
            service = TransactionImportService(db)
            recipients = service.get_recipients_with_account_numbers()
            for r in recipients:
                print(f"{r.name}: {r.account_number}")

        Note:
            - This is a convenience method that delegates to RecipientService
            - Only returns recipients with non-null account_number fields
        """
        return self.recipient_service.get_with_account_numbers()
