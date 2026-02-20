"""Unit tests for Belfius bank adapter.

Tests the comprehensive extraction of all available fields from Belfius CSV format,
including metadata extraction, transaction parsing, account type detection, and
error handling.
"""
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from services.bank_adapters import BelfiusAdapter


class TestBelfiusAdapter:
    """Test cases for Belfius CSV adapter."""

    @pytest.fixture
    def belfius_adapter(self):
        """Create a BelfiusAdapter instance for testing."""
        config = {"bank_name": "Belfius"}
        return BelfiusAdapter(config)

    @pytest.fixture
    def sample_belfius_csv_content(self):
        """Create sample Belfius CSV content with comprehensive fields matching actual structure.

        Actual Belfius CSV structure:
        - Lines 0-8: Filter parameters (9 lines)
        - Line 9: Last balance
        - Line 10: Balance timestamp
        - Line 11: Empty separator
        - Line 12: Column headers
        - Line 13+: Transaction data
        """
        return """Boekingsdatum vanaf; Boekingsdatum tot en met; Bedrag vanaf; Bedrag tot en met; Rekeninguittrekselnummer vanaf; Rekeninguittrekselnummer tot en met; Mededeling; Naam tegenpartij bevat; Rekening tegenpartij;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
Laatste saldo;1234,56 EUR
Datum/uur van het laatste saldo;19/02/2026 12:46:57 ;

Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;24/11/2025;00010;52;;Bancontact Payconiq Co;;3200  Aarschot;BANCONTACT - AANKOOP - Bancontact Payconiq Co - 3200   Aarschot BE - 22/11/25 13:43 - Payment Description -   VIA INTERNET - KAART 5169 20XX XXXX 7077 - ff df REF. : 0700000408807 VAL. 22-11;22/11/2025;-67,90;EUR;;BE;BANCONTACT - AANKOOP - Bancontact Payconiq Co - 3200   Aarschot BE - 22/11/25 13:43 - Payment Description -   VIA INTERNET - KAART 5169 20XX XXXX 7077 - ff df REF. : 0700000408807 VAL. 22-11
BE81 0637 5694 4024;23/11/2025;00010;51;BE12 3456 7890 1234;TEST RECIPIENT SA;Rue de la Paix 123;1000 Brussels;VIREMENT - TEST PAYMENT;23/11/2025;-150,00;EUR;GEBABEBB;BE;Monthly subscription payment
BE81 0637 5694 4024;22/11/2025;00010;50;;SALARY PAYMENT;;1000 Brussels;VIREMENT SALAIRE;20/11/2025;2500,00;EUR;;BE;Salary for November 2025
"""

    @pytest.fixture
    def sample_csv_file(self, sample_belfius_csv_content):
        """Create a temporary CSV file for testing."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(sample_belfius_csv_content)
            temp_path = f.name
        yield temp_path
        # Cleanup
        Path(temp_path).unlink()

    def test_parse_csv_metadata_extraction(self, belfius_adapter, sample_csv_file):
        """Test extraction of metadata from CSV header (balance and timestamp)."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # All transactions should have the balance from the header
        assert len(transactions) == 3
        for txn in transactions:
            assert txn.balance == 1234.56

    def test_parse_csv_complete_transaction_fields(self, belfius_adapter, sample_csv_file):
        """Test that all transaction fields are extracted correctly."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # Test first transaction (Bancontact payment)
        txn1 = transactions[0]
        assert txn1.date == datetime(2025, 11, 24)
        assert txn1.bank_account == "BELFIUS"
        assert "BANCONTACT PAYCONIQ CO" in txn1.recipient
        assert txn1.amount == -67.90
        assert txn1.currency == "EUR"
        assert txn1.balance == 1234.56
        assert txn1.recipient_account is None or txn1.recipient_account == ""
        # Address keeps original case (not normalized to uppercase)
        assert txn1.recipient_address is None or "3200" in txn1.recipient_address and "Aarschot" in txn1.recipient_address
        assert txn1.memo is not None
        assert "BANCONTACT" in txn1.memo

    def test_parse_csv_comment_field_structure(self, belfius_adapter, sample_csv_file):
        """Test that comment field contains all metadata in structured format."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # Test second transaction with complete metadata
        txn2 = transactions[1]
        assert txn2.comment is not None

        # Verify comment contains all expected components
        assert "Statement: 00010" in txn2.comment
        assert "Transaction: 51" in txn2.comment
        # Value date same as booking date, so should not be in comment
        assert "BIC: GEBABEBB" in txn2.comment
        assert "Country: BE" in txn2.comment

    def test_parse_csv_value_date_different_from_booking(self, belfius_adapter, sample_csv_file):
        """Test handling of value date when it differs from booking date."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # Third transaction has different value date (20/11 vs 22/11)
        txn3 = transactions[2]
        assert txn3.date == datetime(2025, 11, 22)
        assert txn3.comment is not None
        assert "Value Date: 20/11/2025" in txn3.comment

    def test_parse_csv_recipient_name_extraction(self, belfius_adapter, sample_csv_file):
        """Test recipient name extraction and normalization."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # Transaction with explicit recipient name
        txn2 = transactions[1]
        assert "TEST RECIPIENT SA" in txn2.recipient

        # Transaction without recipient name (should use memo)
        txn1 = transactions[0]
        assert txn1.recipient is not None
        # Should be normalized to uppercase
        assert txn1.recipient == txn1.recipient.upper()

    def test_parse_csv_recipient_address_combination(self, belfius_adapter, sample_csv_file):
        """Test combination of street and location into full address."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # Transaction with both street and location
        txn2 = transactions[1]
        assert txn2.recipient_address is not None
        assert "Rue de la Paix 123" in txn2.recipient_address
        assert "1000 Brussels" in txn2.recipient_address
        assert "," in txn2.recipient_address  # Should be comma-separated

    def test_parse_csv_account_type_detection(self, belfius_adapter, sample_csv_file):
        """Test automatic account type detection from account number."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # All transactions should have account type determined
        for txn in transactions:
            assert txn.bank_account == "BELFIUS"
            assert txn.bank_account == txn.bank_account.upper()

    def test_parse_csv_amount_parsing(self, belfius_adapter, sample_csv_file):
        """Test correct parsing of amounts with comma decimal separator."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        assert transactions[0].amount == -67.90  # Negative amount
        assert transactions[1].amount == -150.00  # Negative amount
        assert transactions[2].amount == 2500.00  # Positive amount

    def test_parse_csv_empty_optional_fields(self, belfius_adapter):
        """Test handling of empty optional fields (BIC, country, recipient account)."""
        csv_content = """Boekingsdatum vanaf; Boekingsdatum tot en met;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
