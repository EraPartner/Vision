"""Unit tests for Revolut bank adapter.

Tests the comprehensive extraction of all available fields from Revolut CSV format,
including transaction types, products, fees, state filtering, started/completed dates,
and error handling.
"""
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from services.bank_adapters import RevolutAdapter


class TestRevolutAdapter:
    """Test cases for Revolut CSV adapter."""

    @pytest.fixture
    def revolut_adapter(self):
        """Create a RevolutAdapter instance for testing."""
        config = {"bank_name": "Revolut"}
        return RevolutAdapter(config)

    @pytest.fixture
    def sample_revolut_csv_content(self):
        """Create sample Revolut CSV content with comprehensive fields matching actual structure.

        Revolut CSV structure:
        - Line 1: Column headers (comma-separated)
        - Line 2+: Transaction data
        """
        return """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-02-01 21:27:32,2026-02-02 11:28:17,Sardinha Rabina,-39.50,0.00,EUR,COMPLETED,113.74
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,John Doe,50.00,0.00,EUR,COMPLETED,153.24
ATM,Current,2026-01-31 15:30:00,2026-01-31 15:30:45,Cash Withdrawal,-100.00,2.50,EUR,COMPLETED,103.24
Exchange,Savings,2026-01-30 09:00:00,2026-01-30 09:01:15,EUR to USD,500.00,0.00,USD,COMPLETED,600.00
Card Payment,Current,2026-01-29 12:00:00,2026-01-29 12:00:30,Pending Store,-25.00,0.00,EUR,PENDING,50.00
"""

    @pytest.fixture
    def sample_csv_file(self, sample_revolut_csv_content):
        """Create a temporary CSV file for testing."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(sample_revolut_csv_content)
            temp_path = f.name
        yield temp_path
        # Cleanup
        Path(temp_path).unlink()

    def test_parse_csv_metadata_extraction(self, revolut_adapter, sample_csv_file):
        """Test extraction of transaction data from Revolut CSV."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Should have 4 completed transactions (PENDING is filtered out)
        assert len(transactions) == 4

    def test_parse_csv_state_filtering(self, revolut_adapter, sample_csv_file):
        """Test that PENDING transactions are filtered out."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Verify no PENDING transactions
        for txn in transactions:
            assert "State: COMPLETED" in txn.comment

    def test_parse_csv_account_type_detection_current(self, revolut_adapter, sample_csv_file):
        """Test account type detection for Current account."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # First three transactions are from Current account
        assert transactions[0].bank_account == "REVOLUT CURRENT"
        assert transactions[1].bank_account == "REVOLUT CURRENT"
        assert transactions[2].bank_account == "REVOLUT CURRENT"

    def test_parse_csv_account_type_detection_savings(self, revolut_adapter, sample_csv_file):
        """Test account type detection for Savings account."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Fourth transaction is from Savings account
        assert transactions[3].bank_account == "REVOLUT SAVINGS"

    def test_parse_csv_complete_transaction_fields(self, revolut_adapter, sample_csv_file):
        """Test that all transaction fields are extracted correctly."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Test first transaction (Card Payment)
        txn1 = transactions[0]
        assert txn1.date == datetime(2026, 2, 2, 11, 28, 17)
        assert txn1.bank_account == "REVOLUT CURRENT"
        assert "SARDINHA RABINA" in txn1.recipient
        assert txn1.amount == -39.50
        assert txn1.currency == "EUR"
        assert txn1.balance == 113.74
        assert txn1.recipient_account is None
        assert txn1.memo is not None

    def test_parse_csv_transaction_types(self, revolut_adapter, sample_csv_file):
        """Test extraction of different transaction types."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        assert "Type: Card Payment" in transactions[0].comment
        assert "Type: Transfer" in transactions[1].comment
        assert "Type: ATM" in transactions[2].comment
        assert "Type: Exchange" in transactions[3].comment

    def test_parse_csv_comment_field_structure(self, revolut_adapter, sample_csv_file):
        """Test that comment field contains all metadata in structured format."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Check all transactions have structured comments
        for txn in transactions:
            assert txn.comment is not None
            # Should contain type
            assert "Type:" in txn.comment
            # Should contain product
            assert "Product:" in txn.comment
            # Should contain state
            assert "State: COMPLETED" in txn.comment

    def test_parse_csv_fee_extraction(self, revolut_adapter, sample_csv_file):
        """Test extraction of transaction fees."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # First transaction has no fee (0.00)
        assert "Fee:" not in transactions[0].comment

        # Third transaction (ATM) has a fee
        assert "Fee: 2.50 EUR" in transactions[2].comment

    def test_parse_csv_processing_time_calculation(self, revolut_adapter, sample_csv_file):
        """Test calculation of processing time between started and completed dates."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # First transaction has significant time difference (started at 21:27, completed at 11:28 next day)
        txn1 = transactions[0]
        assert "Processing Time:" in txn1.comment
        assert "Started: 2026-02-01 21:27:32" in txn1.comment

    def test_parse_csv_recipient_name_extraction(self, revolut_adapter, sample_csv_file):
        """Test recipient name extraction and normalization."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # All transactions should have recipient names
        for txn in transactions:
            assert txn.recipient is not None
            # Should be normalized to uppercase
            assert txn.recipient == txn.recipient.upper()

    def test_parse_csv_amount_parsing(self, revolut_adapter, sample_csv_file):
        """Test correct parsing of amounts."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        assert transactions[0].amount == -39.50  # Negative (expense)
        assert transactions[1].amount == 50.00  # Positive (income)
        assert transactions[2].amount == -100.00  # Negative (withdrawal)
        assert transactions[3].amount == 500.00  # Positive (exchange)

    def test_parse_csv_balance_parsing(self, revolut_adapter, sample_csv_file):
        """Test correct parsing of balance values."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        assert transactions[0].balance == 113.74
        assert transactions[1].balance == 153.24
        assert transactions[2].balance == 103.24
        assert transactions[3].balance == 600.00

    def test_parse_csv_memo_structure(self, revolut_adapter, sample_csv_file):
        """Test memo field structure (Type - Product)."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        assert transactions[0].memo == "CARD PAYMENT - CURRENT"
        assert transactions[1].memo == "TRANSFER - CURRENT"
        assert transactions[2].memo == "ATM - CURRENT"
        assert transactions[3].memo == "EXCHANGE - SAVINGS"

    def test_parse_csv_malformed_date(self, revolut_adapter):
        """Test handling of malformed date values."""
        csv_content = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-02-01 21:27:32,INVALID_DATE,Test Merchant,-39.50,0.00,EUR,COMPLETED,113.74
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,Valid Transaction,50.00,0.00,EUR,COMPLETED,153.24
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            # Should skip the malformed line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == 50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_malformed_amount(self, revolut_adapter):
        """Test handling of malformed amount values."""
        csv_content = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-02-01 21:27:32,2026-02-02 11:28:17,Test Merchant,INVALID,0.00,EUR,COMPLETED,113.74
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,Valid Transaction,50.00,0.00,EUR,COMPLETED,153.24
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            # Should skip the malformed line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == 50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_insufficient_columns(self, revolut_adapter):
        """Test handling of rows with insufficient columns."""
        csv_content = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-02-01
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,Valid Transaction,50.00,0.00,EUR,COMPLETED,153.24
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            # Should skip the insufficient column line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == 50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_empty_file(self, revolut_adapter):
        """Test handling of empty CSV file."""
        csv_content = ""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            assert len(transactions) == 0
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_normalization_to_uppercase(self, revolut_adapter, sample_csv_file):
        """Test that all text fields are normalized to uppercase."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            # Recipient should be uppercase
            if txn.recipient:
                assert txn.recipient == txn.recipient.upper()

            # Memo should be uppercase
            if txn.memo:
                assert txn.memo == txn.memo.upper()

            # Bank account should be uppercase
            assert txn.bank_account == txn.bank_account.upper()

    def test_parse_csv_raw_data_preservation(self, revolut_adapter, sample_csv_file):
        """Test that raw CSV line is preserved for deduplication."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.raw_data is not None
            assert len(txn.raw_data) > 0
            # Should contain commas (CSV delimiter)
            assert ',' in txn.raw_data

    def test_parse_csv_date_normalization_in_raw_data(self, revolut_adapter, sample_csv_file):
        """Test that raw data has normalized dates for consistent deduplication."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Raw data should have dates normalized to YYYY-MM-DD format
        for txn in transactions:
            # Check that started_date and completed_date are normalized
            parts = txn.raw_data.split(',')
            # Started date (index 2) should be YYYY-MM-DD
            assert parts[2] == txn.date.strftime("%Y-%m-%d")
            # Completed date (index 3) should be YYYY-MM-DD
            assert parts[3] == txn.date.strftime("%Y-%m-%d")

    def test_determine_account_type_current(self, revolut_adapter):
        """Test account type determination for Current account."""
        account_type = revolut_adapter._determine_account_type("Current")
        assert account_type == "REVOLUT CURRENT"

    def test_determine_account_type_savings(self, revolut_adapter):
        """Test account type determination for Savings account."""
        account_type = revolut_adapter._determine_account_type("Savings")
        assert account_type == "REVOLUT SAVINGS"

    def test_determine_account_type_generic(self, revolut_adapter):
        """Test account type determination for unknown product."""
        account_type = revolut_adapter._determine_account_type("Crypto")
        assert account_type == "REVOLUT CRYPTO"

    def test_parse_csv_multiple_transactions_ordering(self, revolut_adapter, sample_csv_file):
        """Test that transactions are returned in the order they appear in CSV."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        # Verify chronological order as in CSV (based on completed dates)
        assert transactions[0].date == datetime(2026, 2, 2, 11, 28, 17)
        assert transactions[1].date == datetime(2026, 2, 1, 10, 5, 30)
        assert transactions[2].date == datetime(2026, 1, 31, 15, 30, 45)
        assert transactions[3].date == datetime(2026, 1, 30, 9, 1, 15)

    def test_parse_csv_currency_extraction(self, revolut_adapter, sample_csv_file):
        """Test that currency is correctly extracted."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        assert transactions[0].currency == "EUR"
        assert transactions[1].currency == "EUR"
        assert transactions[2].currency == "EUR"
        assert transactions[3].currency == "USD"

    def test_parse_csv_no_recipient_account(self, revolut_adapter, sample_csv_file):
        """Test that Revolut transactions have no recipient account (not provided)."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.recipient_account is None

    def test_parse_csv_no_recipient_address(self, revolut_adapter, sample_csv_file):
        """Test that Revolut transactions have no recipient address (not provided)."""
        transactions = revolut_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.recipient_address is None

    def test_parse_csv_alternative_date_format(self, revolut_adapter):
        """Test handling of alternative date formats."""
        csv_content = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,01/02/2026 21:27:32,02/02/2026 11:28:17,Test Merchant,-39.50,0.00,EUR,COMPLETED,113.74
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            assert len(transactions) == 1
            assert transactions[0].date == datetime(2026, 2, 2, 11, 28, 17)
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_zero_balance(self, revolut_adapter):
        """Test handling of zero balance."""
        csv_content = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,Test Transaction,-50.00,0.00,EUR,COMPLETED,0.00
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            assert len(transactions) == 1
            assert transactions[0].balance == 0.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_same_started_completed_date(self, revolut_adapter):
        """Test handling when started and completed dates are the same."""
        csv_content = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:00:00,Instant Transfer,50.00,0.00,EUR,COMPLETED,150.00
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = revolut_adapter.parse_csv(temp_path)
            assert len(transactions) == 1
            # Processing time should not be in comment if dates are the same
            assert "Processing Time:" not in transactions[0].comment
        finally:
            Path(temp_path).unlink()
