"""
Test script to verify ECB currency API is working correctly.
"""
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from services.currency_conversion_service import CurrencyConversionService


def test_currency_service():
    """Test the currency conversion service with ECB API."""
    print("Testing Currency Conversion Service with ECB API...\n")

    # Test without database (will use API or fallback)
    converter = CurrencyConversionService(db=None)

    # Test 1: Convert USD to EUR
    print("Test 1: Convert 100 USD to EUR")
    try:
        result = converter.convert_to_eur(100.0, "USD")
        print(f"  Result: {result} EUR")
        print(f"  ✓ Success\n")
    except Exception as e:
        print(f"  ✗ Failed: {e}\n")

    # Test 2: Convert GBP to EUR
    print("Test 2: Convert 100 GBP to EUR")
    try:
        result = converter.convert_to_eur(100.0, "GBP")
        print(f"  Result: {result} EUR")
        print(f"  ✓ Success\n")
    except Exception as e:
        print(f"  ✗ Failed: {e}\n")

    # Test 3: EUR to EUR (no conversion)
    print("Test 3: Convert 100 EUR to EUR (no conversion)")
    try:
        result = converter.convert_to_eur(100.0, "EUR")
        print(f"  Result: {result} EUR")
        assert result == 100.0, "EUR to EUR should be 1:1"
        print(f"  ✓ Success\n")
    except Exception as e:
        print(f"  ✗ Failed: {e}\n")

    # Test 4: Get supported currencies
    print("Test 4: Get supported currencies")
    try:
        currencies = converter.get_supported_currencies()
        print(f"  Supported currencies: {len(currencies)} total")
        print(f"  First 10: {currencies[:10]}")
        print(f"  ✓ Success\n")
    except Exception as e:
        print(f"  ✗ Failed: {e}\n")

    # Test 5: Get exchange rate
    print("Test 5: Get USD exchange rate")
    try:
        rate = converter.get_exchange_rate("USD")
        if rate:
            print(f"  1 USD = {rate} EUR")
            print(f"  ✓ Success\n")
        else:
            print(f"  ✗ Rate not found\n")
    except Exception as e:
        print(f"  ✗ Failed: {e}\n")

    print("All tests completed!")


if __name__ == "__main__":
    test_currency_service()