Laatste saldo;0,00 EUR
Datum/uur van het laatste saldo;19/02/2026 12:46:57 ;

Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;24/11/2025;00010;52;;;;;Test transaction;22/11/2025;-67,90;EUR;;;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = belfius_adapter.parse_csv(temp_path)
            assert len(transactions) == 1

            txn = transactions[0]
            # Optional fields should be None or empty
            assert txn.recipient_account is None or txn.recipient_account == ""
            assert txn.recipient_address is None
            # Comment should still have structure but without BIC/country
            assert txn.comment is not None
            assert "Statement: 00010" in txn.comment
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_malformed_date(self, belfius_adapter):
        """Test handling of malformed date values."""
        csv_content = """Boekingsdatum vanaf; Boekingsdatum tot en met;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
Laatste saldo;0,00 EUR
Datum/uur van het laatste saldo;19/02/2026 12:46:57 ;

Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;INVALID_DATE;00010;52;;Test;;Brussels;Test transaction;22/11/2025;-67,90;EUR;;BE;
BE81 0637 5694 4024;24/11/2025;00010;53;;Test2;;Brussels;Test transaction 2;22/11/2025;-50,00;EUR;;BE;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = belfius_adapter.parse_csv(temp_path)
            # Should skip the malformed line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].date == datetime(2025, 11, 24)
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_malformed_amount(self, belfius_adapter):
        """Test handling of malformed amount values."""
        csv_content = """Boekingsdatum vanaf; Boekingsdatum tot en met;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
