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
import csv
import io
from datetime import datetime
from decimal import Decimal
from typing import List, Optional, Dict, Any

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Transaction
from database.raw_transaction_models import TransactionRawReference
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
    """

    def __init__(self, db_session: Session):
        """Initialise the import service with required dependencies.

        Args:
            db_session: SQLAlchemy database session
        """
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)
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
    ) -> Dict[str, Any]:
        """Import transactions from CSV with raw data preservation.

        Flow:
        1. Parse CSV file
        2. For each transaction:
           a. Check for duplicate in raw table
           b. Store in bank-specific raw table
           c. Create normalized Transaction
           d. Link normalized to raw
        3. Return results

        Args:
            file_path: Path to CSV file
            bank_name: Bank identifier
            custom_config: Optional custom CSV configuration

        Returns:
            Import results dictionary with statistics
        """
        logger.info(
            "Starting raw transaction CSV import",
            extra={
                "operation": "import_csv",
                "file_name": file_path.split('/')[-1],
                "bank_name": bank_name,
            }
        )

        try:
            # Get bank adapter
            if custom_config:
                adapter = BankAdapterFactory.create_adapter(bank_name, custom_config)
            else:
                adapter = BankAdapterFactory.create_adapter(bank_name)

            # Parse CSV file
            transaction_data_list = adapter.parse_csv(file_path)

            logger.info(
                f"Parsed CSV file successfully",
                extra={
                    "operation": "parse_csv",
                    "transactions_parsed": len(transaction_data_list)
                }
            )

            # Determine bank type for routing
            bank_type = self._determine_bank_type(bank_name)

            # Process transactions with new architecture
            results = self._process_transactions_with_raw_storage(
                transaction_data_list,
                bank_type
            )

            logger.info(
                "CSV import completed successfully",
                extra={
                    "operation": "import_csv",
                    "status": "completed" if results['errors'] == 0 else "completed_with_errors",
                    "imported": results['imported'],
                    "duplicates": results['duplicates'],
                    "errors": results['errors']
                }
            )

            return {
                'total_processed': results['total_processed'],
                'imported': results['imported'],
                'duplicates': results['duplicates'],
                'errors': results['errors'],
                'status': "completed" if results['errors'] == 0 else "completed_with_errors"
            }

        except Exception as e:
            logger.error(
                "CSV import failed",
                extra={
                    "operation": "import_csv",
                    "error": str(e)
                },
                exc_info=True
            )

            return {
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
            bank_type: str
    ) -> Dict[str, int]:
        """Process transactions with raw table storage first.

        Architecture flow:
        1. Check duplicate in raw table
        2. Store in bank-specific raw table
        3. Create normalized Transaction
        4. Create TransactionRawReference link

        Args:
            transaction_data_list: Parsed transaction data
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
                    recipient_id=recipient.id
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
                "imported": results['imported'],
                "duplicates": results['duplicates'],
                "errors": results['errors']
            }
        )

        return results

    def _store_raw_transaction(
            self,
            transaction_data: TransactionData,
            bank_type: str
    ):
        """Store transaction in bank-specific raw table.

        Args:
            transaction_data: Parsed transaction data
            bank_type: Bank type for routing

        Returns:
            Created raw transaction instance or None on error
        """
        try:
            # Compute deduplication hash
            dedup_hash = self.dedup_service.get_hash(transaction_data.raw_data)

            # Route to appropriate raw table based on bank type
            if bank_type == 'belfius':
                return self._store_belfius_raw(transaction_data, dedup_hash)
            elif bank_type == 'revolut':
                return self._store_revolut_raw(transaction_data, dedup_hash)
            elif bank_type == 'kbc':
                return self._store_kbc_raw(transaction_data, dedup_hash)
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
            dedup_hash: str
    ):
        """Store Belfius raw transaction.

        Args:
            transaction_data: Parsed transaction data
            dedup_hash: Deduplication hash

        Returns:
            Created BelfiusRawTransaction instance
        """

        # Parse the original CSV row using csv module to obtain literal fields (handles quoted fields)
        parsed = self._parse_raw_csv_line(transaction_data.raw_data, delimiter=';')

        account_number = parsed[0].strip()
        transaction_date_str = parsed[1].strip()
        statement_number = parsed[2].strip()
        transaction_number = parsed[3].strip()
        recipient_account = parsed[4].strip()
        recipient_name = parsed[5].strip()
        street = parsed[6].strip()
        location = parsed[7].strip()
        transaction_description = parsed[8].strip()
        value_date_str = parsed[9].strip()
        amount_str = parsed[10].strip() if len(parsed) > 10 else ''
        currency = parsed[11].strip() if len(parsed) > 11 else (transaction_data.currency or 'EUR')
        bic_code = parsed[12].strip() if len(parsed) > 12 else ""
        country_code = parsed[13].strip() if len(parsed) > 13 else ""
        additional_message = parsed[14].strip() if len(parsed) > 14 else ""

        # Parse numeric/date fields into DB types
        amount_val = self._parse_decimal(amount_str) if amount_str else (
            Decimal(str(transaction_data.amount)) if transaction_data.amount is not None else Decimal('0.00'))
        value_date_val = None
        if value_date_str:
            value_date_val = self._parse_date_or_datetime(value_date_str, date_only=True)

        transaction_date_val = None
        if transaction_date_str:
            transaction_date_val = self._parse_date_or_datetime(transaction_date_str, date_only=True)

        raw_data = {
            'deduplication_hash': dedup_hash,
            'account_number': account_number,
            'transaction_date': transaction_date_val or transaction_data.date.date() if hasattr(transaction_data.date,
                                                                                                'date') else transaction_data.date,
            'statement_number': statement_number,
            'transaction_number': transaction_number,
            'recipient_account': recipient_account,
            'recipient_name': recipient_name,
            'recipient_street': street,
            'recipient_location': location,
            'recipient_bic': bic_code,
            'recipient_country': country_code,
            'transaction_description': transaction_description,
            'value_date': value_date_val,
            'amount': amount_val,
            'currency': currency,
            'balance': Decimal(str(transaction_data.balance)) if transaction_data.balance is not None else None,
            'additional_message': additional_message,
            'raw_csv_line': transaction_data.raw_data
        }

        return self.belfius_raw_repo.create(raw_data)

    def _store_revolut_raw(
            self,
            transaction_data: TransactionData,
            dedup_hash: str
    ):
        """Store Revolut raw transaction.

        Args:
            transaction_data: Parsed transaction data
            dedup_hash: Deduplication hash

        Returns:
            Created RevolutRawTransaction instance
        """
        # Parse literal CSV cells according to Revolut format (10 columns)
        parsed = self._parse_raw_csv_line(transaction_data.raw_data, delimiter=',')

        transaction_type = parsed[0].strip() if len(parsed) > 0 else ''
        product = parsed[1].strip() if len(parsed) > 1 else ''
        started_date_str = parsed[2].strip() if len(parsed) > 2 else ''
        completed_date_str = parsed[3].strip() if len(parsed) > 3 else ''
        description = parsed[4].strip() if len(parsed) > 4 else ''
        amount_str = parsed[5].strip() if len(parsed) > 5 else ''
        fee_str = parsed[6].strip() if len(parsed) > 6 else ''
        currency_str = parsed[7].strip() if len(parsed) > 7 else ''
        state_str = parsed[8].strip() if len(parsed) > 8 else ''
        balance_str = parsed[9].strip() if len(parsed) > 9 else ''

        # Parse dates and numbers to DB types
        started_date_val = None
        if started_date_str:
            started_date_val = self._parse_date_or_datetime(started_date_str, date_only=False)
        completed_date_val = None
        if completed_date_str:
            completed_date_val = self._parse_date_or_datetime(completed_date_str, date_only=False)

        amount_val = self._parse_decimal(amount_str) if amount_str else (
            Decimal(str(transaction_data.amount)) if transaction_data.amount is not None else Decimal('0.00'))
        balance_val = self._parse_decimal(balance_str) if balance_str else (
            Decimal(str(transaction_data.balance)) if transaction_data.balance is not None else None)

        raw_data = {
            'deduplication_hash': dedup_hash,
            'transaction_type': transaction_type,
            'product': product,
            'started_date': started_date_val,
            'completed_date': completed_date_val or transaction_data.date,
            'description': description or transaction_data.recipient,
            'amount': amount_val,
            'fee': fee_str,
            'currency': currency_str or (transaction_data.currency),
            'state': state_str,
            'balance': balance_val,
            'raw_csv_line': transaction_data.raw_data
        }

        return self.revolut_raw_repo.create(raw_data)

    def _store_kbc_raw(
            self,
            transaction_data: TransactionData,
            dedup_hash: str
    ):
        """Store KBC raw transaction.

        Args:
            transaction_data: Parsed transaction data
            dedup_hash: Deduplication hash

        Returns:
            Created KBCRawTransaction instance
        """
        # Parse literal CSV cells according to KBC format (18 columns expected)
        parsed = self._parse_raw_csv_line(transaction_data.raw_data, delimiter=';')

        account_number = parsed[0].strip() if len(parsed) > 0 else ''
        category_name = parsed[1].strip() if len(parsed) > 1 else ''
        account_holder = parsed[2].strip() if len(parsed) > 2 else ''
        currency_str = parsed[3].strip() if len(parsed) > 3 else (transaction_data.currency or '')
        statement_number = parsed[4].strip() if len(parsed) > 4 else ''
        transaction_date_str = parsed[5].strip() if len(parsed) > 5 else ''
        description = parsed[6].strip() if len(parsed) > 6 else ''
        value_date_str = parsed[7].strip() if len(parsed) > 7 else ''
        amount_str = parsed[8].strip() if len(parsed) > 8 else ''
        balance_str = parsed[9].strip() if len(parsed) > 9 else ''
        credit_str = parsed[10].strip() if len(parsed) > 10 else ''
        debit_str = parsed[11].strip() if len(parsed) > 11 else ''
        counterparty_account = parsed[12].strip() if len(parsed) > 12 else ''
        counterparty_bic = parsed[13].strip() if len(parsed) > 13 else ''
        counterparty_name = parsed[14].strip() if len(parsed) > 14 else ''
        counterparty_address = parsed[15].strip() if len(parsed) > 15 else ''
        structured_comm = parsed[16].strip() if len(parsed) > 16 else ''
        free_comm = parsed[17].strip() if len(parsed) > 17 else ''

        # Parse date and numeric fields into proper DB types
        transaction_date_val = None
        if transaction_date_str:
            transaction_date_val = self._parse_date_or_datetime(transaction_date_str, date_only=True)
        value_date_val = None
        if value_date_str:
            value_date_val = self._parse_date_or_datetime(value_date_str, date_only=True)

        amount_val = self._parse_decimal(amount_str) if amount_str else (
            Decimal(str(transaction_data.amount)) if transaction_data.amount is not None else Decimal('0.00'))
        balance_val = self._parse_decimal(balance_str) if balance_str else (
            Decimal(str(transaction_data.balance)) if transaction_data.balance is not None else None)
        credit_val = self._parse_decimal(credit_str) if credit_str else None
        debit_val = self._parse_decimal(debit_str) if debit_str else None

        raw_data = {
            'deduplication_hash': dedup_hash,
            'account_number': account_number,
            'category_name': category_name,
            'account_holder_name': account_holder,
            'currency': currency_str or (transaction_data.currency or 'EUR'),
            'statement_number': statement_number,
            'transaction_date': transaction_date_val or (
                transaction_data.date.date() if hasattr(transaction_data.date, 'date') else transaction_data.date),
            'value_date': value_date_val or None,
            'description': description,
            'amount': amount_val,
            'balance': balance_val,
            'credit_amount': credit_val,
            'debit_amount': debit_val,
            'counterparty_account': counterparty_account,
            'counterparty_bic': counterparty_bic,
            'counterparty_name': counterparty_name,
            'counterparty_address': counterparty_address,
            'structured_communication': structured_comm,
            'free_communication': free_comm,
            'raw_csv_line': transaction_data.raw_data
        }

        return self.kbc_raw_repo.create(raw_data)

    def _parse_raw_csv_line(self, raw_line: str, delimiter: str = ',') -> list:
        """Parse a single CSV row string into fields using the csv module.

        Uses io.StringIO to feed the single raw line to csv.reader so quoted fields
        and embedded delimiters are handled correctly.
        Returns a list of strings (empty list on parse failure).
        """
        if not raw_line:
            return []
        try:
            # Ensure we feed a single-line string to the csv reader
            sio = io.StringIO(raw_line)
            reader = csv.reader(sio, delimiter=delimiter)
            for row in reader:
                return row
            return []
        except Exception:
            return []

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

    def _parse_decimal(self, value: str) -> Decimal:
        """Parse numeric strings from CSV into Decimal.

        Handles common CSV formats: comma as decimal separator, parentheses for negatives,
        spaces and thousands separators. Returns Decimal with two decimal places.
        """
        if value is None:
            return Decimal('0.00')
        v = str(value).strip()
        if v == '':
            return Decimal('0.00')
        # Handle parentheses for negative values: (1.23) -> -1.23
        negative = False
        if v.startswith('(') and v.endswith(')'):
            negative = True
            v = v[1:-1]
        # Replace comma decimal separator with dot, and remove spaces
        v = v.replace('.', '') if v.count('.') > 1 and ',' in v else v
        v = v.replace(',', '.')
        v = v.replace(' ', '')
        try:
            d = Decimal(v)
        except Exception:
            # Fallback: try parsing as float then Decimal
            try:
                d = Decimal(str(float(v)))
            except Exception:
                return Decimal('0.00')
        if negative:
            d = -d
        # Quantize to 2 decimal places
        return d.quantize(Decimal('0.01'))

    def _parse_date_or_datetime(self, value: str, date_only: bool = True):
        """Parse date or datetime strings commonly found in the CSVs.

        If date_only=True returns a datetime.date, otherwise a datetime.
        Tries multiple formats robustly.
        """
        if not value:
            return None
        s = value.strip()
        # Try common date formats
        date_formats = ['%d/%m/%Y', '%Y-%m-%d', '%d/%m/%Y %H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M',
                        '%d/%m/%Y %H:%M:%S']
        for fmt in date_formats:
            try:
                dt = datetime.strptime(s, fmt)
                return dt.date() if date_only else dt
            except Exception:
                continue
        # As a last resort, if only day/month/year in other separators
        try:
            parts = s.replace('-', '/').split()
            d = parts[0]
            return datetime.strptime(d, '%d/%m/%Y').date() if date_only else datetime.strptime(d, '%d/%m/%Y')
        except Exception:
            return None
