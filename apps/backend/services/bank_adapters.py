import csv
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Any

import pandas as pd

from config.logging_config import setup_logging
from services.text_normalization_service import TextNormalizationService

logger = setup_logging(__name__)


@dataclass
class TransactionData:
    """Standardized transaction data structure"""
    date: datetime
    bank_account: str
    recipient: str
    memo: Optional[str]
    amount: float
    currency: Optional[str] = None
    balance: Optional[float] = None
    recipient_account: Optional[str] = None  # Account number of recipient when available
    recipient_address: Optional[str] = None  # Physical address of recipient when available
    recipient_bank_name: Optional[str] = None  # Bank name for the recipient's account
    comment: Optional[str] = None  # Additional comment field for bank-specific data
    raw_data: str = ""  # Original CSV row for hashing


class BaseBankAdapter(ABC):
    """Abstract base class for bank adapters"""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.bank_name = config.get("bank_name", "Unknown")

    @abstractmethod
    def parse_csv(self, file_path: str, account_type: Optional[str] = None) -> List[TransactionData]:
        """Parse CSV file and return list of standardized transactions

        Args:
            file_path: Path to CSV file
            account_type: Optional account type override (e.g., 'Checking', 'Savings')
                        If provided, this will be used instead of auto-detection
        """
        pass