Laatste saldo;0,00 EUR
Datum/uur van het laatste saldo;19/02/2026 12:46:57 ;

Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;24/11/2025;00010;52;;Test;;Brussels;Test transaction;22/11/2025;INVALID;EUR;;BE;
BE81 0637 5694 4024;24/11/2025;00010;53;;Test2;;Brussels;Test transaction 2;22/11/2025;-50,00;EUR;;BE;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = belfius_adapter.parse_csv(temp_path)
            # Should skip the malformed line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == -50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_insufficient_columns(self, belfius_adapter):
        """Test handling of rows with insufficient columns."""
        csv_content = """Boekingsdatum vanaf; Boekingsdatum tot en met;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
Laatste saldo;0,00 EUR
Datum/uur van het laatste saldo;19/02/2026 12:46:57 ;

Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;24/11/2025
BE81 0637 5694 4024;24/11/2025;00010;53;;Test2;;Brussels;Test transaction 2;22/11/2025;-50,00;EUR;;BE;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = belfius_adapter.parse_csv(temp_path)
            # Should skip the insufficient column line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == -50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_empty_file(self, belfius_adapter):
        """Test handling of empty CSV file."""
        csv_content = ""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = belfius_adapter.parse_csv(temp_path)
            assert len(transactions) == 0
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_missing_balance_metadata(self, belfius_adapter):
        """Test handling when balance metadata is missing or malformed."""
        csv_content = """Boekingsdatum vanaf; Boekingsdatum tot en met;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;



Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;24/11/2025;00010;52;;Test;;Brussels;Test transaction;22/11/2025;-67,90;EUR;;BE;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = belfius_adapter.parse_csv(temp_path)
            # Should still process transactions even without balance metadata
            assert len(transactions) == 1
            assert transactions[0].balance is None
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_normalization_to_uppercase(self, belfius_adapter, sample_csv_file):
        """Test that all text fields are normalized to uppercase."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            # Recipient should be uppercase
            if txn.recipient:
                assert txn.recipient == txn.recipient.upper()

            # Memo should be uppercase
            if txn.memo:
                assert txn.memo == txn.memo.upper()

            # Bank account should be uppercase
            assert txn.bank_account == txn.bank_account.upper()

    def test_parse_csv_raw_data_preservation(self, belfius_adapter, sample_csv_file):
        """Test that raw CSV line is preserved for deduplication."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.raw_data is not None
            assert len(txn.raw_data) > 0
            # Should contain semicolons (CSV delimiter)
            assert ';' in txn.raw_data

    def test_determine_account_type_default(self, belfius_adapter):
        """Test account type determination with default case."""
        account_type = belfius_adapter._determine_account_type("BE81 0637 5694 4024")
        assert account_type == "BELFIUS"

    def test_determine_account_type_without_spaces(self, belfius_adapter):
        """Test account type determination with account number without spaces."""
        account_type = belfius_adapter._determine_account_type("BE81063756944024")
        assert account_type == "BELFIUS"

    def test_parse_csv_multiple_transactions_ordering(self, belfius_adapter, sample_csv_file):
        """Test that transactions are returned in the order they appear in CSV."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        # Verify chronological order as in CSV
        assert transactions[0].date == datetime(2025, 11, 24)
        assert transactions[1].date == datetime(2025, 11, 23)
        assert transactions[2].date == datetime(2025, 11, 22)

    def test_parse_csv_currency_extraction(self, belfius_adapter, sample_csv_file):
        """Test that currency is correctly extracted."""
        transactions = belfius_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.currency == "EUR"
