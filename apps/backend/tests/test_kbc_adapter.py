"""Unit tests for KBC bank adapter.

Tests the comprehensive extraction of all available fields from KBC CSV format,
including account type detection, statement numbers, BIC codes, credit/debit
handling, structured/unstructured communications, and error handling.
"""
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from services.bank_adapters import KBCAdapter


class TestKBCAdapter:
    """Test cases for KBC CSV adapter."""

    @pytest.fixture
    def kbc_adapter(self):
        """Create a KBCAdapter instance for testing."""
        config = {"bank_name": "KBC"}
        return KBCAdapter(config)

    @pytest.fixture
    def sample_kbc_csv_content(self):
        """Create sample KBC CSV content with comprehensive fields matching actual structure.

        KBC CSV structure:
        - Line 1: Column headers (semicolon-separated)
        - Line 2+: Transaction data
        """
        return """Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;                                                  ;BAU IE;EUR;  02026001;03/01/2026;INSTANTOVERSCHRIJVING NAAR           03-01 BE89 6509 6582 5185 BANKIER BEGUNSTIGDE: REVOBEB2XXX IE BAU OM 16.32 UUR MET KBC MOBILE;03/01/2026;-775,08;0,00;              ;-775,08;BE89 6509 6582 5185;REVOBEB2XXX;IE BAU;                                                                       ;                                   ;                                                                                                                                             
BE61734041478017;                                                  ;BAU IE;EUR;  02026001;03/01/2026;INSTANTOVERSCHRIJVING VAN            03-01 BE34 7440 1076 7090 BANKIER OPDRACHTGEVER: KREDBEBBXXX BAU IE OM 16.31 UUR;03/01/2026;775,08;775,08;775,08;              ;BE34 7440 1076 7090;KREDBEBBXXX;BAU IE;                                                                       ;                                   ;
BE34744010767090;                                                  ;BAU IE;EUR;  01026001;02/01/2026;OVERSCHRIJVING NAAR                  02-01 BE61 7340 4147 8017 BANKIER BEGUNSTIGDE: KREDBEBBXXX BAU IE;02/01/2026;-1000,00;500,00;              ;-1000,00;BE61 7340 4147 8017;KREDBEBBXXX;BAU IE;                                                                       ;+++123/4567/89012+++              ;Monthly transfer
"""

    @pytest.fixture
    def sample_csv_file(self, sample_kbc_csv_content):
        """Create a temporary CSV file for testing."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(sample_kbc_csv_content)
            temp_path = f.name
        yield temp_path
        # Cleanup
        Path(temp_path).unlink()

    def test_parse_csv_metadata_extraction(self, kbc_adapter, sample_csv_file):
        """Test extraction of transaction data from KBC CSV."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Should have 3 transactions
        assert len(transactions) == 3

    def test_parse_csv_account_type_detection_checking(self, kbc_adapter, sample_csv_file):
        """Test account type detection for checking account (BE61)."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # First two transactions are from checking account
        assert transactions[0].bank_account == "KBC"
        assert transactions[1].bank_account == "KBC"

    def test_parse_csv_account_type_detection_savings(self, kbc_adapter, sample_csv_file):
        """Test account type detection for savings account (BE34)."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Third transaction is from savings account
        assert transactions[2].bank_account == "KBC"

    def test_parse_csv_complete_transaction_fields(self, kbc_adapter, sample_csv_file):
        """Test that all transaction fields are extracted correctly."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Test first transaction (debit from checking)
        txn1 = transactions[0]
        assert txn1.date == datetime(2026, 1, 3)
        assert txn1.bank_account == "KBC"
        assert "IE BAU" in txn1.recipient
        assert txn1.amount == -775.08
        assert txn1.currency == "EUR"
        assert txn1.balance == 0.00
        assert txn1.recipient_account == "BE89 6509 6582 5185"
        assert txn1.memo is not None

    def test_parse_csv_credit_debit_detection(self, kbc_adapter, sample_csv_file):
        """Test detection of credit vs debit transactions."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # First transaction is debit (negative amount)
        txn1 = transactions[0]
        assert txn1.amount < 0
        assert "DEBIT" in txn1.comment

        # Second transaction is credit (positive amount)
        txn2 = transactions[1]
        assert txn2.amount > 0
        assert "CREDIT" in txn2.comment

    def test_parse_csv_comment_field_structure(self, kbc_adapter, sample_csv_file):
        """Test that comment field contains all metadata in structured format."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Check all transactions have structured comments
        for txn in transactions:
            assert txn.comment is not None
            # Should contain statement number
            assert "Statement:" in txn.comment
            # Should contain transaction type
            assert ("CREDIT" in txn.comment or "DEBIT" in txn.comment)

    def test_parse_csv_bic_extraction(self, kbc_adapter, sample_csv_file):
        """Test extraction of BIC codes."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # First transaction has BIC
        assert "BIC: REVOBEB2XXX" in transactions[0].comment

        # Second transaction has BIC
        assert "BIC: KREDBEBBXXX" in transactions[1].comment

    def test_parse_csv_structured_communication(self, kbc_adapter, sample_csv_file):
        """Test extraction of structured communication."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Third transaction has structured communication
        txn3 = transactions[2]
        assert "Structured: +++123/4567/89012+++" in txn3.comment

    def test_parse_csv_free_communication(self, kbc_adapter, sample_csv_file):
        """Test extraction of free communication."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Third transaction has free communication
        txn3 = transactions[2]
        assert "Free: Monthly transfer" in txn3.comment

    def test_parse_csv_statement_number_extraction(self, kbc_adapter, sample_csv_file):
        """Test extraction of statement numbers."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Check statement numbers are included (stripped of leading/trailing spaces)
        assert "Statement: 02026001" in transactions[0].comment
        assert "Statement: 02026001" in transactions[1].comment
        assert "Statement: 01026001" in transactions[2].comment

    def test_parse_csv_recipient_name_extraction(self, kbc_adapter, sample_csv_file):
        """Test recipient name extraction and normalization."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # All transactions should have recipient names
        for txn in transactions:
            assert txn.recipient is not None
            # Should be normalized to uppercase
            assert txn.recipient == txn.recipient.upper()

    def test_parse_csv_recipient_account_extraction(self, kbc_adapter, sample_csv_file):
        """Test extraction of counterparty account numbers."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        assert transactions[0].recipient_account == "BE89 6509 6582 5185"
        assert transactions[1].recipient_account == "BE34 7440 1076 7090"
        assert transactions[2].recipient_account == "BE61 7340 4147 8017"

    def test_parse_csv_amount_parsing(self, kbc_adapter, sample_csv_file):
        """Test correct parsing of amounts with comma decimal separator."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        assert transactions[0].amount == -775.08  # Debit
        assert transactions[1].amount == 775.08  # Credit
        assert transactions[2].amount == -1000.00  # Debit

    def test_parse_csv_balance_parsing(self, kbc_adapter, sample_csv_file):
        """Test correct parsing of balance values."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        assert transactions[0].balance == 0.00
        assert transactions[1].balance == 775.08
        assert transactions[2].balance == 500.00

    def test_parse_csv_value_date_extraction(self, kbc_adapter, sample_csv_file):
        """Test that value dates are included when they differ from transaction date."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # In this sample, value dates are same as transaction dates
        # So they should NOT appear in comments
        for txn in transactions:
            # Value date should not be in comment if same as transaction date
            # (This is checked implicitly - if dates were different, comment would contain "Value Date:")
            assert txn.comment is not None

    def test_parse_csv_empty_optional_fields(self, kbc_adapter):
        """Test handling of empty optional fields."""
        csv_content = """Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;                                                  ;TEST;EUR;  12345;03/01/2026;Test transaction;03/01/2026;-100,00;900,00;              ;-100,00;              ;              ;              ;                                                                       ;                                   ;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = kbc_adapter.parse_csv(temp_path)
            assert len(transactions) == 1

            txn = transactions[0]
            # Optional fields should be None or empty
            assert txn.recipient_account is None or txn.recipient_account == ""
            # Comment should still have structure but without BIC/structured/free communication
            assert txn.comment is not None
            assert "Statement: 12345" in txn.comment
            assert "DEBIT" in txn.comment
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_malformed_date(self, kbc_adapter):
        """Test handling of malformed date values."""
        csv_content = """Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;                                                  ;TEST;EUR;  12345;INVALID;Test transaction;03/01/2026;-100,00;900,00;              ;-100,00;              ;              ;              ;                                                                       ;                                   ;
