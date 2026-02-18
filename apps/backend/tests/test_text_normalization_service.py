"""
Unit tests for TextNormalizationService.

Tests text normalization functionality for recipient names,
whitespace handling, and text processing.
"""
import pytest

from services.text_normalization_service import TextNormalizationService


class TestTextNormalizationService:
    """Test cases for text normalization service."""

    @pytest.fixture
    def service(self):
        """Create text normalization service."""
        return TextNormalizationService()

    def test_clean_recipient_name_removes_payment_from(self, service):
        """Test that 'Payment from' prefix is removed."""
        result = service.clean_recipient_name("Payment from John Smith")
        assert result == "John Smith"

    def test_clean_recipient_name_removes_payment_to(self, service):
        """Test that 'Payment to' prefix is removed."""
        result = service.clean_recipient_name("Payment to Jane Doe")
        assert result == "Jane Doe"

    def test_clean_recipient_name_case_insensitive(self, service):
        """Test that prefix removal is case-insensitive."""
        result = service.clean_recipient_name("PAYMENT FROM ACME CORP")
        assert result == "ACME CORP"

    def test_clean_recipient_name_strips_whitespace(self, service):
        """Test that whitespace is stripped."""
        result = service.clean_recipient_name("  John Smith  ")
        assert result == "John Smith"

    def test_clean_recipient_name_no_prefix(self, service):
        """Test that names without prefixes are unchanged."""
        result = service.clean_recipient_name("John Smith")
        assert result == "John Smith"

    def test_clean_recipient_name_empty_string(self, service):
        """Test handling of empty string."""
        result = service.clean_recipient_name("")
        assert result == ""

    def test_clean_recipient_name_none(self, service):
        """Test handling of None."""
        result = service.clean_recipient_name(None)
        assert result is None

    def test_clean_kbc_recipient_geldopneming(self, service):
        """Test KBC geldopneming extraction."""
        result = service.clean_kbc_recipient_name("GELDOPNEMING VIA BANCONTACT 26-09...")
        assert result == "Geldopneming"

    def test_clean_kbc_recipient_overschrijving(self, service):
        """Test KBC overschrijving extraction."""
        result = service.clean_kbc_recipient_name("OVERSCHRIJVING NAAR BE12345...")
        assert result == "Overschrijving"

    def test_clean_kbc_recipient_domiciliering(self, service):
        """Test KBC domiciliëring extraction."""
        result = service.clean_kbc_recipient_name("DOMICILIËRING VAN XYZ Company...")
        assert result == "Domiciliëring"

    def test_clean_kbc_recipient_aankoop(self, service):
        """Test KBC aankoop extraction."""
        result = service.clean_kbc_recipient_name("AANKOOP MET DEBETKAART BIJ Store Name...")
        assert result == "Aankoop"

    def test_clean_kbc_recipient_no_match(self, service):
        """Test KBC recipient with no match returns first word."""
        result = service.clean_kbc_recipient_name("Some Random Transaction Description")
        # Should return first word or first few words
        assert "Some" in result

    def test_normalize_whitespace_single_space(self, service):
        """Test normalizing multiple spaces to single space."""
        result = service.normalize_whitespace("John    Smith")
        assert result == "John Smith"

    def test_normalize_whitespace_strips(self, service):
        """Test that leading/trailing whitespace is stripped."""
        result = service.normalize_whitespace("  John Smith  ")
        assert result == "John Smith"

    def test_normalize_whitespace_empty_string(self, service):
        """Test handling of empty string."""
        result = service.normalize_whitespace("")
        assert result == ""

    def test_normalize_whitespace_none(self, service):
        """Test handling of None."""
        result = service.normalize_whitespace(None)
        assert result is None

    def test_truncate_with_ellipsis_short_text(self, service):
        """Test that short text is not truncated."""
        result = service.truncate_with_ellipsis("Short text", max_length=100)
        assert result == "Short text"

    def test_truncate_with_ellipsis_long_text(self, service):
        """Test that long text is truncated with ellipsis."""
        long_text = "a" * 150
        result = service.truncate_with_ellipsis(long_text, max_length=100)
        assert len(result) == 100
        assert result.endswith("...")

    def test_truncate_with_ellipsis_exact_length(self, service):
        """Test text that is exactly max length."""
        text = "a" * 100
        result = service.truncate_with_ellipsis(text, max_length=100)
        assert result == text

    def test_truncate_with_ellipsis_none(self, service):
        """Test handling of None."""
        result = service.truncate_with_ellipsis(None, max_length=100)
        assert result is None

    def test_extract_currency_code_simple(self, service):
        """Test extracting currency code from simple string."""
        result = service.extract_currency_code("EUR")
        assert result == "EUR"

    def test_extract_currency_code_with_amount(self, service):
        """Test extracting currency code from amount string."""
        result = service.extract_currency_code("100.00 EUR")
        assert result == "EUR"

    def test_extract_currency_code_comma_format(self, service):
        """Test extracting currency code from comma format."""
        result = service.extract_currency_code("100,00 EUR")
        assert result == "EUR"

    def test_extract_currency_code_lowercase(self, service):
        """Test that currency code is normalized to uppercase."""
        result = service.extract_currency_code("eur")
        assert result == "EUR"

    def test_extract_currency_code_none(self, service):
        """Test handling of None."""
        result = service.extract_currency_code(None)
        assert result is None

    def test_extract_currency_code_no_currency(self, service):
        """Test string without currency code."""
        result = service.extract_currency_code("Just some text")
        assert result is None

    def test_format_amount_string_simple(self, service):
        """Test formatting simple amount string."""
        result = service.format_amount_string("100.50")
        assert result == 100.50

    def test_format_amount_string_none(self, service):
        """Test handling of None."""
        result = service.format_amount_string(None)
        assert result is None

    def test_consistency_across_calls(self, service):
        """Test that same input produces same output consistently."""
        input_text = "  Test Text  "
        result1 = service.normalize_whitespace(input_text)
        result2 = service.normalize_whitespace(input_text)
        result3 = service.normalize_whitespace(input_text)

        assert result1 == result2 == result3 == "Test Text"

    def test_unicode_handling(self, service):
        """Test that unicode characters are handled properly."""
        result = service.normalize_whitespace("Café François")
        assert result == "Café François"

    def test_leading_trailing_tabs(self, service):
        """Test handling of tabs and other whitespace characters."""
        result = service.normalize_whitespace("\tGroceries\t")
        assert result == "Groceries"

    def test_newlines_in_text(self, service):
        """Test handling of newlines in text."""
        result = service.normalize_whitespace("Line1\nLine2")
        # Newlines should be treated as whitespace
        assert "\n" not in result
        assert "Line1" in result and "Line2" in result

    def test_clean_recipient_transfer_from(self, service):
        """Test 'Transfer from' prefix removal."""
        result = service.clean_recipient_name("Transfer from Account 123")
        assert result == "Account 123"

    def test_clean_recipient_sent_to(self, service):
        """Test 'Sent to' prefix removal."""
        result = service.clean_recipient_name("Sent to Vendor ABC")
        assert result == "Vendor ABC"

    def test_clean_recipient_received_from(self, service):
        """Test 'Received from' prefix removal."""
        result = service.clean_recipient_name("Received from Client XYZ")
        assert result == "Client XYZ"
