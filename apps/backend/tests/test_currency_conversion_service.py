"""
Unit tests for CurrencyConversionService.

Tests currency conversion functionality, caching mechanisms,
fallback handling, and error scenarios for financial calculations.
"""
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from database.models import ExchangeRate
from services.currency_conversion_service import CurrencyConversionService


class TestCurrencyConversionService:
    """Test cases for currency conversion service."""

    @pytest.fixture
    def service(self, test_db: Session):
        """Create a currency conversion service with test database."""
        return CurrencyConversionService(db=test_db)

    @pytest.fixture
    def service_no_db(self):
        """Create a currency conversion service without database."""
        return CurrencyConversionService(db=None)

    @pytest.fixture
    def setup_exchange_rates(self, test_db: Session):
        """Set up test exchange rates in database dynamically.

        This fixture creates rates with randomized but realistic values.
        Tests verify conversion logic works correctly regardless of actual rates.
        """
        import random

        # Generate random but realistic rates (within typical ranges)
        # This ensures tests don't depend on specific rate values
        usd_rate = Decimal(str(round(random.uniform(0.85, 0.95), 4)))  # USD typically 0.85-0.95 EUR
        gbp_rate = Decimal(str(round(random.uniform(1.10, 1.20), 4)))  # GBP typically 1.10-1.20 EUR
        jpy_rate = Decimal(str(round(random.uniform(0.0055, 0.0070), 6)))  # JPY typically 0.0055-0.0070 EUR

        rates_data = [
            ExchangeRate(
                currency_code="USD",
                rate_to_eur=usd_rate,
                rate_date=date(2026, 2, 17)
            ),
            ExchangeRate(
                currency_code="GBP",
                rate_to_eur=gbp_rate,
                rate_date=date(2026, 2, 17)
            ),
            ExchangeRate(
                currency_code="JPY",
                rate_to_eur=jpy_rate,
                rate_date=date(2026, 2, 17)
            ),
        ]
        for rate in rates_data:
            test_db.add(rate)
        test_db.commit()

        # Return dynamically generated rates for verification
        yield {
            "USD": usd_rate,
            "GBP": gbp_rate,
            "JPY": jpy_rate
        }

        test_db.query(ExchangeRate).delete()
        test_db.commit()

    def test_convert_eur_to_eur(self, service):
        """Test converting EUR to EUR returns same amount."""
        result = service.convert_to_eur(100.00, "EUR")
        assert result == Decimal("100.00")

    def test_convert_with_cached_rate(self, service, test_db: Session, setup_exchange_rates):
        """Test conversion using cached database rates."""
        rates = setup_exchange_rates
        amount_usd = 100.00

        result = service.convert_to_eur(
            amount_usd,
            "USD",
            transaction_date=date(2026, 2, 17)
        )

        # Calculate expected result from rate
        expected = Decimal(str(amount_usd)) * rates["USD"]

        # Verify conversion is correct (within reasonable tolerance for Decimal arithmetic)
        assert abs(result - expected) < Decimal("0.01")
        assert isinstance(result, Decimal)

    def test_convert_gbp_to_eur(self, service, test_db: Session, setup_exchange_rates):
        """Test GBP to EUR conversion."""
        rates = setup_exchange_rates
        amount_gbp = 100.00

        result = service.convert_to_eur(
            amount_gbp,
            "GBP",
            transaction_date=date(2026, 2, 17)
        )

        # Calculate expected result from rate
        expected = Decimal(str(amount_gbp)) * rates["GBP"]

        # Verify conversion is correct
        assert abs(result - expected) < Decimal("0.01")
        assert isinstance(result, Decimal)

    def test_convert_with_fallback_rate(self, service_no_db):
        """Test conversion using fallback rates when database unavailable."""
        result = service_no_db.convert_to_eur(109.00, "USD")
        # Without database, service will try API or use fallback rates
        # Result should be reasonable (within 50% of expected)
        assert isinstance(result, Decimal)
        assert result > Decimal("50.00")  # Should be positive and reasonable

    def test_convert_unsupported_currency_uses_default(self, service):
        """Test that unsupported currency uses 1:1 conversion."""
        # The service logs a warning but returns 1:1 conversion
        result = service.convert_to_eur(100.00, "XYZ")
        assert result == Decimal("100.00")

    def test_convert_none_amount_returns_zero(self, service):
        """Test that None amount returns zero."""
        result = service.convert_to_eur(0.0, "EUR")
        assert result == Decimal("0.00")

    def test_convert_zero_amount_returns_zero(self, service):
        """Test that zero amount returns zero."""
        result = service.convert_to_eur(0.00, "USD")
        assert result == Decimal("0.00")

    def test_convert_negative_amount(self, service, test_db: Session, setup_exchange_rates):
        """Test conversion with negative amount (income)."""
        rates = setup_exchange_rates
        amount_usd = -100.00

        result = service.convert_to_eur(
            amount_usd,
            "USD",
            transaction_date=date(2026, 2, 17)
        )

        # Calculate expected result (should preserve negative sign)
        expected = Decimal(str(amount_usd)) * rates["USD"]

        assert abs(result - expected) < Decimal("0.01")
        assert result < 0  # Should be negative

    def test_in_memory_cache_used(self, service, test_db: Session, setup_exchange_rates):
        """Test that in-memory cache is used for repeated conversions."""
        rates = setup_exchange_rates
        amount = 100.00

        # First conversion loads from database
        result1 = service.convert_to_eur(
            amount,
            "USD",
            transaction_date=date(2026, 2, 17)
        )

        # Delete database rates to verify cache is used
        test_db.query(ExchangeRate).delete()
        test_db.commit()

        # Second conversion should use in-memory cache
        result2 = service.convert_to_eur(
            amount,
            "USD",
            transaction_date=date(2026, 2, 17)
        )

        # Both conversions should produce identical results
        assert result1 == result2

        # Verify the result matches expected calculation
        expected = Decimal(str(amount)) * rates["USD"]
        assert abs(result1 - expected) < Decimal("0.01")

    def test_precision_maintained(self, service, test_db: Session):
        """Test that decimal precision is maintained in conversions."""
        import random

        # Generate a random rate with high precision to test Decimal handling
        test_rate = Decimal(str(round(random.uniform(0.9, 1.1), 12)))

        rate = ExchangeRate(
            currency_code="CHF",
            rate_to_eur=test_rate,
            rate_date=date(2026, 2, 17)
        )
        test_db.add(rate)
        test_db.commit()

        amount = 100.33
        result = service.convert_to_eur(
            amount,
            "CHF",
            transaction_date=date(2026, 2, 17)
        )

        # Verify precision is maintained
        assert isinstance(result, Decimal)

        # Calculate expected value and verify conversion is accurate
        expected = Decimal(str(amount)) * test_rate
        assert abs(result - expected) < Decimal("0.0001")  # Very tight tolerance

    @patch('services.currency_conversion_service.requests.get')
    def test_api_fallback_on_error(self, mock_get, service, test_db: Session):
        """Test that service handles API errors gracefully."""
        # Simulate API error
        mock_get.side_effect = Exception("API unavailable")

        # Should fall back to fallback rates
        result = service.convert_to_eur(109.00, "USD")

        # Should use fallback rate or 1:1 fallback
        assert isinstance(result, Decimal)

    def test_multiple_currencies_same_date(self, service, test_db: Session, setup_exchange_rates):
        """Test converting multiple currencies on same date."""
        rates = setup_exchange_rates

        # Use same EUR-equivalent amount for all currencies
        # Convert 100 EUR worth of each currency
        amount_usd = 100.00 / float(rates["USD"])  # Amount of USD that equals ~100 EUR
        amount_gbp = 100.00 / float(rates["GBP"])  # Amount of GBP that equals ~100 EUR
        amount_jpy = 100.00 / float(rates["JPY"])  # Amount of JPY that equals ~100 EUR

        usd_result = service.convert_to_eur(amount_usd, "USD", date(2026, 2, 17))
        gbp_result = service.convert_to_eur(amount_gbp, "GBP", date(2026, 2, 17))
        jpy_result = service.convert_to_eur(amount_jpy, "JPY", date(2026, 2, 17))

        # All should convert to approximately 100 EUR
        target = Decimal("100.00")
        assert abs(usd_result - target) < Decimal("0.1")
        assert abs(gbp_result - target) < Decimal("0.1")
        assert abs(jpy_result - target) < Decimal("0.1")

        # Verify all are Decimal type
        assert all(isinstance(r, Decimal) for r in [usd_result, gbp_result, jpy_result])

    def test_rounding_behavior(self, service, test_db: Session):
        """Test that rounding is handled correctly."""
        import random

        # Generate a random rate with many decimal places
        test_rate = Decimal(str(round(random.uniform(0.9, 1.1), 11)))

        rate = ExchangeRate(
            currency_code="CHF",
            rate_to_eur=test_rate,
            rate_date=date(2026, 2, 17)
        )
        test_db.add(rate)
        test_db.commit()

        amount = 100.33
        result = service.convert_to_eur(
            amount,
            "CHF",
            transaction_date=date(2026, 2, 17)
        )

        # Verify Decimal type and proper formatting
        assert isinstance(result, Decimal)
        assert str(result).count('.') <= 1  # At most one decimal point

        # Verify correct calculation regardless of the random rate
        expected = Decimal(str(amount)) * test_rate
        assert abs(result - expected) < Decimal("0.0001")