class BelfiusAdapter(BaseBankAdapter):
    """Specialized adapter for Belfius CSV format

    Handles the Belfius bank CSV format with comprehensive metadata extraction:
    - Header metadata (balance, timestamp, filter parameters)
    - Transaction details (statement numbers, BIC codes, value dates)
    - Recipient information (account, address, country)
    - Automatic bank account type detection based on account number

    CSV Structure:
    - Lines 1-9: Filter parameters and metadata
    - Line 10: Last balance ("Laatste saldo;0,00 EUR")
    - Line 11: Balance timestamp ("Datum/uur van het laatste saldo;19/02/2026 12:46:57")
    - Line 12: Empty separator
    - Line 13: Column headers
    - Line 14+: Transaction data rows
    """

    def parse_csv(self, file_path: str, account_type: Optional[str] = None) -> List[TransactionData]:
        """Parse Belfius CSV format with maximal information extraction

        Extracts all available fields including:
        - Transaction and value dates
        - Statement and transaction reference numbers
        - Recipient details (name, account, address, BIC, country)
        - Balance information with timestamp
        - Full transaction descriptions and communications

        Args:
            file_path: Path to Belfius CSV file
            account_type: Optional account type override (e.g., 'Checking', 'Savings')
                        If provided, this will be used instead of auto-detection

        Returns:
            List of TransactionData objects with comprehensive field population
        """
        transactions = []
        last_balance = None
        balance_timestamp = None
        account_number = None

        with open(file_path, 'r', encoding='utf-8') as file:
            lines = file.readlines()

            # Extract the last balance from line 10 (index 9): "Laatste saldo;0,00 EUR"
            if len(lines) > 9:
                balance_line = lines[9].strip()
                if "Laatste saldo;" in balance_line:
                    parts = balance_line.split(';')
                    if len(parts) >= 2:
                        balance_str = parts[1].replace(' EUR', '').replace(',', '.').strip()
                        try:
                            last_balance = float(balance_str)
                            logger.debug(f"Extracted last balance: {last_balance} EUR")
                        except ValueError as e:
                            logger.warning(f"Failed to parse balance '{balance_str}': {e}")

            # Extract balance timestamp from line 11 (index 10)
            if len(lines) > 10:
                timestamp_line = lines[10].strip()
                if "Datum/uur van het laatste saldo;" in timestamp_line:
                    parts = timestamp_line.split(';')
                    if len(parts) >= 2:
                        timestamp_str = parts[1].strip()
                        try:
                            balance_timestamp = datetime.strptime(timestamp_str, "%d/%m/%Y %H:%M:%S")
                            logger.debug(f"Extracted balance timestamp: {balance_timestamp}")
                        except ValueError as e:
                            logger.warning(f"Failed to parse balance timestamp '{timestamp_str}': {e}")

            # Skip metadata lines (first 12 lines), header line (line 13, index 12)
            # Actual data starts at line 14 (index 13)
            for line_num, line in enumerate(lines[13:], start=14):
                try:
                    line = line.strip()
                    if not line:
                        continue

                    parts = line.split(';')
                    if len(parts) < 12:
                        logger.warning(f"Skipping Belfius line {line_num}: insufficient columns ({len(parts)} < 12)")
                        continue

                    account_number = parts[0].strip()
                    transaction_date_str = parts[1].strip()
                    statement_number = parts[2].strip()
                    transaction_number = parts[3].strip()
                    recipient_account = parts[4].strip()
                    recipient_name = parts[5].strip()
                    street = parts[6].strip()
                    location = parts[7].strip()
                    transaction_description = parts[8].strip()
                    value_date_str = parts[9].strip()
                    amount_str = parts[10].strip()
                    currency = parts[11].strip()
                    bic_code = parts[12].strip() if len(parts) > 12 else ""
                    country_code = parts[13].strip() if len(parts) > 13 else ""
                    additional_message = parts[14].strip() if len(parts) > 14 else ""

                    try:
                        date = datetime.strptime(transaction_date_str, "%d/%m/%Y")
                    except ValueError as e:
                        logger.error(f"Error parsing Belfius date '{transaction_date_str}' on line {line_num}: {e}")
                        continue

                    value_date = None
                    if value_date_str:
                        try:
                            value_date = datetime.strptime(value_date_str, "%d/%m/%Y")
                        except ValueError:
                            logger.debug(f"Could not parse value date '{value_date_str}' on line {line_num}")

                    try:
                        amount = float(amount_str.replace(',', '.'))
                    except ValueError as e:
                        logger.error(f"Error parsing Belfius amount '{amount_str}' on line {line_num}: {e}")
                        continue

                    # Determine bank account type: use provided override or auto-detect
                    if account_type:
                        bank_account_type = f"BELFIUS {account_type.upper()}"
                        logger.debug(f"Using provided account type: {bank_account_type}")
                    else:
                        bank_account_type = self._determine_account_type(account_number)

                    # Build comprehensive recipient name
                    # Priority: explicit recipient name > transaction description
                    full_recipient = recipient_name if recipient_name else transaction_description

                    # Clean the recipient name using the normalization service
                    full_recipient = TextNormalizationService.clean_recipient_name(full_recipient)

                    # Normalize to uppercase for consistency with database storage
                    full_recipient = TextNormalizationService.normalize_recipient_name(full_recipient)

                    # Build full address from street and location
                    recipient_full_address = None
                    if street or location:
                        address_parts = [part.strip() for part in [street, location] if part.strip()]
                        recipient_full_address = ", ".join(address_parts) if address_parts else None

                    # Build comprehensive memo/description
                    # Use transaction description as primary memo
                    memo = transaction_description if transaction_description else ""

                    # Normalize memo to uppercase for consistency
                    memo = TextNormalizationService.normalize_recipient_name(memo) if memo else ""

                    # Build comprehensive comment field combining all additional info
                    # Format: "Statement: {number} | Transaction: {number} | Value Date: {date} | BIC: {code} | Country: {code} | {additional_message}"
                    comment_parts = []
                    if statement_number:
                        comment_parts.append(f"Statement: {statement_number}")
                    if transaction_number:
                        comment_parts.append(f"Transaction: {transaction_number}")
                    if value_date and value_date != date:
                        comment_parts.append(f"Value Date: {value_date.strftime('%d/%m/%Y')}")
                    if bic_code:
                        comment_parts.append(f"BIC: {bic_code}")
                    if country_code:
                        comment_parts.append(f"Country: {country_code}")
                    if additional_message:
                        comment_parts.append(additional_message)

                    comment = " | ".join(comment_parts) if comment_parts else None

                    # Create transaction with comprehensive data
                    transaction = TransactionData(
                        date=date,
                        bank_account=bank_account_type,
                        recipient=full_recipient,
                        memo=memo,
                        amount=amount,
                        currency=currency,
                        balance=last_balance,  # Use the last balance from header
                        recipient_account=recipient_account if recipient_account else None,
                        recipient_address=recipient_full_address,
                        recipient_bank_name="BELFIUS" if recipient_account else None,
                        comment=comment,
                        raw_data=line
                    )

                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    logger.error(f"Error parsing Belfius line {line_num}: {e}")
                    logger.debug(f"Line content: {line}")
                    continue

        logger.info(
            f"Belfius CSV parsing completed",
            extra={
                "transactions_parsed": len(transactions),
                "last_balance": last_balance,
                "balance_timestamp": balance_timestamp.isoformat() if balance_timestamp else None,
                "account_number": account_number
            }
        )

        return transactions

    def _determine_account_type(self, account_number: str) -> str:
        """Determine the Belfius account type from the account number pattern

        Belfius account numbers follow IBAN format (BE + 2 check digits + 12 digits).
        Different account types may have different number patterns, though the exact
        mapping may vary. This method can be extended with more specific patterns.

        Args:
            account_number: IBAN account number (e.g., "BE81 0637 5694 4024")

        Returns:
            Normalized account type string (uppercase)
        """
        # Remove spaces for pattern matching
        clean_number = account_number.replace(" ", "")

        # Default to generic checking account
        # This can be extended with specific patterns if Belfius uses
        # different account number ranges for savings, credit cards, etc.
        account_type = "BELFIUS CHECKING ACCOUNT"

        # Add pattern matching here if specific account types can be identified
        # Example (hypothetical):
        # if clean_number.startswith("BE37"):
        #     account_type = "BELFIUS SAVINGS ACCOUNT"
        # elif clean_number.startswith("BE45"):
        #     account_type = "BELFIUS CREDIT CARD"

        return account_type


