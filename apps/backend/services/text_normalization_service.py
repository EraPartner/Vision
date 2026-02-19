"""
Text Normalization Service

Centralized service for text processing and normalization.
This is the single Information Expert for text processing rules.
"""
from typing import Optional


class TextNormalizationService:
    """Service for normalizing and processing text data"""

    # Common prefixes and suffixes to remove from recipient names
    RECIPIENT_PREFIXES = [
        "Payment from ",
        "Payment to ",
        "From ",
        "To ",
        "Transfer from ",
        "Transfer to ",
        "Sent to ",
        "Received from ",
    ]

    # KBC-specific prefixes
    KBC_RECIPIENT_PREFIXES = [
        "IBAN: ",
        "Virement: ",
        "Virement automatique: ",
        "Domiciliation: ",
        "Creditrente ",
    ]

    @staticmethod
    def clean_recipient_name(recipient: str) -> str:
        """
        Clean recipient name by removing common prefixes and suffixes
        that don't add value.

        Args:
            recipient: The recipient name to clean

        Returns:
            The cleaned recipient name
        """
        if not recipient:
            return recipient

        cleaned = recipient.strip()

        # Remove prefixes (case-insensitive)
        for prefix in TextNormalizationService.RECIPIENT_PREFIXES:
            if cleaned.lower().startswith(prefix.lower()):
                cleaned = cleaned[len(prefix):].strip()
                break  # Only remove one prefix

        return cleaned

    @staticmethod
    def clean_kbc_recipient_name(recipient: str) -> str:
        """
        Clean KBC recipient names by extracting the main transaction type.

        Examples:
        - "GELDOPNEMING VIA BANCONTACT 26-09..." -> "Geldopneming"
        - "OVERSCHRIJVING NAAR BE12..." -> "Overschrijving"
        - "DOMICILIËRING VAN XYZ..." -> "Domiciliëring"
        - "AANKOOP MET DEBETKAART..." -> "Aankoop"

        Args:
            recipient: The recipient name to clean

        Returns:
            The cleaned recipient name
        """
        if not recipient:
            return recipient

        recipient = recipient.strip()

        # Common KBC transaction type keywords (first word or phrase)
        # These are typically at the start of the description
        kbc_transaction_types = [
            "GELDOPNEMING",
            "OVERSCHRIJVING",
            "DOMICILIËRING",
            "DOMICILIERING",
            "AANKOOP",
            "TERUGBETALING",
            "STORTING",
            "AFHALING",
            "BETALING",
            "RETRO-SEPA",
            "SEPA",
            "EUROPESE",
            "INTERNATIONALE",
            "CREDITRENTE",
        ]

        # Check if it starts with a known transaction type
        upper_recipient = recipient.upper()
        for trans_type in kbc_transaction_types:
            if upper_recipient.startswith(trans_type):
                # Return just the transaction type, properly capitalized
                return trans_type.capitalize()

        # If no match, try to extract the first meaningful word/phrase before common separators
        # Look for patterns like "WORD VIA", "WORD NAAR", "WORD VAN", "WORD MET"
        separators = [" VIA ", " NAAR ", " VAN ", " MET ", " DOOR ", " OP ", " OM "]
        for separator in separators:
            if separator in upper_recipient:
                first_part = recipient.split(separator, 1)[0].strip()
                return first_part.capitalize()

        # If still no match, take only the first word if it's long enough to be meaningful
        first_word = recipient.split()[0] if recipient.split() else recipient
        if len(first_word) > 3:  # Only use if it's a substantial word
            return first_word.capitalize()

        # Fallback: take first 2-3 words if they form a meaningful phrase
        words = recipient.split()[:3]
        if words:
            return " ".join(words).capitalize()

        return recipient

    @staticmethod
    def normalize_whitespace(text: str) -> str:
        """
        Normalize whitespace in text (collapse multiple spaces, strip).

        Args:
            text: The text to normalize

        Returns:
            The normalized text
        """
        if not text:
            return text
        # Replace multiple spaces with single space
        return ' '.join(text.split())

    @staticmethod
    def truncate_with_ellipsis(text: str, max_length: int = 100) -> str:
        """
        Truncate text to max length with ellipsis if needed.

        Args:
            text: The text to truncate
            max_length: Maximum length

        Returns:
            The truncated text
        """
        if not text or len(text) <= max_length:
            return text
        return text[:max_length - 3] + "..."

    @staticmethod
    def extract_currency_code(currency_str: str) -> Optional[str]:
        """
        Extract currency code from currency string.
        Handles formats like "EUR", "0,00 EUR", "0.00 EUR", etc.

        Args:
            currency_str: The currency string

        Returns:
            The currency code (e.g., "EUR") or None if not found
        """
        if not currency_str:
            return None

        # Split on space and take the part that looks like a currency code
        parts = currency_str.split()
        for part in reversed(parts):  # Check from right to left
            if part.isalpha() and len(part) == 3:
                return part.upper()

        # If no space-separated code found, check if entire string is a code
        if currency_str.isalpha() and len(currency_str) == 3:
            return currency_str.upper()

        return None

    @staticmethod
    def format_amount_string(amount_str: str) -> Optional[float]:
        """
        Format amount string to float, handling various formats.
        Supports: "1000.50", "1000,50", "1.000,50", etc.

        Args:
            amount_str: The amount string

        Returns:
            The amount as float, or None if parsing fails
        """
        if not amount_str:
            return None

        try:
            # Remove whitespace
            amount_str = amount_str.strip()

            # Determine if comma or dot is the decimal separator
            # by checking which comes last
            comma_pos = amount_str.rfind(',')
            dot_pos = amount_str.rfind('.')

            if comma_pos > dot_pos:
                # Comma is decimal separator
                amount_str = amount_str.replace('.', '').replace(',', '.')
            else:
                # Dot is decimal separator (or no decimal separator)
                amount_str = amount_str.replace(',', '')

            return float(amount_str)
        except (ValueError, AttributeError):
            return None

    @staticmethod
    def normalize_category_name(name) -> str:
        """
        Normalize category names to uppercase with consistent formatting.

        This is the single source of truth for category name normalization
        across the entire application.

        Args:
            name: The category name to normalize (must be string-like)

        Returns:
            The normalized category name (uppercase, stripped whitespace)

        Raises:
            ValueError: If name is not a string or cannot be converted to string

        Example:
            normalize_category_name("groceries") -> "GROCERIES"
            normalize_category_name("  Food  ") -> "FOOD"
            normalize_category_name("Transport & Travel") -> "TRANSPORT & TRAVEL"
        """
        if not name:
            return name

        # Handle non-string types
        if not isinstance(name, str):
            raise ValueError(f"Category name must be a string, got {type(name).__name__}")

        return name.strip().upper()

    @staticmethod
    def normalize_recipient_name(name) -> str:
        """
        Normalize recipient names to uppercase with consistent formatting.

        This is the single source of truth for recipient name normalization
        across the entire application.

        Args:
            name: The recipient name to normalize (must be string-like)

        Returns:
            The normalized recipient name (uppercase, stripped whitespace)

        Raises:
            ValueError: If name is not a string or cannot be converted to string

        Example:
            normalize_recipient_name("john smith") -> "JOHN SMITH"
            normalize_recipient_name("  ABC Corp  ") -> "ABC CORP"
        """
        if not name:
            return name

        # Handle non-string types
        if not isinstance(name, str):
            raise ValueError(f"Recipient name must be a string, got {type(name).__name__}")

        return name.strip().upper()

    @staticmethod
    def normalize_name_for_matching(name: str) -> str:
        """
        Normalize a name for uniqueness matching by sorting all non-initial tokens.

        This creates a canonical form that:
        - Filters out single-letter tokens (middle initials like "F", "J")
        - Keeps all other tokens including numbers (e.g., "STORE 1" vs "STORE 2")
        - Sorts all remaining tokens alphabetically for consistent ordering
        - Removes punctuation

        Algorithm:
        1. Normalize to uppercase and strip whitespace
        2. Remove punctuation (periods, commas)
        3. Split into tokens (words)
        4. Filter out single-letter tokens that are alphabetic (initials)
        5. Sort remaining tokens alphabetically
        6. Join with a single space

        Examples:
        - "John Smith" → "JOHN SMITH"
        - "Smith John" → "JOHN SMITH" (sorted)
        - "John F Doe" → "DOE JOHN" (F filtered out as initial)
        - "Doe John" → "DOE JOHN"
        - "John Fitzgerald Kennedy" → "FITZGERALD JOHN KENNEDY" (all tokens sorted)
        - "Kennedy John Fitzgerald" → "FITZGERALD JOHN KENNEDY" (same after sort)
        - "John F Kennedy" → "JOHN KENNEDY" (F filtered)
        - "Test Recipient 1" → "1 RECIPIENT TEST" (1 kept, sorted)
        - "Test Recipient 2" → "2 RECIPIENT TEST" (different from 1)

        This ensures:
        - Different orderings of the same person match
        - Different people remain distinct
        - Middle names and initials are handled consistently
        - Numbers and special identifiers are preserved

        Args:
            name: The recipient name to normalize for matching

        Returns:
            The normalized name with all substantial tokens sorted alphabetically (uppercase)

        Note:
            - Single-word names return that word normalized
            - Empty names return empty string
            - Only single-letter alphabetic tokens are filtered (initials)
            - Numbers, symbols, and multi-character tokens are preserved
        """
        if not name:
            return name

        # Normalize to uppercase and strip
        normalized = name.strip().upper()

        # Remove common punctuation (periods, commas)
        normalized = normalized.replace('.', ' ').replace(',', ' ')

        # Split into tokens and filter empty strings
        tokens = [t for t in normalized.split() if t]

        if not tokens:
            return ""

        # Single word name - just return it
        if len(tokens) == 1:
            return tokens[0]

        # Filter out single-LETTER tokens (initials like "F", "J")
        # Keep single-digit tokens as they're meaningful (e.g., "STORE 1" vs "STORE 2")
        # Keep any multi-character tokens
        substantial_tokens = [t for t in tokens if len(t) > 1 or not t.isalpha()]

        # If we have no substantial tokens (all were initials), return the original
        if not substantial_tokens:
            return " ".join(sorted(tokens))

        # Sort all substantial tokens alphabetically for consistent ordering
        sorted_tokens = sorted(substantial_tokens)

        # Join with single space
        return " ".join(sorted_tokens)
