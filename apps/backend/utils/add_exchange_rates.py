"""
Script to add exchange rates to the database.

This script fetches exchange rates from the European Central Bank (ECB) API
and caches them in the exchange_rates table. The database acts as a cache,
so existing rates are always overwritten with fresh data.

Usage:
    # Add/update latest exchange rates (always overwrites existing)
    python utils/add_exchange_rates.py

    # Add/update rates for a specific date
    python utils/add_exchange_rates.py --date 2026-02-15

    # Add/update rates for a date range
    python utils/add_exchange_rates.py --start-date 2026-01-01 --end-date 2026-02-19

    # Add/update sample rates for testing (offline mode)
    python utils/add_exchange_rates.py --sample

    # Prevent overwriting (keep existing rates, only add new ones)
    python utils/add_exchange_rates.py --no-overwrite
"""
import argparse
import os
import sys
import xml.etree.ElementTree as ET
from datetime import date, datetime
from decimal import Decimal
from typing import Dict, Optional, Tuple

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import requests
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from config.logging_config import setup_logging
from database.connection import DATABASE_URL
from database.models import ExchangeRate

logger = setup_logging(__name__)


class ExchangeRateImporter:
    """Service for importing exchange rates into the database."""

    # ECB API endpoints
    ECB_LATEST_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
    ECB_HISTORICAL_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"

    # Common currencies to track
    COMMON_CURRENCIES = [
        "USD",  # US Dollar
        "GBP",  # British Pound
        "CHF",  # Swiss Franc
        "JPY",  # Japanese Yen
        "CAD",  # Canadian Dollar
        "AUD",  # Australian Dollar
        "CNY",  # Chinese Yuan
        "SEK",  # Swedish Krona
        "NOK",  # Norwegian Krone
        "DKK",  # Danish Krone
        "PLN",  # Polish Zloty
        "CZK",  # Czech Koruna
        "HUF",  # Hungarian Forint
        "RON",  # Romanian Leu
        "BGN",  # Bulgarian Lev
        "HRK",  # Croatian Kuna
        "RUB",  # Russian Ruble
        "TRY",  # Turkish Lira
        "INR",  # Indian Rupee
        "BRL",  # Brazilian Real
        "ZAR",  # South African Rand
        "KRW",  # South Korean Won
        "MXN",  # Mexican Peso
        "IDR",  # Indonesian Rupiah
        "MYR",  # Malaysian Ringgit
        "PHP",  # Philippine Peso
        "THB",  # Thai Baht
        "SGD",  # Singapore Dollar
        "HKD",  # Hong Kong Dollar
        "NZD",  # New Zealand Dollar
    ]

    # Sample rates for testing (realistic values as of early 2026)
    SAMPLE_RATES = {
        "USD": Decimal("0.9200"),
        "GBP": Decimal("1.1800"),
        "CHF": Decimal("1.0500"),
        "JPY": Decimal("0.0062"),
        "CAD": Decimal("0.6800"),
        "AUD": Decimal("0.6200"),
        "CNY": Decimal("0.1300"),
        "SEK": Decimal("0.0900"),
        "NOK": Decimal("0.0880"),
        "DKK": Decimal("0.1340"),
        "PLN": Decimal("0.2300"),
        "CZK": Decimal("0.0400"),
        "HUF": Decimal("0.0026"),
        "RON": Decimal("0.2010"),
        "BGN": Decimal("0.5110"),
        "INR": Decimal("0.0110"),
        "BRL": Decimal("0.1850"),
        "ZAR": Decimal("0.0510"),
        "KRW": Decimal("0.0007"),
        "MXN": Decimal("0.0550"),
        "SGD": Decimal("0.6900"),
        "HKD": Decimal("0.1180"),
        "NZD": Decimal("0.5700"),
    }

    def __init__(self, db: Session):
        """Initialize the exchange rate importer.

        Args:
            db: SQLAlchemy database session
        """
        self.db = db

    def fetch_latest_rates(self) -> Dict[str, Tuple[Decimal, date]]:
        """Fetch the latest exchange rates from ECB API.

        Returns:
            Dictionary mapping currency codes to (rate, date) tuples
        """
        try:
            logger.info("Fetching latest exchange rates from ECB API")
            response = requests.get(self.ECB_LATEST_URL, timeout=10)
            response.raise_for_status()

            return self._parse_ecb_xml(response.text)

        except Exception as e:
            logger.error(f"Failed to fetch latest rates from ECB: {e}")
            raise

    def fetch_historical_rates(self, start_date: Optional[date] = None,
                               end_date: Optional[date] = None) -> Dict[date, Dict[str, Decimal]]:
        """Fetch historical exchange rates from ECB API (last 90 days).

        Args:
            start_date: Start date for filtering (optional)
            end_date: End date for filtering (optional)

        Returns:
            Dictionary mapping dates to currency rate dictionaries
        """
        try:
            logger.info("Fetching historical exchange rates from ECB API")
            response = requests.get(self.ECB_HISTORICAL_URL, timeout=10)
            response.raise_for_status()

            all_rates = self._parse_ecb_historical_xml(response.text)

            # Filter by date range if specified
            if start_date or end_date:
                filtered_rates = {}
                for rate_date, rates in all_rates.items():
                    if start_date and rate_date < start_date:
                        continue
                    if end_date and rate_date > end_date:
                        continue
                    filtered_rates[rate_date] = rates
                return filtered_rates

            return all_rates

        except Exception as e:
            logger.error(f"Failed to fetch historical rates from ECB: {e}")
            raise

    def _parse_ecb_xml(self, xml_content: str) -> Dict[str, Tuple[Decimal, date]]:
        """Parse ECB daily XML format.

        Args:
            xml_content: XML content as string

        Returns:
            Dictionary mapping currency codes to (rate, date) tuples
        """
        root = ET.fromstring(xml_content)

        # ECB XML namespace
        ns = {'gesmes': 'http://www.gesmes.org/xml/2002-09-01',
              'ecb': 'http://www.ecb.int/vocabulary/2002-08-01/eurofxref'}

        rates = {}

        # Find the Cube with time attribute (latest rates)
        for time_cube in root.findall('.//ecb:Cube[@time]', ns):
            rate_date_str = time_cube.get('time')
            rate_date = datetime.strptime(rate_date_str, '%Y-%m-%d').date()

            # Find all currency rates within this time cube
            for currency_cube in time_cube.findall('.//ecb:Cube[@currency]', ns):
                currency = currency_cube.get('currency')
                rate = Decimal(currency_cube.get('rate'))

                # ECB rates are "1 EUR = X CURRENCY", we need "1 CURRENCY = X EUR"
                rate_to_eur = Decimal('1.0') / rate

                rates[currency] = (rate_to_eur, rate_date)

        # Add EUR as base currency
        if rates:
            rate_date = list(rates.values())[0][1]
            rates['EUR'] = (Decimal('1.0'), rate_date)

        logger.info(f"Parsed {len(rates)} rates for date {rate_date}")
        return rates

    def _parse_ecb_historical_xml(self, xml_content: str) -> Dict[date, Dict[str, Decimal]]:
        """Parse ECB historical XML format (90 days).

        Args:
            xml_content: XML content as string

        Returns:
            Dictionary mapping dates to currency rate dictionaries
        """
        root = ET.fromstring(xml_content)

        # ECB XML namespace
        ns = {'gesmes': 'http://www.gesmes.org/xml/2002-09-01',
              'ecb': 'http://www.ecb.int/vocabulary/2002-08-01/eurofxref'}

        historical_rates = {}

        # Find all Cube elements with time attribute
        for time_cube in root.findall('.//ecb:Cube[@time]', ns):
            rate_date_str = time_cube.get('time')
            rate_date = datetime.strptime(rate_date_str, '%Y-%m-%d').date()

            rates = {}

            # Find all currency rates within this time cube
            for currency_cube in time_cube.findall('.//ecb:Cube[@currency]', ns):
                currency = currency_cube.get('currency')
                rate = Decimal(currency_cube.get('rate'))

                # ECB rates are "1 EUR = X CURRENCY", we need "1 CURRENCY = X EUR"
                rate_to_eur = Decimal('1.0') / rate

                rates[currency] = rate_to_eur

            # Add EUR as base currency
            rates['EUR'] = Decimal('1.0')

            historical_rates[rate_date] = rates

        logger.info(f"Parsed historical rates for {len(historical_rates)} dates")
        return historical_rates

    def add_rates(self, rates: Dict[str, Tuple[Decimal, date]], force: bool = True) -> int:
        """Add exchange rates to the database.

        The database acts as a cache - existing rates are always overwritten with fresh data.

        Args:
            rates: Dictionary mapping currency codes to (rate, date) tuples
            force: If True, overwrite existing rates (default: True for cache behavior)

        Returns:
            Number of rates added/updated
        """
        count = 0

        for currency_code, (rate_to_eur, rate_date) in rates.items():
            # Check if rate already exists
            existing = self.db.query(ExchangeRate).filter(
                ExchangeRate.currency_code == currency_code,
                ExchangeRate.rate_date == rate_date
            ).first()

            if existing:
                if force:
                    logger.debug(f"Updating cached rate for {currency_code} on {rate_date}")
                    existing.rate_to_eur = rate_to_eur
                    existing.updated_at = datetime.utcnow()
                    count += 1
                else:
                    logger.debug(f"Skipping existing rate for {currency_code} on {rate_date}")
            else:
                logger.info(f"Caching new rate for {currency_code} on {rate_date}: {rate_to_eur}")
                new_rate = ExchangeRate(
                    currency_code=currency_code,
                    rate_to_eur=rate_to_eur,
                    rate_date=rate_date,
                    is_latest=(rate_date == date.today())
                )
                self.db.add(new_rate)
                count += 1

        self.db.commit()
        logger.info(f"Successfully cached {count} exchange rates")
        return count

    def add_historical_rates(self, historical_rates: Dict[date, Dict[str, Decimal]],
                             force: bool = True) -> int:
        """Add historical exchange rates to the database.

        The database acts as a cache - existing rates are always overwritten with fresh data.

        Args:
            historical_rates: Dictionary mapping dates to currency rate dictionaries
            force: If True, overwrite existing rates (default: True for cache behavior)

        Returns:
            Total number of rates added/updated
        """
        total_count = 0

        for rate_date, rates in historical_rates.items():
            for currency_code, rate_to_eur in rates.items():
                # Check if rate already exists
                existing = self.db.query(ExchangeRate).filter(
                    ExchangeRate.currency_code == currency_code,
                    ExchangeRate.rate_date == rate_date
                ).first()

                if existing:
                    if force:
                        logger.debug(f"Updating cached rate for {currency_code} on {rate_date}")
                        existing.rate_to_eur = rate_to_eur
                        existing.updated_at = datetime.utcnow()
                        total_count += 1
                    else:
                        logger.debug(f"Skipping existing rate for {currency_code} on {rate_date}")
                else:
                    logger.debug(f"Caching new rate for {currency_code} on {rate_date}: {rate_to_eur}")
                    new_rate = ExchangeRate(
                        currency_code=currency_code,
                        rate_to_eur=rate_to_eur,
                        rate_date=rate_date,
                        is_latest=False
                    )
                    self.db.add(new_rate)
                    total_count += 1

        self.db.commit()
        logger.info(f"Successfully cached {total_count} historical exchange rates")
        return total_count

    def add_sample_rates(self, target_date: Optional[date] = None, force: bool = True) -> int:
        """Add sample exchange rates for testing purposes.

        The database acts as a cache - existing rates are always overwritten with fresh data.

        Args:
            target_date: Date to assign to rates (defaults to today)
            force: If True, overwrite existing rates (default: True for cache behavior)

        Returns:
            Number of rates added/updated
        """
        if target_date is None:
            target_date = date.today()

        logger.info(f"Adding sample exchange rates for {target_date}")

        # Convert sample rates to the expected format
        rates = {
            currency: (rate, target_date)
            for currency, rate in self.SAMPLE_RATES.items()
        }

        # Add EUR as base currency
        rates['EUR'] = (Decimal('1.0'), target_date)

        return self.add_rates(rates, force=force)

    def mark_latest_rates(self, rate_date: date) -> int:
        """Mark all rates for a specific date as latest and unmark all others.

        Args:
            rate_date: Date to mark as latest

        Returns:
            Number of rates marked as latest
        """
        # Unmark all rates
        self.db.query(ExchangeRate).update({'is_latest': False})

        # Mark rates for the specified date as latest
        result = self.db.query(ExchangeRate).filter(
            ExchangeRate.rate_date == rate_date
        ).update({'is_latest': True})

        self.db.commit()
        logger.info(f"Marked {result} rates from {rate_date} as latest")
        return result

    def get_rate_summary(self) -> Dict:
        """Get a summary of exchange rates in the database.

        Returns:
            Dictionary with summary statistics
        """
        total_rates = self.db.query(ExchangeRate).count()
        currencies = self.db.query(ExchangeRate.currency_code).distinct().count()
        latest_date = self.db.query(ExchangeRate.rate_date).order_by(
            ExchangeRate.rate_date.desc()
        ).first()
        oldest_date = self.db.query(ExchangeRate.rate_date).order_by(
            ExchangeRate.rate_date.asc()
        ).first()

        return {
            'total_rates': total_rates,
            'currencies': currencies,
            'latest_date': latest_date[0] if latest_date else None,
            'oldest_date': oldest_date[0] if oldest_date else None
        }