class RevolutAdapter(BaseBankAdapter):
    """Specialized adapter for Revolut CSV format

    Handles the Revolut CSV format with comprehensive field extraction:
    - Transaction type and product classification
    - Started and completed date tracking
    - Transaction fees and net amount calculation
    - State filtering (COMPLETED vs PENDING)
    - Balance tracking per transaction

    CSV Structure:
    - Line 1: Header row with column names
    - Line 2+: Transaction data rows (comma-separated)

    Column Structure (10 columns):
    0: Type (e.g., "Card Payment", "Transfer", "Exchange")
    1: Product (e.g., "Current", "Savings")
    2: Started Date (timestamp when transaction initiated)
    3: Completed Date (timestamp when transaction completed)
    4: Description (merchant/recipient name)
    5: Amount (transaction amount with decimal point)
    6: Fee (transaction fee, if any)
    7: Currency (e.g., "EUR", "USD")
    8: State (e.g., "COMPLETED", "PENDING", "REVERTED")
    9: Balance (account balance after transaction)

    Note: Revolut does not provide recipient account numbers or addresses.
    """

    def parse_csv(self, file_path: str, account_type: Optional[str] = None) -> List[TransactionData]:
        """Parse Revolut CSV format with maximal information extraction

        Extracts all available fields including:
        - Transaction types and product categories
        - Started and completed timestamps
        - Transaction fees (stored in comment field)
        - State filtering (only COMPLETED transactions)
        - Balance per transaction
        - Proper date normalization for deduplication

        Args:
            file_path: Path to Revolut CSV file
            account_type: Optional account type override (not used by Revolut - product field is used instead)

        Returns:
            List of TransactionData objects with comprehensive field population
        """
        transactions = []

        with open(file_path, 'r', encoding='utf-8') as file:
            csv_reader = csv.reader(file)

            for line_num, parts in enumerate(csv_reader, 1):
                try:
                    # Skip empty lines
                    if not parts or all(not field.strip() for field in parts):
                        continue

                    # Skip header line
                    if line_num == 1 and parts[0].strip() == 'Type':
                        logger.debug(f"Skipping Revolut header line {line_num}")
                        continue

                    # Revolut format has 10 columns
                    if len(parts) < 10:
                        logger.warning(
                            f"Skipping Revolut line {line_num}: insufficient columns ({len(parts)} < 10)"
                        )
                        continue

                    # Column mapping based on Revolut CSV format:
                    # 0: Type (Transaction type - e.g., "Card Payment", "Transfer", "ATM", "Exchange")
                    # 1: Product (Account/product type - e.g., "Current", "Savings")
                    # 2: Started Date (When transaction was initiated - YYYY-MM-DD HH:MM:SS)
                    # 3: Completed Date (When transaction completed - YYYY-MM-DD HH:MM:SS)
                    # 4: Description (Merchant/recipient name or transaction description)
                    # 5: Amount (Transaction amount - can be positive or negative)
                    # 6: Fee (Transaction fee - usually 0.00 for standard transactions)
                    # 7: Currency (Currency code - e.g., "EUR", "USD", "GBP")
                    # 8: State (Transaction state - "COMPLETED", "PENDING", "REVERTED", "DECLINED")
                    # 9: Balance (Account balance after this transaction)

                    transaction_type = parts[0].strip()
                    product = parts[1].strip()
                    started_date_str = parts[2].strip()
                    completed_date_str = parts[3].strip()
                    description = parts[4].strip()
                    amount_str = parts[5].strip()
                    fee_str = parts[6].strip()
                    currency = parts[7].strip()
                    state = parts[8].strip()
                    balance_str = parts[9].strip()

                    # Filter by state - only process COMPLETED transactions
                    if state.upper() != 'COMPLETED':
                        logger.debug(
                            f"Skipping Revolut line {line_num}: transaction state is '{state}' (not COMPLETED)"
                        )
                        continue

                    # Skip transactions without a completed date
                    if not completed_date_str or completed_date_str.strip() == '':
                        logger.warning(
                            f"Skipping Revolut line {line_num}: no completed date (status: {state})"
                        )
                        continue

                    # Parse the completed date (this is the effective transaction date)
                    # Format: YYYY-MM-DD HH:MM:SS
                    try:
                        date = datetime.strptime(completed_date_str, "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        # Try alternative formats
                        try:
                            date = datetime.strptime(completed_date_str, "%d/%m/%Y %H:%M:%S")
                        except ValueError:
                            try:
                                date = datetime.strptime(completed_date_str, "%Y-%m-%d %H:%M")
                            except ValueError:
                                try:
                                    # Try date only (without time)
                                    date = datetime.strptime(completed_date_str.split()[0], "%Y-%m-%d")
                                except ValueError as e:
                                    logger.error(
                                        f"Error parsing Revolut completed date '{completed_date_str}' on line {line_num}: {e}"
                                    )
                                    continue

                    # Parse started date (optional, for time difference calculation)
                    started_date = None
                    if started_date_str:
                        try:
                            started_date = datetime.strptime(started_date_str, "%Y-%m-%d %H:%M:%S")
                        except ValueError:
                            logger.debug(
                                f"Could not parse Revolut started date '{started_date_str}' on line {line_num}")

                    # Parse amount
                    try:
                        amount = float(amount_str)
                    except ValueError as e:
                        logger.error(f"Error parsing Revolut amount '{amount_str}' on line {line_num}: {e}")
                        continue

                    # Parse fee (usually 0.00 for standard transactions)
                    fee = 0.0
                    if fee_str:
                        try:
                            fee = float(fee_str)
                        except ValueError:
                            logger.debug(f"Could not parse Revolut fee '{fee_str}' on line {line_num}")

                    # Parse balance
                    balance = None
                    if balance_str and balance_str != '':
                        try:
                            balance = float(balance_str)
                        except ValueError:
                            logger.debug(f"Could not parse Revolut balance '{balance_str}' on line {line_num}")

                    # Determine account type from product
                    # Revolut uses different products: Current, Savings, etc.
                    bank_account_type = self._determine_account_type(product)

                    # Clean the recipient/description name using normalization service
                    cleaned_description = TextNormalizationService.clean_recipient_name(description)

                    # Normalize to uppercase for consistency with database storage
                    cleaned_description = TextNormalizationService.normalize_recipient_name(cleaned_description)

                    # Build comprehensive memo combining type and product
                    # Format: "CARD PAYMENT - CURRENT" or "TRANSFER - SAVINGS"
                    memo = TextNormalizationService.normalize_recipient_name(f"{transaction_type} - {product}")

                    # Build comprehensive comment field combining all additional info
                    # Format: "Type: {type} | Product: {product} | Fee: {amount} | Started: {datetime} | State: {state}"
                    comment_parts = []
                    if transaction_type:
                        comment_parts.append(f"Type: {transaction_type}")
                    if product:
                        comment_parts.append(f"Product: {product}")
                    if fee > 0:
                        comment_parts.append(f"Fee: {fee:.2f} {currency}")
                    if started_date and started_date != date:
                        # Calculate time difference
                        time_diff = date - started_date
                        hours = time_diff.total_seconds() / 3600
                        comment_parts.append(f"Started: {started_date.strftime('%Y-%m-%d %H:%M:%S')}")
                        comment_parts.append(f"Processing Time: {hours:.1f}h")
                    if state:
                        comment_parts.append(f"State: {state}")

                    comment = " | ".join(comment_parts) if comment_parts else None

                    # Create raw data string for hashing with normalized date (YYYY-MM-DD)
                    # This ensures consistent deduplication even if timestamps vary slightly
                    normalized_parts = parts.copy()
                    normalized_date = date.strftime("%Y-%m-%d")
                    normalized_parts[2] = normalized_date  # Replace started_date
                    normalized_parts[3] = normalized_date  # Replace completed_date
                    raw_data = ','.join(normalized_parts)

                    # Create transaction with comprehensive data
                    transaction = TransactionData(
                        date=date,
                        bank_account=bank_account_type,
                        recipient=cleaned_description,
                        memo=memo,
                        amount=amount,
                        currency=currency,
                        balance=balance,
                        recipient_account=None,  # Revolut doesn't provide recipient account numbers
                        recipient_address=None,  # Revolut doesn't provide recipient addresses
                        recipient_bank_name=None,  # Revolut doesn't provide recipient bank info
                        comment=comment,
                        raw_data=raw_data
                    )
                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    logger.error(f"Error parsing Revolut line {line_num}: {e}")
                    logger.debug(f"Line content: {parts}")
                    continue

        logger.info(
            f"Revolut CSV parsing completed",
            extra={
                "transactions_parsed": len(transactions)
            }
        )

        return transactions

    def _determine_account_type(self, product: str) -> str:
        """Determine Revolut account type from product field

        Revolut uses product names to identify account types:
        - Current: Main spending account
        - Savings: Savings vault/account
        - Other products can be added as identified

        Args:
            product: Product/account type (e.g., "Current", "Savings")

        Returns:
            Normalized account type string (uppercase)
        """
        # Normalize product name
        product_upper = product.upper().strip()

        # Map product to account type
        if product_upper == "CURRENT":
            account_type = "REVOLUT CURRENT"
        elif product_upper == "SAVINGS":
            account_type = "REVOLUT SAVINGS"
        else:
            # Generic fallback for other Revolut products
            account_type = f"REVOLUT {product_upper}" if product_upper else "REVOLUT"

        return account_type


class KBCAdapter(BaseBankAdapter):
    """Specialized adapter for KBC CSV format

    Handles the KBC bank CSV format with comprehensive field extraction:
    - Account type detection (Checking vs Savings based on IBAN pattern)
    - Transaction details (statement numbers, BIC codes, value dates)
    - Recipient information (account, address, BIC)
    - Credit/debit separation with proper amount handling
    - Structured and unstructured communications

    CSV Structure:
    - Line 1: Header row with column names
    - Line 2+: Transaction data rows (semicolon-separated)

    Column Structure (18 columns):
    0: Rekeningnummer (Account number - IBAN)
    1: Rubrieknaam (Category/Section name)
    2: Naam (Account holder name)
    3: Munt (Currency)
    4: Afschriftnummer (Statement number)
    5: Datum (Transaction date)
    6: Omschrijving (Description/Memo)
    7: Valuta (Value date)
    8: Bedrag (Amount)
    9: Saldo (Balance)
    10: credit (Credit amount)
    11: debet (Debit amount)
    12: rekeningnummer tegenpartij (Counterparty account)
    13: BIC tegenpartij (Counterparty BIC)
    14: Naam tegenpartij (Counterparty name)
    15: Adres tegenpartij (Counterparty address)
    16: gestructureerde mededeling (Structured communication)
    17: Vrije mededeling (Free communication)
    """

    def parse_csv(self, file_path: str, account_type: Optional[str] = None) -> List[TransactionData]:
        """Parse KBC CSV format with maximal information extraction

        Extracts all available fields including:
        - Account type detection from IBAN pattern
        - Statement numbers for reconciliation
        - Transaction and value dates
        - Credit/debit amounts for transaction type identification
        - Recipient details (name, account, BIC, address)
        - Structured and unstructured communications

        Args:
            file_path: Path to KBC CSV file
            account_type: Optional account type override (e.g., 'Checking', 'Savings')
                        If provided, this will be used instead of auto-detection

        Returns:
            List of TransactionData objects with comprehensive field population
        """
        transactions = []

        with open(file_path, 'r', encoding='utf-8') as file:
            for line_num, line in enumerate(file, 1):
                try:
                    # Skip empty lines
                    line = line.strip()
                    if not line:
                        continue

                    # Skip header line (starts with "Rekeningnummer")
                    if line.startswith("Rekeningnummer") or "Vrije Mededeling" in line:
                        logger.debug(f"Skipping KBC header line {line_num}")
                        continue

                    # Skip lines with only commas/separators
                    if line.startswith(",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,"):
                        continue

                    # Split by semicolon (KBC uses semicolon-separated format)
                    parts = line.split(';')

                    # KBC format has 18 columns, but we need at least the core fields (15)
                    if len(parts) < 15:
                        logger.warning(
                            f"Skipping KBC line {line_num}: insufficient columns ({len(parts)} < 15)"
                        )
                        continue

                    # Column mapping based on KBC CSV format:
                    # 0: Rekeningnummer (Account number - IBAN, e.g., BE61734041478017)
                    # 1: Rubrieknaam (Category/Section name - usually empty or whitespace)
                    # 2: Naam (Account holder name, e.g., BAU IE)
                    # 3: Munt (Currency code, e.g., EUR)
                    # 4: Afschriftnummer (Statement number with spaces, e.g., "  02026001")
                    # 5: Datum (Transaction date - DD/MM/YYYY)
                    # 6: Omschrijving (Description/Memo - detailed transaction description)
                    # 7: Valuta (Value date - DD/MM/YYYY)
                    # 8: Bedrag (Amount - with comma as decimal, includes sign)
                    # 9: Saldo (Balance after transaction - with comma as decimal)
                    # 10: credit (Credit amount if transaction is credit, empty if debit)
                    # 11: debet (Debit amount if transaction is debit, empty if credit)
                    # 12: rekeningnummer tegenpartij (Counterparty account number - IBAN)
                    # 13: BIC tegenpartij (Counterparty BIC code)
                    # 14: Naam tegenpartij (Counterparty name)
                    # 15: Adres tegenpartij (Counterparty address)
                    # 16: gestructureerde mededeling (Structured communication/reference)
                    # 17: Vrije mededeling (Free/unstructured communication)

                    account_number = parts[0].strip()
                    category_name = parts[1].strip()
                    account_holder = parts[2].strip()
                    currency = parts[3].strip()
                    statement_number = parts[4].strip()
                    transaction_date_str = parts[5].strip()
                    description = parts[6].strip()
                    value_date_str = parts[7].strip()
                    amount_str = parts[8].strip()
                    balance_str = parts[9].strip()
                    credit_str = parts[10].strip()
                    debit_str = parts[11].strip()
                    counterparty_account = parts[12].strip()
                    counterparty_bic = parts[13].strip()
                    counterparty_name = parts[14].strip()
                    counterparty_address = parts[15].strip() if len(parts) > 15 else ""
                    structured_communication = parts[16].strip() if len(parts) > 16 else ""
                    free_communication = parts[17].strip() if len(parts) > 17 else ""

                    # Parse the transaction date (format: DD/MM/YYYY)
                    try:
                        date = datetime.strptime(transaction_date_str, "%d/%m/%Y")
                    except ValueError as e:
                        logger.error(
                            f"Error parsing KBC transaction date '{transaction_date_str}' on line {line_num}: {e}"
                        )
                        continue

                    # Parse value date (optional, may differ from transaction date)
                    value_date = None
                    if value_date_str:
                        try:
                            value_date = datetime.strptime(value_date_str, "%d/%m/%Y")
                        except ValueError:
                            logger.debug(f"Could not parse KBC value date '{value_date_str}' on line {line_num}")

                    # Parse amount (KBC uses comma as decimal separator)
                    try:
                        amount = float(amount_str.replace(',', '.'))
                    except ValueError as e:
                        logger.error(f"Error parsing KBC amount '{amount_str}' on line {line_num}: {e}")
                        continue

                    # Parse balance (with comma as decimal separator)
                    balance = None
                    if balance_str:
                        try:
                            balance = float(balance_str.replace(',', '.'))
                        except ValueError:
                            logger.debug(f"Could not parse KBC balance '{balance_str}' on line {line_num}")

                    # Determine transaction type from credit/debit fields
                    # These fields contain the amount if the transaction is that type, or spaces if not
                    # Note: KBC stores debit amounts as negative values in the debit column
                    transaction_type = None
                    if credit_str and credit_str.strip():
                        try:
                            credit_amount = float(credit_str.replace(',', '.'))
                            if abs(credit_amount) > 0:
                                transaction_type = "CREDIT"
                        except ValueError:
                            pass
                    if debit_str and debit_str.strip():
                        try:
                            debit_amount = float(debit_str.replace(',', '.'))
                            if abs(debit_amount) > 0:
                                transaction_type = "DEBIT"
                        except ValueError:
                            pass

                    # Determine bank account type: use provided override or auto-detect from IBAN pattern
                    if account_type:
                        bank_account_type = f"KBC {account_type.upper()}"
                        logger.debug(f"Using provided account type: {bank_account_type}")
                    else:
                        bank_account_type = self._determine_account_type(account_number)

                    # Build comprehensive recipient name
                    # Priority: counterparty name > account holder > description
                    full_recipient = counterparty_name if counterparty_name else account_holder
                    if not full_recipient:
                        full_recipient = description

                    # Clean the recipient name using KBC-specific logic
                    full_recipient = TextNormalizationService.clean_kbc_recipient_name(full_recipient)

                    # Normalize to uppercase for consistency with database storage
                    full_recipient = TextNormalizationService.normalize_recipient_name(full_recipient)

                    # Normalize description/memo to uppercase
                    memo = TextNormalizationService.normalize_recipient_name(description) if description else ""

                    # Build comprehensive comment field combining all additional info
                    # Format: "Statement: {number} | Type: {credit/debit} | Value Date: {date} | BIC: {code} | Structured: {msg} | Free: {msg}"
                    comment_parts = []
                    if statement_number:
                        # Strip leading/trailing spaces but preserve the number itself
                        comment_parts.append(f"Statement: {statement_number.strip()}")
                    if transaction_type:
                        comment_parts.append(f"Type: {transaction_type}")
                    if value_date and value_date != date:
                        comment_parts.append(f"Value Date: {value_date.strftime('%d/%m/%Y')}")
                    if counterparty_bic:
                        comment_parts.append(f"BIC: {counterparty_bic}")
                    if structured_communication:
                        comment_parts.append(f"Structured: {structured_communication}")
                    if free_communication:
                        comment_parts.append(f"Free: {free_communication}")

                    comment = " | ".join(comment_parts) if comment_parts else None

                    # Create transaction with comprehensive data
                    transaction = TransactionData(
                        date=date,
                        bank_account=bank_account_type,
                        recipient=full_recipient,
                        memo=memo,
                        amount=amount,
                        currency=currency,
                        balance=balance,
                        recipient_account=counterparty_account if counterparty_account else None,
                        recipient_address=counterparty_address if counterparty_address else None,
                        recipient_bank_name="KBC" if counterparty_account else None,
                        comment=comment,
                        raw_data=line
                    )

                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    logger.error(f"Error parsing KBC line {line_num}: {e}")
                    logger.debug(f"Line content: {line}")
                    continue

        logger.info(
            f"KBC CSV parsing completed",
            extra={
                "transactions_parsed": len(transactions)
            }
        )

        return transactions

    def _determine_account_type(self, account_number: str) -> str:
        """Determine KBC account type from IBAN pattern

        KBC uses specific IBAN patterns for different account types:
        - BE61 prefix: Checking accounts
        - BE34 prefix: Savings accounts
        - Other patterns can be added as identified

        Args:
            account_number: IBAN account number (e.g., "BE61734041478017")

        Returns:
            Normalized account type string (uppercase)
        """
        # Remove spaces for pattern matching
        clean_number = account_number.replace(" ", "")

        # Detect account type based on IBAN prefix pattern
        if clean_number.startswith("BE61"):
            account_type = "KBC CHECKING ACCOUNT"
        elif clean_number.startswith("BE34"):
            account_type = "KBC SAVINGS ACCOUNT"
        else:
            # Generic fallback for other KBC account types
            account_type = "KBC ACCOUNT"

        return account_type


def _parse_amount(amount_str: str) -> float:
    """Parse amount string to float, handling various formats"""
    # Remove currency symbols and spaces
    cleaned = amount_str.replace("$", "").replace("€", "").replace("£", "").replace(",", "").strip()

    # Handle negative amounts in parentheses
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]

    return float(cleaned)


