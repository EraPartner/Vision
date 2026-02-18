"""
Recurrence pattern calculation service.

Handles calculation of next occurrence dates for recurring planned transactions
based on various recurrence patterns.
"""
from datetime import date, timedelta
from typing import Optional

from dateutil.relativedelta import relativedelta

from config.logging_config import setup_logging

logger = setup_logging(__name__)


class RecurrenceService:
    """Service for calculating next occurrence dates for recurring transactions."""

    SUPPORTED_PATTERNS = ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"]

    @staticmethod
    def calculate_next_date(current_date: date, recurrence_pattern: str) -> Optional[date]:
        """Calculate the next occurrence date based on recurrence pattern.

        Args:
            current_date (date): The current/last execution date.
            recurrence_pattern (str): The recurrence pattern (e.g., 'monthly', 'weekly', 'every 10 days').

        Returns:
            Optional[date]: The next occurrence date, or None if pattern is invalid.

        Examples:
            >>> RecurrenceService.calculate_next_date(date(2026, 2, 15), "monthly")
            date(2026, 3, 15)

            >>> RecurrenceService.calculate_next_date(date(2026, 2, 15), "weekly")
            date(2026, 2, 22)
            
            >>> RecurrenceService.calculate_next_date(date(2026, 2, 15), "every 10 days")
            date(2026, 2, 25)
        """
        if not recurrence_pattern:
            logger.warning("No recurrence pattern provided")
            return None

        pattern = recurrence_pattern.lower().strip()

        try:
            if pattern == "daily":
                return current_date + timedelta(days=1)

            elif pattern == "weekly":
                return current_date + timedelta(weeks=1)

            elif pattern == "biweekly":
                return current_date + timedelta(weeks=2)

            elif pattern == "monthly":
                return current_date + relativedelta(months=1)

            elif pattern == "quarterly":
                return current_date + relativedelta(months=3)

            elif pattern == "yearly":
                return current_date + relativedelta(years=1)

            elif pattern.startswith("every ") and "day" in pattern:
                # Handle custom patterns like "every 10 days"
                import re
                match = re.search(r'every\s+(\d+)\s+days?', pattern)
                if match:
                    days = int(match.group(1))
                    return current_date + timedelta(days=days)
                else:
                    logger.warning(f"Could not parse custom pattern: {pattern}")
                    return None

            else:
                logger.warning(f"Unsupported recurrence pattern: {pattern}")
                return None

        except Exception as e:
            logger.error(f"Error calculating next date for pattern '{pattern}': {e}")
            return None

    @staticmethod
    def is_valid_pattern(recurrence_pattern: str) -> bool:
        """Check if a recurrence pattern is valid.

        Args:
            recurrence_pattern (str): The recurrence pattern to validate.

        Returns:
            bool: True if pattern is valid, False otherwise.
        """
        if not recurrence_pattern:
            return False
        return recurrence_pattern.lower().strip() in RecurrenceService.SUPPORTED_PATTERNS

    @staticmethod
    def get_supported_patterns() -> list[str]:
        """Get list of supported recurrence patterns.

        Returns:
            list[str]: List of supported pattern names.
        """
        return RecurrenceService.SUPPORTED_PATTERNS.copy()
