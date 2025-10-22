import csv
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Any

import pandas as pd


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
    comment: Optional[str] = None  # Additional comment field for bank-specific data
    raw_data: str = ""  # Original CSV row for hashing


class BaseBankAdapter(ABC):
    """Abstract base class for bank adapters"""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.bank_name = config.get("bank_name", "Unknown")

    @abstractmethod
    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse CSV file and return list of standardized transactions"""
        pass

    def _create_hash(self, raw_data: str) -> str:
        """Create hash for deduplication"""
        return hashlib.sha256(raw_data.encode()).hexdigest()

    def _clean_recipient_name(self, recipient: str) -> str:
        """
        Clean recipient name by removing common prefixes and suffixes
        that don't add value (e.g., 'Payment from ', 'To ', 'From ')
        """
        if not recipient:
            return recipient

        # List of prefixes to remove (case-insensitive)
        prefixes_to_remove = [
            "Payment from ",
            "Payment to ",
            "From ",
            "To ",
            "Transfer from ",
            "Transfer to ",
            "Sent to ",
            "Received from ",
        ]

        cleaned = recipient.strip()

        # Remove prefixes (case-insensitive)
        for prefix in prefixes_to_remove:
            if cleaned.lower().startswith(prefix.lower()):
                cleaned = cleaned[len(prefix):].strip()
                break  # Only remove one prefix

        return cleaned


class BelfiusAdapter(BaseBankAdapter):
    """Specialized adapter for Belfius CSV format"""

    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse Belfius CSV format (semicolon-separated)"""
        transactions = []
        last_balance = None

        with open(file_path, 'r', encoding='utf-8') as file:
            lines = file.readlines()

            # Extract the last balance from line 10 (index 9): "Laatste saldo;0,00 EUR"
            if len(lines) > 9:
                balance_line = lines[9].strip()
                if balance_line.startswith("Laatste saldo;"):
                    balance_str = balance_line.split(';')[1].replace(' EUR', '').replace(',', '.')
                    try:
                        last_balance = float(balance_str)
                    except ValueError:
                        pass

            # Skip metadata lines (first 13 lines) and header line (line 14)
            # Actual data starts at line 15 (index 14)
            for line_num, line in enumerate(lines[14:], start=15):
                try:
                    # Skip empty lines
                    line = line.strip()
                    if not line:
                        continue

                    # Split by semicolon
                    parts = line.split(';')

                    # Belfius format has 15 columns
                    if len(parts) < 12:
                        print(f"Skipping Belfius line {line_num}: insufficient columns ({len(parts)} < 12)")
                        continue

                    # Column mapping based on the example:
                    # 0: Rekening (Account number)
                    # 1: Boekingsdatum (Transaction date)
                    # 2: Rekeninguittrekselnummer (Statement number)
                    # 3: Transactienummer (Transaction number)
                    # 4: Rekening tegenpartij (Recipient account)
                    # 5: Naam tegenpartij bevat (Recipient name)
                    # 6: Straat en nummer (Street and number)
                    # 7: Postcode en plaats (Postal code and place)
                    # 8: Transactie (Transaction description)
                    # 9: Valutadatum (Value date)
                    # 10: Bedrag (Amount)
                    # 11: Devies (Currency)
                    # 12: BIC
                    # 13: Landcode (Country code)
                    # 14: Mededelingen (Additional messages)

                    account_number = parts[0].strip()
                    transaction_date = parts[1].strip()
                    recipient_account = parts[4].strip()
                    recipient = parts[5].strip()
                    street = parts[6].strip()
                    location = parts[7].strip()
                    transaction_description = parts[8].strip()
                    amount_str = parts[10].strip()
                    currency = parts[11].strip()
                    additional_message = parts[14].strip() if len(parts) > 14 else ""

                    # Parse the transaction date (format: DD/MM/YYYY)
                    try:
                        date = datetime.strptime(transaction_date, "%d/%m/%Y")
                    except ValueError as e:
                        print(f"Error parsing Belfius date '{transaction_date}': {e}")
                        continue

                    # Parse amount (format: -8,70 needs to become -8.70)
                    try:
                        amount = float(amount_str.replace(',', '.'))
                    except ValueError as e:
                        print(f"Error parsing Belfius amount '{amount_str}': {e}")
                        continue

                    # Build full recipient name
                    full_recipient = recipient

                    # If recipient is empty, use transaction description
                    if not full_recipient:
                        full_recipient = transaction_description

                    # Clean the recipient name
                    full_recipient = self._clean_recipient_name(full_recipient)

                    # Use transaction description as memo
                    memo = transaction_description if transaction_description else ""

                    # Use additional message as comment if available
                    comment = additional_message if additional_message else None

                    # Create transaction
                    transaction = TransactionData(
                        date=date,
                        bank_account="Belfius Checking Account",
                        recipient=full_recipient,
                        memo=memo,
                        amount=amount,
                        currency=currency,
                        balance=last_balance,  # Use the last balance from header
                        recipient_account=recipient_account if recipient_account else None,
                        comment=comment,
                        raw_data=line
                    )

                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    print(f"Error parsing Belfius line {line_num}: {e}")
                    print(f"Line content: {line}")
                    continue

        return transactions