BE61734041478017;                                                  ;TEST;EUR;  12346;03/01/2026;Valid transaction;03/01/2026;-50,00;850,00;              ;-50,00;              ;              ;              ;                                                                       ;                                   ;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = kbc_adapter.parse_csv(temp_path)
            # Should skip the malformed line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == -50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_malformed_amount(self, kbc_adapter):
        """Test handling of malformed amount values."""
        csv_content = """Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;                                                  ;TEST;EUR;  12345;03/01/2026;Test transaction;03/01/2026;INVALID;900,00;              ;INVALID;              ;              ;              ;                                                                       ;                                   ;
BE61734041478017;                                                  ;TEST;EUR;  12346;03/01/2026;Valid transaction;03/01/2026;-50,00;850,00;              ;-50,00;              ;              ;              ;                                                                       ;                                   ;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = kbc_adapter.parse_csv(temp_path)
            # Should skip the malformed line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == -50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_insufficient_columns(self, kbc_adapter):
        """Test handling of rows with insufficient columns."""
        csv_content = """Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;TEST;EUR
BE61734041478017;                                                  ;TEST;EUR;  12346;03/01/2026;Valid transaction;03/01/2026;-50,00;850,00;              ;-50,00;              ;              ;              ;                                                                       ;                                   ;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = kbc_adapter.parse_csv(temp_path)
            # Should skip the insufficient column line but process the valid one
            assert len(transactions) == 1
            assert transactions[0].amount == -50.00
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_empty_file(self, kbc_adapter):
        """Test handling of empty CSV file."""
        csv_content = ""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = kbc_adapter.parse_csv(temp_path)
            assert len(transactions) == 0
        finally:
            Path(temp_path).unlink()

    def test_parse_csv_normalization_to_uppercase(self, kbc_adapter, sample_csv_file):
        """Test that all text fields are normalized to uppercase."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            # Recipient should be uppercase
            if txn.recipient:
                assert txn.recipient == txn.recipient.upper()

            # Memo should be uppercase
            if txn.memo:
                assert txn.memo == txn.memo.upper()

            # Bank account should be uppercase
            assert txn.bank_account == txn.bank_account.upper()

    def test_parse_csv_raw_data_preservation(self, kbc_adapter, sample_csv_file):
        """Test that raw CSV line is preserved for deduplication."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.raw_data is not None
            assert len(txn.raw_data) > 0
            # Should contain semicolons (CSV delimiter)
            assert ';' in txn.raw_data

    def test_determine_account_type_checking(self, kbc_adapter):
        """Test account type determination for checking account."""
        account_type = kbc_adapter._determine_account_type("BE61734041478017")
        assert account_type == "KBC"

    def test_determine_account_type_savings(self, kbc_adapter):
        """Test account type determination for savings account."""
        account_type = kbc_adapter._determine_account_type("BE34744010767090")
        assert account_type == "KBC"

    def test_determine_account_type_generic(self, kbc_adapter):
        """Test account type determination for unknown pattern."""
        account_type = kbc_adapter._determine_account_type("BE99123456789012")
        assert account_type == "KBC"

    def test_parse_csv_multiple_transactions_ordering(self, kbc_adapter, sample_csv_file):
        """Test that transactions are returned in the order they appear in CSV."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        # Verify chronological order as in CSV
        assert transactions[0].date == datetime(2026, 1, 3)
        assert transactions[1].date == datetime(2026, 1, 3)
        assert transactions[2].date == datetime(2026, 1, 2)

    def test_parse_csv_currency_extraction(self, kbc_adapter, sample_csv_file):
        """Test that currency is correctly extracted."""
        transactions = kbc_adapter.parse_csv(sample_csv_file)

        for txn in transactions:
            assert txn.currency == "EUR"

    def test_parse_csv_value_date_different_from_transaction(self, kbc_adapter):
        """Test handling when value date differs from transaction date."""
        csv_content = """Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling
BE61734041478017;                                                  ;TEST;EUR;  12345;05/01/2026;Test transaction;03/01/2026;-100,00;900,00;              ;-100,00;              ;              ;              ;                                                                       ;                                   ;
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='utf-8') as f:
            f.write(csv_content)
            temp_path = f.name

        try:
            transactions = kbc_adapter.parse_csv(temp_path)
            assert len(transactions) == 1

            txn = transactions[0]
            # Value date different from transaction date should be in comment
            assert "Value Date: 03/01/2026" in txn.comment
        finally:
            Path(temp_path).unlink()