class GenericCSVAdapter(BaseBankAdapter):
    """Generic adapter that can be configured for most CSV formats"""

    def parse_csv(self, file_path: str, account_type: Optional[str] = None) -> List[TransactionData]:
        """Parse CSV using configuration mapping

        Args:
            file_path: Path to CSV file
            account_type: Optional account type override (stored as bank_account field)
        """
        df = pd.read_csv(
            file_path,
            encoding=self.config.get("encoding", "utf-8"),
            sep=self.config.get("separator", ","),
            skiprows=self.config.get("skip_rows", 0)
        )

        transactions = []
        column_mapping = self.config["column_mapping"]

        for _, row in df.iterrows():
            try:
                # Parse date
                date_str = str(row[column_mapping["date"]])
                date = datetime.strptime(date_str, self.config["date_format"])

                # Parse amount
                amount_str = str(row[column_mapping["amount"]])
                amount = _parse_amount(amount_str)

                # Get other fields
                recipient = str(row[column_mapping["recipient"]])
                memo = str(row.get(column_mapping.get("memo", ""), "")) if column_mapping.get("memo") else ""

                # Get currency and balance if available
                currency = None
                balance = None
                if "currency" in column_mapping and column_mapping["currency"]:
                    currency = str(row.get(column_mapping["currency"], ""))
                if "balance" in column_mapping and column_mapping["balance"]:
                    try:
                        balance = float(row.get(column_mapping["balance"], ""))
                    except (ValueError, TypeError):
                        balance = None

                # Create raw data string for hashing
                raw_data = "|".join([str(row[col]) for col in row.index])

                # Use account_type override if provided, otherwise use bank_name
                bank_account_name = f"{self.bank_name} {account_type.upper()}" if account_type else self.bank_name

                transaction = TransactionData(
                    date=date,
                    bank_account=bank_account_name,
                    recipient=recipient,
                    memo=memo,
                    amount=amount,
                    currency=currency,
                    balance=balance,
                    recipient_account=None,  # Generic CSV doesn't have recipient account
                    recipient_bank_name=None,  # Generic CSV doesn't have recipient bank info
                    comment=None,  # Generic CSV doesn't have comment field
                    raw_data=raw_data
                )

                transactions.append(transaction)

            except (ValueError, KeyError) as e:
                print(f"Error parsing row {row}: {e}")
                continue

        return transactions


