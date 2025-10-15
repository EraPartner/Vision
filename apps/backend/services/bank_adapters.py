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


class BelfiusAdapter(BaseBankAdapter):
    """Specialized adapter for Belfius CSV format"""

    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse Belfius CSV format (tab-separated)"""
        transactions = []

        with open(file_path, 'r', encoding='utf-8') as file:
            for line_num, line in enumerate(file, 1):
                try:
                    # Skip empty lines
                    line = line.strip()
                    if not line:
                        continue

                    # Split by tab (Belfius uses tab-separated format)
                    parts = line.split('\t')

                    # Belfius format has many fields, we need at least the core ones
                    if len(parts) < 12:
                        print(f"Skipping Belfius line {line_num}: insufficient columns ({len(parts)} < 12)")
                        continue

                    account_number = parts[0].strip()  # BE81 0637 5061 4024
                    # parts[2] and parts[3] seem to be codes (4, 20)
                    # parts[4] appears to be empty or contains additional info
                    recipient_account = parts[4].strip()  # Recipient account number - use this directly
                    recipient = parts[5].strip()  # BVBA KAZIMO
                    location = parts[7].strip()  # 3000 LEUVEN
                    long_description = parts[8].strip()  # Full transaction description
                    transaction_date = parts[9].strip()  # 13/05/2025
                    amount_str = parts[10].strip()  # -16
                    currency = parts[11].strip()  # EUR
                    # Additional fields may exist but we use the last one as memo

                    # Parse the transaction date (format: DD/MM/YYYY)
                    try:
                        date = datetime.strptime(transaction_date, "%d/%m/%Y")
                    except ValueError as e:
                        print(f"Error parsing Belfius date '{transaction_date}': {e}")
                        continue

                    # Parse amount
                    try:
                        amount = float(amount_str)
                    except ValueError as e:
                        print(f"Error parsing Belfius amount '{amount_str}': {e}")
                        continue

                    # Combine recipient with location if both exist
                    full_recipient = recipient
                    if location and location.strip():
                        full_recipient = f"{recipient} - {location}"

                    # Use the long description as memo
                    memo = long_description if long_description else ""

                    # Get comment from field 14 (parts[14]) for Belfius
                    comment = parts[14].strip() if len(parts) > 14 else ""

                    # Create transaction with recipient account number if available
                    transaction = TransactionData(
                        date=date,
                        bank_account="Belfius Checking Account",  # Map account number to readable name
                        recipient=full_recipient,
                        memo=memo,
                        amount=amount,
                        currency=currency,
                        balance=None,  # Belfius doesn't seem to provide balance in this format
                        recipient_account=recipient_account if recipient_account.strip() else None,
                        comment=comment if comment else None,
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
            for line_num, line in enumerate(file, 1):
                try:
                    # Skip empty lines
                    line = line.strip()
                    if not line:
                        continue

                    # Skip header line
                    if line_num == 1 and line.startswith('Type,'):
                        continue

                    # Split by comma (Revolut uses comma-separated format)
                    parts = line.split(',')

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
                        date = datetime.strptime(completed_date, "%Y-%m-%d %H:%M:%S").date()
                    except ValueError:
                        try:
                            # Try alternative format without seconds
                            date = datetime.strptime(completed_date, "%Y-%m-%d %H:%M").date()
                        except ValueError:
                            # Try date only
                            date = datetime.strptime(completed_date.split()[0], "%Y-%m-%d").date()

                    # Parse amount
                    amount = float(amount_str)

                    # Parse balance (optional)
                    balance = None
                    if balance_str and balance_str != '':
                        try:
                            balance = float(balance_str)
                        except ValueError:
                            balance = None

                    # Create transaction
                    transaction = TransactionData(
                        date=date,
                        bank_account="Revolut",
                        recipient=description,  # Use description as recipient (merchant name)
                        memo=f"{transaction_type} - {product}",  # Combine type and product for context
                        amount=amount,
                        currency=currency,
                        balance=balance,
                        comment=description,  # For Revolut, comment is same as description
                        raw_data=line
                    )

                    transactions.append(transaction)

                except (ValueError, IndexError) as e:
                    print(f"Error parsing Revolut line {line_num}: {e}")
                    print(f"Line content: {line}")
                    continue

        return transactions


class KBCAdapter(BaseBankAdapter):
    """Specialized adapter for KBC CSV format"""

    def parse_csv(self, file_path: str) -> List[TransactionData]:
        """Parse KBC CSV format (tab-separated)"""
        transactions = []

        with open(file_path, 'r', encoding='utf-8') as file:
            for line_num, line in enumerate(file, 1):
                try:
                    # Skip empty lines
                    line = line.strip()
                    if not line:
                        continue

                    # Split by tab (KBC uses tab-separated format)
                    parts = line.split('\t')

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

                    # Parse amount
                    try:
                        amount = float(amount_str)
                    except ValueError as e:
                        print(f"Error parsing KBC amount '{amount_str}': {e}")
                        continue

                    # Parse balance (optional)
                    balance = None
                    if balance_str and balance_str.strip():
                        try:
                            balance = float(balance_str)
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
    "chase": {
        "bank_name": "Chase",
        "encoding": "utf-8",
        "separator": ",",
        "skip_rows": 0,
        "date_format": "%m/%d/%Y",
        "column_mapping": {
            "date": "Transaction Date",
            "recipient": "Description",
            "memo": "Type",
            "amount": "Amount"
        }
    },
    "bank_of_america": {
        "bank_name": "Bank of America",
        "encoding": "utf-8",
        "separator": ",",
        "skip_rows": 0,
        "date_format": "%m/%d/%Y",
        "column_mapping": {
            "date": "Date",
            "recipient": "Payee",
            "memo": "Address",
            "amount": "Amount"
        }
    },
    "wells_fargo": {
        "bank_name": "Wells Fargo",
        "encoding": "utf-8",
        "separator": ",",
        "skip_rows": 0,
        "date_format": "%m/%d/%Y",
        "column_mapping": {
            "date": "Date",
            "recipient": "Description",
            "memo": "",
            "amount": "Amount"
        }
    }
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