class RevolutAdapter(BaseBankAdapter):
    """Specialized adapter for Revolut CSV format"""

    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse Revolut CSV format (comma-separated)"""
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
                        continue

                    # Revolut format: Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance
                    if len(parts) < 10:
                        print(f"Skipping line {line_num}: insufficient columns ({len(parts)} < 10)")
                        continue

                    transaction_type = parts[0].strip()
                    product = parts[1].strip()
                    started_date = parts[2].strip()
                    completed_date = parts[3].strip()  # This is the date we want to store
                    description = parts[4].strip()
                    amount_str = parts[5].strip()
                    fee_str = parts[6].strip()
                    currency = parts[7].strip()
                    state = parts[8].strip()
                    balance_str = parts[9].strip()

                    # Skip PENDING transactions - we only want COMPLETED ones
                    if state.upper() == 'PENDING':
                        continue

                    # Skip transactions without a completed date
                    if not completed_date or completed_date.strip() == '':
                        print(f"Skipping line {line_num}: no completed date (status: {state})")
                        continue

                    # Parse the completed date (format: YYYY-MM-DD HH:MM:SS)
                    # We only want the date part, not the time
                    try:
                        date = datetime.strptime(completed_date, "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        try:
                            # Try alternative format
                            date = datetime.strptime(completed_date, "%d/%m/%Y %H:%M:%S")
                        except ValueError:
                            try:
                                # Try alternative format without seconds
                                date = datetime.strptime(completed_date, "%Y-%m-%d %H:%M")
                            except ValueError:
                                # Try date only
                                date = datetime.strptime(completed_date.split()[0], "%Y-%m-%d")

                    # Parse amount
                    amount = float(amount_str)

                    # Parse balance (optional)
                    balance = None
                    if balance_str and balance_str != '':
                        try:
                            balance = float(balance_str)
                        except ValueError:
                            balance = None

                    # Clean the recipient/description name
                    cleaned_description = self._clean_recipient_name(description)

                    # Create raw data string for hashing (join the original parts)
                    raw_data = ','.join(parts)

                    # Create transaction
                    transaction = TransactionData(
                        date=date,
                        bank_account="Revolut",
                        recipient=cleaned_description,  # Use cleaned description as recipient
                        memo=f"{transaction_type} - {product}",  # Combine type and product for context
                        amount=amount,
                        currency=currency,
                        balance=balance,
                        comment=description,  # For Revolut, comment is same as description
                        raw_data=raw_data
                    )

                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    print(f"Error parsing Revolut line {line_num}: {e}")
                    print(f"Line content: {parts}")
                    continue

        return transactions


class KBCAdapter(BaseBankAdapter):
    """Specialized adapter for KBC CSV format"""

    def _clean_kbc_recipient_name(self, recipient: str) -> str:
        """
        Clean KBC recipient names by extracting the main transaction type.

        Examples:
        - "GELDOPNEMING VIA BANCONTACT 26-09..." -> "Geldopneming"
        - "OVERSCHRIJVING NAAR BE12..." -> "Overschrijving"
        - "DOMICILIËRING VAN XYZ..." -> "Domiciliëring"
        - "AANKOOP MET DEBETKAART..." -> "Aankoop"
        """
        if not recipient:
            return recipient

        recipient = recipient.strip()

        # Common KBC transaction type keywords (first word or phrase)
        # These are typically at the start of the description
        kbc_transaction_types = [
            "GELDOPNEMING",
            "OVERSCHRIJVING",
            "DOMICILIËRING",
            "DOMICILIERING",
            "AANKOOP",
            "TERUGBETALING",
            "STORTING",
            "AFHALING",
            "BETALING",
            "RETRO-SEPA",
            "SEPA",
            "EUROPESE",
            "INTERNATIONALE",
        ]

        # Check if it starts with a known transaction type
        upper_recipient = recipient.upper()
        for trans_type in kbc_transaction_types:
            if upper_recipient.startswith(trans_type):
                # Return just the transaction type, properly capitalized
                return trans_type.capitalize()

        # If no match, try to extract the first meaningful word/phrase before common separators
        # Look for patterns like "WORD VIA", "WORD NAAR", "WORD VAN", "WORD MET"
        separators = [" VIA ", " NAAR ", " VAN ", " MET ", " DOOR ", " OP ", " OM "]
        for separator in separators:
            if separator in upper_recipient:
                first_part = recipient.split(separator, 1)[0].strip()
                return first_part.capitalize()

        # If still no match, take only the first word if it's long enough to be meaningful
        first_word = recipient.split()[0] if recipient.split() else recipient
        if len(first_word) > 3:  # Only use if it's a substantial word
            return first_word.capitalize()

        # Fallback: take first 2-3 words if they form a meaningful phrase
        words = recipient.split()[:3]
        if words:
            return " ".join(words).capitalize()

        return recipient

    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse KBC CSV format (semicolon-separated)"""
        transactions = []

        with open(file_path, 'r', encoding='utf-8') as file:
            for line_num, line in enumerate(file, 1):
                try:
                    # Skip empty lines
                    line = line.strip()
                    if not line:
                        continue

                    # Skip header line (starts with "Rekeningnummer")
                    if line.endswith("Vrije Mededeling,,,,,,,,,,,,,,,,,,") or line.startswith("Rekeningnummer"):
                        continue

                    if line.startswith(",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,"):
                        continue

                    # Split by semicolon (KBC uses semicolon-separated format)
                    parts = line.split(';')

                    # KBC format needs at least the core fields
                    if len(parts) < 15:
                        print(f"Skipping KBC line {line_num}: insufficient columns ({len(parts)} < 15)")
                        continue

                    # Map the fields based on your examples:
                    # Checking: BE61734041478017 - Account identifier (parts[0])
                    # Savings:  BE34744010767090 - Account identifier (parts[0])
                    # Empty field (parts[1])
                    # BRICHAU IBE - Account holder/description (parts[2])
                    # EUR - Currency (parts[3])
                    # Reference number (parts[4])
                    # Transaction date (parts[5])
                    # Memo/Description (parts[6])
                    # Value date (parts[7])
                    # Amount (parts[8])
                    # Account balance (parts[9])
                    # Additional amount field (parts[10])
                    # Empty or additional field (parts[11])
                    # Recipient account (parts[12])
                    # Bank code (parts[13])
                    # Recipient name (parts[14])
                    # Address/Location (parts[15] if exists)
                    # Additional info (parts[16] if exists)

                    account_identifier = parts[0].strip()
                    currency = parts[3].strip()
                    memo = parts[6].strip()
                    transaction_date = parts[7].strip()
                    amount_str = parts[8].strip()
                    balance_str = parts[9].strip()
                    recipient_account = parts[12].strip() if len(parts) > 12 else ""
                    bank_code = parts[13].strip() if len(parts) > 13 else ""
                    recipient_name = parts[14].strip() if len(parts) > 14 else ""

                    # Handle additional fields for savings account format
                    address = parts[15].strip() if len(parts) > 15 else ""
                    additional_info = parts[17].strip() if len(parts) > 17 else ""

                    # Parse the transaction date (format: DD/MM/YYYY)
                    try:
                        date = datetime.strptime(transaction_date, "%d/%m/%Y")
                    except ValueError as e:
                        print(f"Error parsing KBC date '{transaction_date}': {e}")
                        continue

                    # Parse amount (KBC uses comma as decimal separator, convert to dot)
                    try:
                        amount = float(amount_str.replace(',', '.'))
                    except ValueError as e:
                        print(f"Error parsing KBC amount '{amount_str}': {e}")
                        continue

                    # Parse balance (optional, also uses comma as decimal separator)
                    balance = None
                    if balance_str and balance_str.strip():
                        try:
                            balance = float(balance_str.replace(',', '.'))
                        except ValueError:
                            balance = None

                    # Determine account type from the account identifier
                    # Based on your examples:
                    # Checking: BE61734041478017 (starts with BE61 or similar pattern)
                    # Savings:  BE34744010767090 (starts with BE34 or similar pattern)
                    if account_identifier.startswith("BE61"):
                        account_type = "KBC Checking Account"
                    elif account_identifier.startswith("BE34"):
                        account_type = "KBC Savings Account"
                    else:
                        # Generic fallback - you can refine this pattern as needed
                        account_type = "KBC Account"

                    # Build full recipient name with address for savings accounts
                    final_recipient = recipient_name
                    if address and address.strip():
                        final_recipient = f"{recipient_name}, {address}"

                    # If recipient name is empty, fallback to memo
                    if not final_recipient:
                        final_recipient = memo

                    # Clean the recipient name using KBC-specific logic
                    final_recipient = self._clean_kbc_recipient_name(final_recipient)

                    # Get comment from field 17 (parts[17]) for KBC - this is the additional_info field
                    comment = additional_info if additional_info else None

                    # Create transaction
                    transaction = TransactionData(
                        date=date,
                        bank_account=account_type,
                        recipient=final_recipient,
                        memo=memo,
                        amount=amount,
                        currency=currency,
                        balance=balance,
                        recipient_account=recipient_account if recipient_account else None,
                        comment=comment,
                        raw_data=line
                    )

                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    print(f"Error parsing KBC line {line_num}: {e}")
                    print(f"Line content: {line}")
                    continue

        return transactions


class GenericCSVAdapter(BaseBankAdapter):
    """Generic adapter that can be configured for most CSV formats"""

    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse CSV using configuration mapping"""
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
                amount = self._parse_amount(amount_str)

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

                transaction = TransactionData(
                    date=date,
                    bank_account=self.bank_name,
                    recipient=recipient,
                    memo=memo,
                    amount=amount,
                    currency=currency,
                    balance=balance,
                    raw_data=raw_data
                )

                transactions.append(transaction)

            except (ValueError, KeyError) as e:
                print(f"Error parsing row {row}: {e}")
                continue

        return transactions

    def _parse_amount(self, amount_str: str) -> float:
        """Parse amount string to float, handling various formats"""
        # Remove currency symbols and spaces
        cleaned = amount_str.replace("$", "").replace("€", "").replace("£", "").replace(",", "").strip()

        # Handle negative amounts in parentheses
        if cleaned.startswith("(") and cleaned.endswith(")"):
            cleaned = "-" + cleaned[1:-1]

        return float(cleaned)


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
