"""
Currency Conversion Service

Handles currency conversion operations for financial transactions.
Converts various currencies to EUR (base currency) using real-time exchange rates
from the European Central Bank (ECB) API.

The service implements database caching to minimize API calls and network delays,
with automatic fallback mechanisms for offline operation.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, Dict

import requests
from sqlalchemy.orm import Session

from config.logging_config import setup_logging

logger = setup_logging(__name__)


class CurrencyConversionService:
    """
    Service for converting currencies to EUR using real-time ECB exchange rates.

    Features:
    - Real-time rates from European Central Bank API
    - Database caching (primary cache, persistent across restarts)
    - In-memory caching (24-hour cache lifetime for performance)
    - Automatic fallback to cached rates if API unavailable
    - Support for historical rates by date
    """

    # ECB API endpoints (free, no authentication required)
    ECB_LATEST_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

    # For historical rates, we'll use the 90-day history file
    ECB_HISTORICAL_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"

    # Cache lifetime in seconds (24 hours)
    CACHE_LIFETIME = 86400

    # Fallback rates (only used if API and DB are completely unavailable)
    FALLBACK_RATES: Dict[str, Decimal] = {
        "EUR": Decimal("1.0"),
        "USD": Decimal("1.09"),
        "GBP": Decimal("0.85"),
        "CHF": Decimal("0.95"),
        "JPY": Decimal("163.0"),
    }

    def __init__(self, db: Optional[Session] = None):
        """
        Initialize the currency conversion service.

        Args:
            db: SQLAlchemy database session for caching rates in database.
                If None, falls back to fallback rates only.
        """
        self.db = db

        # In-memory cache: {date_str: {currency: rate, ...}, ...}
        self._memory_cache: Dict[str, Dict[str, Decimal]] = {}
        self._cache_timestamps: Dict[str, datetime] = {}

        # Flag to track if we've attempted to load rates
        self._rates_loaded = False

        # Don't load rates on initialization - use lazy loading instead
        # This prevents blocking the application startup with API calls

    def _is_cache_valid(self, cache_key: str) -> bool:
        """Check if in-memory cache is still valid."""
        if cache_key not in self._cache_timestamps:
            return False

        age = datetime.now() - self._cache_timestamps[cache_key]
        return age.total_seconds() < self.CACHE_LIFETIME

    def _load_from_database(self, rate_date: date, max_age_seconds: int = 604800) -> Optional[Dict[str, Decimal]]:
        """
        Load exchange rates from database for a specific date.

        Args:
            rate_date: The date to load rates for
            max_age_seconds: Maximum age of cached rates in seconds (default: 7 days)

        Returns:
            Dictionary of currency codes to rates, or None if not found
        """
        if not self.db:
            return None

        try:
            from database.models import ExchangeRate

            # Query all rates for the given date
            rates_query = self.db.query(ExchangeRate).filter(
                ExchangeRate.rate_date == rate_date
            ).all()

            if not rates_query:
                logger.debug(f"No rates found in database for {rate_date}")
                return None

            # Check if rates are still acceptable (within max age)
            # Use longer cache lifetime for database (7 days default) vs memory (24 hours)
            latest_fetch = max(r.fetched_at for r in rates_query)
            age = datetime.now() - latest_fetch

            if age.total_seconds() > max_age_seconds:
                logger.debug(
                    f"Database rates expired for {rate_date} (age: {age.total_seconds()}s, max: {max_age_seconds}s)")
                return None

            # Convert to dictionary
            rates = {r.currency_code: Decimal(str(r.rate_to_eur)) for r in rates_query}
            rates["EUR"] = Decimal("1.0")  # Always include EUR base

            logger.info(
                f"Loaded {len(rates)} exchange rates from database",
                extra={
                    "operation": "load_from_database",
                    "date": rate_date.isoformat(),
                    "currencies_count": len(rates),
                    "age_seconds": age.total_seconds()
                }
            )

            return rates

        except Exception as e:
            logger.error(
                f"Failed to load rates from database: {e}",
                extra={
                    "operation": "load_from_database",
                    "date": rate_date.isoformat()
                },
                exc_info=True
            )
            return None

    def _save_to_database(self, rate_date: date, rates: Dict[str, Decimal]) -> bool:
        """
        Save exchange rates to database.

        Args:
            rate_date: The date these rates are valid for
            rates: Dictionary of currency codes to exchange rates

        Returns:
            True if save successful, False otherwise
        """
        if not self.db:
            return False

        try:
            from database.models import ExchangeRate
            from sqlalchemy import and_

            # Mark all previous rates as not latest
            if rate_date == date.today():
                self.db.query(ExchangeRate).filter(
                    ExchangeRate.is_latest == True
                ).update({"is_latest": False})

            # Save or update each rate
            saved_count = 0
            for currency_code, rate in rates.items():
                if currency_code == "EUR":
                    continue  # Skip EUR base currency

                # Check if rate already exists for this date
                existing = self.db.query(ExchangeRate).filter(
                    and_(
                        ExchangeRate.currency_code == currency_code,
                        ExchangeRate.rate_date == rate_date
                    )
                ).first()

                if existing:
                    # Update existing rate
                    existing.rate_to_eur = rate
                    existing.fetched_at = datetime.now()
                    existing.is_latest = (rate_date == date.today())
                else:
                    # Create new rate
                    new_rate = ExchangeRate(
                        currency_code=currency_code,
                        rate_to_eur=rate,
                        rate_date=rate_date,
                        is_latest=(rate_date == date.today())
                    )
                    self.db.add(new_rate)

                saved_count += 1

            self.db.commit()

            logger.info(
                f"Saved {saved_count} exchange rates to database",
                extra={
                    "operation": "save_to_database",
                    "date": rate_date.isoformat(),
                    "currencies_count": saved_count
                }
            )

            return True

        except Exception as e:
            logger.error(
                f"Failed to save rates to database: {e}",
                extra={
                    "operation": "save_to_database",
                    "date": rate_date.isoformat()
                },
                exc_info=True
            )
            if self.db:
                self.db.rollback()
            return False

    def _fetch_rates_from_api(self, target_date: Optional[date] = None) -> Optional[Dict[str, Decimal]]:
        """
        Fetch exchange rates from ECB API.

        Uses the European Central Bank's free XML API which provides EUR-based rates
        without requiring authentication.

        Args:
            target_date: Specific date for historical rates (within last 90 days), None for latest

        Returns:
            Dictionary of currency codes to exchange rates (X currency = Y EUR), or None if failed
        """
        try:
            import xml.etree.ElementTree as ET

            # For historical dates, use the 90-day history file and filter by date
            # For latest rates, use the daily file
            if target_date and target_date < date.today():
                url = self.ECB_HISTORICAL_URL
                use_historical = True
            else:
                url = self.ECB_LATEST_URL
                use_historical = False

            logger.debug(f"Fetching exchange rates from ECB: {url}")

            response = requests.get(url, timeout=5)
            response.raise_for_status()

            # Parse XML
            root = ET.fromstring(response.content)

            # ECB XML namespaces
            namespaces = {
                'gesmes': 'http://www.gesmes.org/xml/2002-08-01',
                'xmlns': 'http://www.ecb.int/vocabulary/2002-08-01/eurofxref'
            }

            rates = {}
            rates["EUR"] = Decimal("1.0")  # EUR is always 1.0

            # Find the right Cube element
            if use_historical:
                # Historical file has multiple dates, find the one we want
                target_date_str = target_date.isoformat()
                found_date = False

                for time_cube in root.findall('.//xmlns:Cube[@time]', namespaces):
                    cube_date = time_cube.get('time')
                    if cube_date == target_date_str:
                        found_date = True
                        for currency_cube in time_cube.findall('.//xmlns:Cube[@currency]', namespaces):
                            currency = currency_cube.get('currency')
                            rate_str = currency_cube.get('rate')
                            if currency and rate_str:
                                # ECB gives EUR->X rate, we need X->EUR rate
                                # If 1 EUR = 1.09 USD, then 1 USD = 1/1.09 EUR
                                eur_to_currency = Decimal(rate_str)
                                currency_to_eur = Decimal("1.0") / eur_to_currency
                                rates[currency] = currency_to_eur
                        break

                if not found_date:
                    logger.warning(f"No rates found for date {target_date_str} in historical data")
                    return None

            else:
                # Latest file has one date
                for currency_cube in root.findall('.//xmlns:Cube[@currency]', namespaces):
                    currency = currency_cube.get('currency')
                    rate_str = currency_cube.get('rate')
                    if currency and rate_str:
                        # ECB gives EUR->X rate, we need X->EUR rate
                        eur_to_currency = Decimal(rate_str)
                        currency_to_eur = Decimal("1.0") / eur_to_currency
                        rates[currency] = currency_to_eur

            if len(rates) <= 1:  # Only EUR means no rates were parsed
                logger.error("Failed to parse any rates from ECB XML")
                return None

            logger.info(
                f"Fetched {len(rates)} exchange rates from ECB",
                extra={
                    "operation": "fetch_rates",
                    "date": target_date.isoformat() if target_date else "latest",
                    "currencies_count": len(rates)
                }
            )

            return rates

        except requests.RequestException as e:
            logger.error(
                f"Failed to fetch exchange rates from ECB: {e}",
                extra={
                    "operation": "fetch_rates",
                    "error_type": type(e).__name__
                }
            )
            return None
        except Exception as e:
            logger.error(
                f"Unexpected error fetching rates: {e}",
                extra={
                    "operation": "fetch_rates",
                    "error_type": type(e).__name__
                },
                exc_info=True
            )
            return None

    def _load_latest_rates(self, force_api: bool = False) -> None:
        """
        Load latest exchange rates (from memory cache, database, or API).

        Args:
            force_api: If True, always fetch from API even if cache exists
        """
        cache_key = "latest"

        # Mark that we've attempted to load rates
        self._rates_loaded = True

        # Try memory cache first (fastest)
        if not force_api and self._is_cache_valid(cache_key):
            logger.debug("Using in-memory cached rates")
            return

        # Try database cache (persistent, fast)
        if not force_api:
            today = date.today()
            db_rates = self._load_from_database(today)
            if db_rates:
                self._memory_cache[cache_key] = db_rates
                self._cache_timestamps[cache_key] = datetime.now()
                logger.debug("Loaded rates from database cache")

                # Asynchronously refresh rates in background if they're getting old (>12 hours)
                # but don't block - use what we have
                return

        # Only fetch from API if forced or no cache available
        # This is the slowest operation and should be avoided during initialization
        if force_api or cache_key not in self._memory_cache:
            api_rates = self._fetch_rates_from_api()
            if api_rates:
                self._memory_cache[cache_key] = api_rates
                self._cache_timestamps[cache_key] = datetime.now()
                # Save to database for future use (non-blocking if possible)
                if self.db:
                    try:
                        self._save_to_database(date.today(), api_rates)
                        logger.info("Loaded fresh rates from API and saved to database")
                    except Exception as e:
                        logger.warning(f"Failed to save rates to database: {e}")
                return

        # Use fallback rates as last resort
        if cache_key not in self._memory_cache:
            logger.warning("Using fallback exchange rates - API and database unavailable")
            self._memory_cache[cache_key] = self.FALLBACK_RATES.copy()
            self._cache_timestamps[cache_key] = datetime.now()

    def _get_rates_for_date(self, target_date: date) -> Dict[str, Decimal]:
        """
        Get exchange rates for a specific date.

        Args:
            target_date: The date for which to get rates

        Returns:
            Dictionary of currency codes to rates
        """
        # For today or future dates, use latest rates
        if target_date >= date.today():
            cache_key = "latest"
            if not self._is_cache_valid(cache_key):
                self._load_latest_rates()
            return self._memory_cache.get(cache_key, self.FALLBACK_RATES.copy())

        # For historical dates
        date_str = target_date.isoformat()
        cache_key = f"historical_{date_str}"

        # Check memory cache
        if cache_key in self._memory_cache and self._is_cache_valid(cache_key):
            return self._memory_cache[cache_key]

        # Check database cache
        db_rates = self._load_from_database(target_date)
        if db_rates:
            self._memory_cache[cache_key] = db_rates
            self._cache_timestamps[cache_key] = datetime.now()
            return db_rates

        # Fetch historical rates from API
        api_rates = self._fetch_rates_from_api(target_date)
        if api_rates:
            self._memory_cache[cache_key] = api_rates
            self._cache_timestamps[cache_key] = datetime.now()
            # Save to database for future use
            self._save_to_database(target_date, api_rates)
            return api_rates

        # Fallback to latest rates if historical fetch fails
        logger.warning(f"Using latest rates as fallback for historical date {date_str}")
        return self._get_rates_for_date(date.today())

    def convert_to_eur(
            self,
            amount: float,
            from_currency: Optional[str],
            transaction_date: Optional[date] = None
    ) -> Decimal:
        """
        Convert an amount from a given currency to EUR using real-time rates.

        Args:
            amount: The amount to convert
            from_currency: The source currency code (ISO 4217, e.g., "USD", "GBP")
            transaction_date: The transaction date for historical rates (optional)

        Returns:
            The amount converted to EUR as a Decimal
        """
        # Handle None or empty currency - assume EUR
        if not from_currency:
            return Decimal(str(amount))

        # Normalize currency code to uppercase
        from_currency = from_currency.upper().strip()

        # If already in EUR, no conversion needed
        if from_currency == "EUR":
            return Decimal(str(amount))

        # Lazy load: only fetch rates when we actually need them
        if not self._rates_loaded and self.db:
            self._load_latest_rates()

        # Get rates for the transaction date (or latest if not specified)
        target_date = transaction_date if transaction_date else date.today()
        rates = self._get_rates_for_date(target_date)

        # Get exchange rate
        if from_currency not in rates:
            logger.warning(
                f"Unsupported currency code {from_currency}, using 1:1 conversion",
                extra={
                    "operation": "convert_to_eur",
                    "amount": amount,
                    "from_currency": from_currency,
                    "supported_currencies": list(rates.keys())
                }
            )
            # Default to 1:1 conversion for unknown currencies
            return Decimal(str(amount))

        rate = rates[from_currency]
        converted_amount = Decimal(str(amount)) * rate

        logger.debug(
            "Currency conversion performed",
            extra={
                "operation": "convert_to_eur",
                "amount": amount,
                "from_currency": from_currency,
                "rate": str(rate),
                "converted_amount": str(converted_amount),
                "transaction_date": target_date.isoformat()
            }
        )

        return converted_amount

    def get_exchange_rate(self, currency_code: str, target_date: Optional[date] = None) -> Optional[Decimal]:
        """
        Get the exchange rate for a currency to EUR.

        Args:
            currency_code: ISO 4217 currency code (e.g., "USD", "GBP")
            target_date: Date for historical rate (optional, defaults to latest)

        Returns:
            Exchange rate as Decimal, or None if not found
        """
        target_date = target_date if target_date else date.today()
        rates = self._get_rates_for_date(target_date)
        return rates.get(currency_code.upper().strip())

    def get_supported_currencies(self, target_date: Optional[date] = None) -> list[str]:
        """
        Get list of supported currency codes.

        Args:
            target_date: Date for which to get supported currencies (optional)

        Returns:
            List of ISO 4217 currency codes
        """
        target_date = target_date if target_date else date.today()
        rates = self._get_rates_for_date(target_date)
        return sorted(rates.keys())

    def warm_cache(self) -> None:
        """
        Pre-warm the cache by loading rates from database (non-blocking).

        This method is designed to be called in the background during
        application startup to pre-load rates without blocking the main thread.
        It only loads from database, never from API, to keep it fast.
        """
        if not self.db or self._rates_loaded:
            return

        cache_key = "latest"

        # Only load from database, never from API (fast operation)
        today = date.today()
        db_rates = self._load_from_database(today, max_age_seconds=604800)  # 7 days
        if db_rates:
            self._memory_cache[cache_key] = db_rates
            self._cache_timestamps[cache_key] = datetime.now()
            self._rates_loaded = True
            logger.debug("Pre-warmed cache from database")
        else:
            # Use fallback rates so we're never without rates
            self._memory_cache[cache_key] = self.FALLBACK_RATES.copy()
            self._cache_timestamps[cache_key] = datetime.now()
            self._rates_loaded = True
            logger.debug("Pre-warmed cache with fallback rates")

    def refresh_rates(self) -> bool:
        """
        Force refresh of exchange rates from API.

        Returns:
            True if refresh successful, False otherwise
        """
        logger.info("Forcing refresh of exchange rates")

        # Clear caches
        self._memory_cache.clear()
        self._cache_timestamps.clear()
        self._rates_loaded = False

        # Force fetch from API
        self._load_latest_rates(force_api=True)

        return "latest" in self._memory_cache