# Predefined configurations for common banks
BANK_CONFIGURATIONS = {
    "revolut": {
        "bank_name": "Revolut",
        "adapter_class": "RevolutAdapter"
    },
    "belfius": {
        "bank_name": "Belfius",
        "adapter_class": "BelfiusAdapter"
    },
    "kbc": {
        "bank_name": "KBC",
        "adapter_class": "KBCAdapter"
    },
}


class BankAdapterFactory:
    """Factory to create appropriate bank adapters"""

    @staticmethod
    def create_adapter(bank_name: str, custom_config: Optional[Dict] = None) -> BaseBankAdapter:
        """Create adapter for specified bank"""
        if custom_config:
            return GenericCSVAdapter(custom_config)

        bank_key = bank_name.lower().replace(" ", "_")
        if bank_key in BANK_CONFIGURATIONS:
            config = BANK_CONFIGURATIONS[bank_key]

            # Check if it's a specialized adapter
            if config.get("adapter_class") == "RevolutAdapter":
                return RevolutAdapter(config)
            elif config.get("adapter_class") == "BelfiusAdapter":
                return BelfiusAdapter(config)
            elif config.get("adapter_class") == "KBCAdapter":
                return KBCAdapter(config)
            else:
                return GenericCSVAdapter(config)

        raise ValueError(f"No configuration found for bank: {bank_name}")

    @staticmethod
    def get_supported_banks() -> List[str]:
        """Get list of supported banks"""
        return list(BANK_CONFIGURATIONS.keys())