def main():
    """Main entry point for the script."""
    parser = argparse.ArgumentParser(
        description='Add/update exchange rates in the database cache',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Add/update latest exchange rates (default: overwrites existing)
  python utils/add_exchange_rates.py

  # Add/update rates for a specific date range
  python utils/add_exchange_rates.py --start-date 2026-01-01 --end-date 2026-02-19

  # Add/update sample rates for testing
  python utils/add_exchange_rates.py --sample

  # Prevent overwriting existing rates (cache-miss only mode)
  python utils/add_exchange_rates.py --no-overwrite --sample
        """
    )

    parser.add_argument(
        '--date',
        type=str,
        help='Add/update rates for a specific date (YYYY-MM-DD). Uses historical API.'
    )
    parser.add_argument(
        '--start-date',
        type=str,
        help='Start date for historical rates (YYYY-MM-DD)'
    )
    parser.add_argument(
        '--end-date',
        type=str,
        help='End date for historical rates (YYYY-MM-DD)'
    )
    parser.add_argument(
        '--sample',
        action='store_true',
        help='Add sample rates for testing (offline mode)'
    )
    parser.add_argument(
        '--no-overwrite',
        action='store_true',
        help='Do not overwrite existing rates (only add missing rates)'
    )
    parser.add_argument(
        '--summary',
        action='store_true',
        help='Show summary of rates in database and exit'
    )

    args = parser.parse_args()

    # Invert --no-overwrite to get force flag (default is True for cache behavior)
    force = not args.no_overwrite

    # Create database engine and session
    try:
        engine = create_engine(DATABASE_URL)
        SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        db = SessionLocal()

        importer = ExchangeRateImporter(db)

        # Show summary if requested
        if args.summary:
            summary = importer.get_rate_summary()
            print("\n📊 Exchange Rate Database Summary")
            print("=" * 50)
            print(f"Total rates: {summary['total_rates']}")
            print(f"Currencies: {summary['currencies']}")
            print(f"Latest date: {summary['latest_date']}")
            print(f"Oldest date: {summary['oldest_date']}")
            print()
            return 0

        # Handle sample rates
        if args.sample:
            print("\n💡 Adding/updating sample exchange rates in cache...")
            if args.date:
                target_date = datetime.strptime(args.date, '%Y-%m-%d').date()
            else:
                target_date = date.today()

            count = importer.add_sample_rates(target_date=target_date, force=force)
            importer.mark_latest_rates(target_date)

            if force:
                print(f"✅ Cached {count} sample exchange rates for {target_date} (overwrite mode)")
            else:
                print(f"✅ Added {count} new sample exchange rates for {target_date} (existing rates preserved)")
            return 0

        # Handle specific date or date range
        if args.date or args.start_date or args.end_date:
            print("\n📅 Fetching historical exchange rates from ECB...")

            start = datetime.strptime(args.start_date, '%Y-%m-%d').date() if args.start_date else None
            end = datetime.strptime(args.end_date, '%Y-%m-%d').date() if args.end_date else None

            if args.date:
                target = datetime.strptime(args.date, '%Y-%m-%d').date()
                start = target
                end = target

            historical_rates = importer.fetch_historical_rates(start_date=start, end_date=end)

            if not historical_rates:
                print("❌ No rates found for the specified date range")
                return 1

            count = importer.add_historical_rates(historical_rates, force=force)

            # Mark the latest date as current if it's today
            latest_date = max(historical_rates.keys())
            if latest_date == date.today():
                importer.mark_latest_rates(latest_date)

            mode_text = "overwrite mode" if force else "existing rates preserved"
            print(f"✅ Cached {count} exchange rates for {len(historical_rates)} dates ({mode_text})")
            return 0

        # Default: fetch latest rates
        print("\n🌍 Fetching latest exchange rates from ECB...")
        rates = importer.fetch_latest_rates()

        if not rates:
            print("❌ No rates fetched from ECB")
            return 1

        count = importer.add_rates(rates, force=force)

        # Mark as latest
        rate_date = list(rates.values())[0][1]
        importer.mark_latest_rates(rate_date)

        mode_text = "(cache updated)" if force else "(new rates only)"
        print(f"✅ Successfully cached {count} exchange rates for {rate_date} {mode_text}")
        print(f"   Currencies: {', '.join(sorted(rates.keys()))}")

        # Show summary
        summary = importer.get_rate_summary()
        print(f"\n📊 Database cache now contains {summary['total_rates']} rates for {summary['currencies']} currencies")

        return 0

    except Exception as e:
        logger.error(f"Failed to add exchange rates: {e}", exc_info=True)
        print(f"\n❌ Error: {e}")
        return 1

    finally:
        if 'db' in locals():
            db.close()


if __name__ == "__main__":
    sys.exit(main())
